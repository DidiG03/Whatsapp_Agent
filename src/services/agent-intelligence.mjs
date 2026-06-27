/**
 * Lightweight agent intelligence layer: conversation phase, intent inference,
 * decision merging, and reply guardrails — keeps the LLM aligned with server truth.
 */

import {
  fieldsIncludeType,
  resolveBookingFieldValues,
  bookingFieldsReady,
  bookingReplyAsksForAnyField,
  isBookingVocabularyWord,
} from "./bookingFields.mjs";

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Customer asks whether reservations/slots exist — not a request to list times. */
export function isAvailabilityInquiry(text) {
  const sq = stripAccentsLower(String(text || ""));
  if (!sq) return false;
  return /\b(rezervime\s+te\s+lira|keni\s+rezervime|nese\s+keni\s+rezerv|a\s+keni\s+rezerv|disponuesh(?:meri|em)?)\b/.test(sq)
    || (/\b(rezerv|book(?:ing)?)\w*/.test(sq) && /\b(lir[ae]|available|vende|free|openings?|tables?)\b/.test(sq))
    || /\b(have\s+(?:any\s+)?(?:reservations?|openings?|tables?)|any\s+(?:tables?|openings?)\s+(?:for|tomorrow|tonight))\b/.test(sq);
}

/** Customer explicitly wants open times listed (slot suggestions). */
export function wantsTimeSlotSuggestions(text) {
  const sq = stripAccentsLower(String(text || ""));
  if (!sq) return false;
  return /\b(cilat\s+orare|cfare\s+orare|what\s+times|which\s+times|show\s+(?:me\s+)?(?:the\s+)?(?:available|open)\s+(?:times|slots)|show\s+(?:me\s+)?(?:times|slots)|shiko\s+oraret|listo\s+oraret|list\s+(?:the\s+)?(?:times|slots)|when\s+are\s+you\s+free|check\s+availability|slots?\s+available|free\s+(?:times|slots))\b/.test(sq)
    || /\b(keni\s+orare|what\s+(?:times|slots)\s+(?:do\s+you\s+have|are\s+available))\b/.test(sq);
}

/** @deprecated alias — only true when the customer wants times listed, not for soft availability asks. */
export function isExplicitAvailabilityRequest(text) {
  return wantsTimeSlotSuggestions(text);
}

export function bookingReplyAsksForName(text) {
  const raw = String(text || "");
  const sq = stripAccentsLower(raw);
  return /\b(emri|emrin|emër|emer|quheni|si quheni|me cilin emer|me cilin emër|what name|what(?:'|')?s your name|under what name|name should i|put on the reservation|ta vendos rezervimin)\b/.test(sq);
}

export function looksLikeStandaloneCustomerName(raw) {
  const s = String(raw || "").trim();
  if (!/^[A-Za-zËÇëç][A-Za-zËÇëç'\-]+(?:\s+[A-Za-zËÇëç][A-Za-zËÇëç'\-]+){0,2}$/.test(s)) {
    return false;
  }
  return !isBookingVocabularyWord(s);
}

export function isBookingNameCompletion(text, historyMessages = []) {
  const raw = String(text || "").trim();
  if (!looksLikeStandaloneCustomerName(raw)) return false;
  return (historyMessages || []).some(
    (m) => m?.role === "assistant" && bookingReplyAsksForName(String(m.content || ""))
  );
}

function historyHasBookingDateTime(historyMessages = []) {
  return (historyMessages || []).some((m) => {
    if (m?.role !== "user") return false;
    const h = stripAccentsLower(String(m.content || ""));
    return /\b(?:data|neser|nesër|sot|tomorrow|today|\d{1,2}[\/\-.]\d{1,2})\b/.test(h)
      && /\b(?:ora|oren|at\s+\d|\d{1,2}\s*(?:am|pm|:)|dark|pasdite|evening|mbremje)\b/.test(h);
  });
}

function parsePartySizeFromHistory(historyMessages = []) {
  for (const m of [...(historyMessages || [])].reverse()) {
    if (m?.role !== "user") continue;
    const match = /\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.exec(stripAccentsLower(String(m.content || "")));
    if (match) {
      const n = Number(match[1]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

function resolveNameFromHistory(historyMessages = []) {
  for (let i = 0; i < (historyMessages || []).length; i++) {
    const m = historyMessages[i];
    if (m?.role !== "user") continue;
    const c = String(m.content || "").trim();
    if (isBookingNameCompletion(c, historyMessages.slice(0, i))) return c;
  }
  return null;
}

export function bookingHasPartySize(text, intentData = {}, historyMessages = []) {
  const sq = stripAccentsLower(String(text || ""));
  if (/\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.test(sq)) return true;
  const n = Number(intentData?.partySize || intentData?.guests || 0);
  if (n >= 1 && n <= 100) return true;
  return parsePartySizeFromHistory(historyMessages) != null;
}

/** Current message carries a booking word, a date/time, or a party size. */
function currentMessageHasBookingCue(text) {
  const sq = stripAccentsLower(String(text || ""));
  if (!sq) return false;
  if (/\b(rezerv|book|booking|termin|takim)\w*/.test(sq)) return true;
  if (/\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.test(sq)) return true;
  return /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|ora\s+\d|oren\s+\d|at\s+\d|neser|nesër|tomorrow|today|sot|pasdite|evening|dark|mbremje|data\s+\d{1,2}|\d{1,2}[\/\-.]\d{1,2})\b/.test(sq);
}

/**
 * True only when the assistant's MOST RECENT turn was actively asking the customer for a
 * booking detail (name, party size, a specific time/date). We look at the latest assistant
 * message — not anywhere in history — so stale booking chatter from earlier in the thread
 * cannot make an unrelated reply look like a booking continuation.
 */
function lastAssistantIsCollectingBooking(historyMessages = []) {
  const lastAssistant = [...(historyMessages || [])]
    .reverse()
    .find((m) => m?.role === "assistant" && String(m?.content || "").trim());
  if (!lastAssistant) return false;
  const content = String(lastAssistant.content || "");
  if (bookingReplyAsksForName(content)) return true;
  const a = stripAccentsLower(content);
  return /\b(sa persona|how many people|how many|what time|exact time|preferred time|n[ëe] cfar[ëe] ore|n[ëe] cilar ore|cila ore|what date|which date|cfar[ëe] date)\b/.test(a);
}

/**
 * True only when the conversation actually involves a booking *right now* — a date/time
 * was provided for this turn, the current message itself carries a booking cue, or the
 * customer is directly answering the assistant's most recent booking question.
 *
 * Deliberately does NOT treat stale booking date/time still sitting in the loaded history
 * window as sufficient: otherwise an unrelated message (e.g. a plain greeting) from a
 * customer with prior booking chatter — and whose name is saved in memory — would be
 * force-booked and fail with a nonsensical "that slot was just taken" reply.
 */
export function hasActiveBookingContext({ text = "", intentData = {}, historyMessages = [] } = {}) {
  if (intentData && String(intentData.datetime || intentData.range || "").trim()) return true;
  if (currentMessageHasBookingCue(text)) return true;
  return lastAssistantIsCollectingBooking(historyMessages);
}

export function detectConversationPhase({ text, bookingSession, hasUpcomingAppt, lang = "en", historyMessages = [] } = {}) {
  const step = String(bookingSession?.step || "");
  if (step === "awaiting_cancel_confirm") return "cancel_pending";
  if (step === "awaiting_reschedule_dt") return "reschedule_pending";

  const sq = stripAccentsLower(text);
  if (/\b(anul|cancel|kancel)\w*/.test(sq) && hasUpcomingAppt) return "cancel_request";
  if (/\b(ndrysh|ndrro|zhvendos|reschedule|change\s+(the\s+)?(time|appointment|date))\b/.test(sq) && hasUpcomingAppt && !isBookingNameChangeRequest(text)) {
    return "reschedule_request";
  }
  if (wantsTimeSlotSuggestions(text)) {
    return "availability_check";
  }
  if (isAvailabilityInquiry(text)) {
    return "booking_flow";
  }
  if (/\b(rezerv|book|booking|termin|takim)\w*/.test(sq)) return "booking_flow";
  if (hasUpcomingAppt && isBookingNameChangeRequest(text)) return "name_change_request";
  if (hasUpcomingAppt && /\b(rezervimi\s+im|my\s+(booking|reservation)|cfare\s+ore|what\s+time\s+is\s+my|kur\s+eshte|nenshkruar|nënshkruar|under\s+what\s+name|saved\s+under)\b/.test(sq)) {
    return "booking_lookup";
  }
  if (/\b(njeri|human|agent|operator|staf)\b/.test(sq)) return "handoff_request";
  if (isOngoingBookingCollection(text, historyMessages)) return "booking_flow";
  return "general";
}

function isOngoingBookingCollection(text, historyMessages = []) {
  const raw = String(text || "").trim();
  const sq = stripAccentsLower(raw);
  if (!raw) return false;
  if (/\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.test(sq)) return true;
  if (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(raw)) return true;
  if (looksLikeStandaloneCustomerName(raw)) {
    return (historyMessages || []).some(
      (m) => m?.role === "assistant" && bookingReplyAsksForName(String(m.content || ""))
    );
  }
  const recentAssistant = (historyMessages || []).slice(-8).filter((m) => m?.role === "assistant");
  const assistantCollectingBooking = recentAssistant.some((m) => {
    const a = stripAccentsLower(String(m.content || ""));
    return /\b(sa persona|how many people|what time|exact time|n[ëe] cfar[ëe] ore|n[ëe] cilar ore|emri|what name|name should|rezervimin|preferred time)\b/.test(a);
  });
  if (!assistantCollectingBooking) return false;
  return /\b(darke|dark|evening|neser|nesër|tomorrow|ora|persona|\d{1,2})\b/.test(sq);
}

function titleCaseName(raw) {
  return String(raw || "")
    .replace(/\?+$/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

/** Customer wants to rename an existing upcoming booking. */
export function isBookingNameChangeRequest(text) {
  const sq = stripAccentsLower(String(text || ""));
  if (!sq) return false;
  if (/\b(cancel|anul|resched|ndrysho\s+or|change\s+the\s+time|change\s+the\s+date)\b/.test(sq) && !/\b(emrin|emri|name)\b/.test(sq)) {
    return false;
  }
  return (
    /\b(ndrysh(?:o|oni)?|change|update|rename)\b.*\b(emrin|emri|name)\b/.test(sq)
    || /\b(emrin|emri)\b.*\b(ndrysh|change|update|nga|from)\b/.test(sq)
    || /\bchange\s+the\s+name\b/.test(sq)
    || /\bndrysho\s+emrin\b/.test(sq)
    || /\ba\s+mund\s+(?:ta|te)\s+ndrysh/.test(sq) && /\bemrin\b/.test(sq)
  );
}

export function parseBookingNameChange(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  let match = /\b(?:nga|from)\s+(.+?)\s+(?:ne|në|to)\s+(.+?)(?:[?.!]|$)/i.exec(raw);
  if (match) {
    return {
      oldName: titleCaseName(match[1]),
      newName: titleCaseName(match[2]),
    };
  }

  match = /\b(?:ndrysh(?:o|oni)?(?:\s+emrin)?|change(?:\s+the)?\s+name|update(?:\s+the)?\s+name|rename)\s+(?:to|ne|në|as|in)?\s*(.+?)(?:[?.!]|$)/i.exec(raw);
  if (match) {
    return { newName: titleCaseName(match[1]) };
  }

  match = /\bemrin\b.*?\b(?:ne|në|to)\s+(.+?)(?:[?.!]|$)/i.exec(raw);
  if (match) {
    return { newName: titleCaseName(match[1]) };
  }

  return null;
}

export function isCancelAbort(text) {
  const sq = stripAccentsLower(String(text || ""));
  return /\b(no|jo|mbaje|keep|don?t|dont|mos\s+anulo|ruaje|mbaj)\b/.test(sq);
}

export function isCancelConfirmation(text) {
  const raw = String(text || "").trim();
  if (!raw || isCancelAbort(raw)) return false;
  const sq = stripAccentsLower(raw);
  if (/\b(konfirmo|confirm|yes)\b/.test(sq)) return true;
  if (/\bpo\b/.test(sq) && /\banul\w*/.test(sq)) return true;
  if (/\bpo\s+te\s+lutem\b/.test(sq) && /\banul/.test(sq)) return true;
  if (/\?/.test(raw)) return false;
  if (/\b(a\s+mund|mund\s+ta|can\s+i|could\s+i|may\s+i)\b/.test(sq)) return false;
  if (/^(anul(o|oj|oje|ojme)|cancel)\b/.test(sq)) return true;
  if (/\bcancel\b/.test(sq) && !/\b(don?t|dont|do not)\s+cancel\b/.test(sq)) {
    if (/\b(yes|please|po)\b/.test(sq)) return true;
  }
  return false;
}

export function inferServerIntent({
  text,
  phase,
  bookingsEnabled = false,
  historyMessages = [],
  upcomingAppt = null,
  bookingFields = [],
  knownCustomerName = "",
  contactId = "",
} = {}) {
  if (!bookingsEnabled || !text) return null;
  const sq = stripAccentsLower(text);
  const raw = String(text || "").trim();

  if (phase === "cancel_pending" || phase === "cancel_request") {
    if (isCancelConfirmation(raw)) {
      return { type: "cancel", data: {}, confidence: 0.95, source: "rules" };
    }
    if (!/\?/.test(raw) && /\b(anul|cancel|kancel)\w*/.test(sq)) {
      return { type: "cancel", data: {}, confidence: 0.9, source: "rules" };
    }
  }

  if (phase === "reschedule_pending" || phase === "reschedule_request") {
    if (/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|ora\s+\d|oren\s+\d|at\s+\d|neser|tomorrow|\d{1,2}:\d{2})\b/.test(sq) || /\bndrysh|\bndrro|\breschedule|\bchange\b/.test(sq)) {
      return { type: "reschedule", data: { datetime: raw }, confidence: 0.88, source: "rules" };
    }
  }

  if (/\b(anul|cancel|kancel)\w*/.test(sq) && upcomingAppt && /\?/.test(raw)) {
    return { type: "cancel", data: {}, confidence: 0.85, source: "rules" };
  }

  if (/\b(ndrysh|ndrro|zhvendos|reschedule)\w*/.test(sq) && upcomingAppt && !isBookingNameChangeRequest(text)) {
    return { type: "reschedule", data: { datetime: raw }, confidence: 0.85, source: "rules" };
  }

  if (wantsTimeSlotSuggestions(raw)) {
    return { type: "availability", data: { datetime: raw }, confidence: 0.85, source: "rules" };
  }

  const partyM = /\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.exec(sq);
  const hasTimeCue = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|ora\s+\d|oren\s+\d|at\s+\d|neser|tomorrow|today|sot|pasdite|evening|dark|data\s+\d{1,2})\b/.test(sq);

  if (/\b(rezerv|book|booking|termin)\w*/.test(sq) && hasTimeCue && !isAvailabilityInquiry(raw)) {
    const data = { datetime: raw };
    if (partyM) data.partySize = Number(partyM[1]);
    return { type: "book", data, confidence: 0.82, source: "rules" };
  }

  if (partyM && (phase === "booking_flow" || phase === "general")) {
    const histHasSlot = (historyMessages || []).some((m) => {
      if (m?.role !== "user") return false;
      const h = stripAccentsLower(String(m.content || ""));
      return /\b(?:data|neser|sot|tomorrow|today|\d{1,2}[\/\-.]\d{1,2})\b/.test(h)
        && /\b(?:ora|oren|at\s+\d|\d{1,2}\s*(?:am|pm|:)|dark|pasdite|evening|mbremje)\b/.test(h);
    });
    if (histHasSlot) {
      const data = { datetime: raw, partySize: Number(partyM[1]) };
      const name = resolveNameFromHistory(historyMessages);
      if (name) data.name = name;
      return {
        type: "book",
        data,
        confidence: 0.92,
        source: "rules",
      };
    }
  }

  if (upcomingAppt && isBookingNameChangeRequest(text)) {
    const change = parseBookingNameChange(text);
    if (change?.newName) {
      return {
        type: "update_name",
        data: { name: change.newName, oldName: change.oldName || null },
        confidence: 0.92,
        source: "rules",
      };
    }
  }

  const needsPartySize = fieldsIncludeType(bookingFields, "party_size");

  if ((phase === "booking_flow" || phase === "general") && hasTimeCue && !looksLikeStandaloneCustomerName(raw)) {
    const partySize = needsPartySize ? parsePartySizeFromHistory(historyMessages) : true;
    const name = resolveNameFromHistory(historyMessages)
      || (isUsableCustomerName(knownCustomerName, contactId) ? String(knownCustomerName).trim() : null);
    if (partySize && name) {
      const data = { datetime: raw, name };
      if (needsPartySize && typeof partySize === "number") data.partySize = partySize;
      return { type: "book", data, confidence: 0.9, source: "rules" };
    }
  }

  if (looksLikeStandaloneCustomerName(raw) && (phase === "booking_flow" || phase === "general")) {
    const askedForName = (historyMessages || []).some(
      (m) => m?.role === "assistant" && bookingReplyAsksForName(String(m.content || ""))
    );
    const partySize = needsPartySize ? parsePartySizeFromHistory(historyMessages) : true;
    if ((askedForName || historyHasBookingDateTime(historyMessages)) && partySize) {
      const data = { name: raw.trim() };
      if (needsPartySize && typeof partySize === "number") data.partySize = partySize;
      return { type: "book", data, confidence: 0.92, source: "rules" };
    }
  }

  if ((phase === "booking_flow" || phase === "general") && historyHasBookingDateTime(historyMessages)) {
    const partySize = needsPartySize ? parsePartySizeFromHistory(historyMessages) : true;
    const name = resolveNameFromHistory(historyMessages);
    const timePick = /\b(\d{1,2})(?::\d{2})?\b/.test(sq)
      && /\b(okej|ok|po|pra|ne|at|ora|oren|fiks|fix)\b/.test(sq);
    if (partySize && name && timePick) {
      const data = { datetime: raw, name };
      if (needsPartySize && typeof partySize === "number") data.partySize = partySize;
      return {
        type: "book",
        data,
        confidence: 0.88,
        source: "rules",
      };
    }
  }

  if (/\b(njeri\s+real|human|talk\s+to\s+(someone|a\s+person)|operator|agjent)\b/.test(sq)) {
    return { type: "handoff", data: {}, confidence: 0.75, source: "rules" };
  }

  return null;
}

export function buildLiveSessionBrief({
  phase,
  bookingSession,
  profileSnippet,
  upcomingAppt,
  mem = {},
  lang = "en",
} = {}) {
  const lines = ["LIVE SESSION CONTEXT (authoritative — prefer this over guessing):"];

  if (profileSnippet?.content) {
    lines.push(profileSnippet.content);
  } else   if (mem.display_name) {
    lines.push(`Name: ${mem.display_name}`);
  }

  if (upcomingAppt?.start_ts) {
    const when = new Date(upcomingAppt.start_ts * 1000).toLocaleString(
      lang === "sq" ? "sq-AL" : undefined,
      { dateStyle: "medium", timeStyle: "short" }
    );
    const ref = upcomingAppt.id ? `Ref #${upcomingAppt.id}` : "";
    lines.push(`Confirmed upcoming booking: ${when}${ref ? ` (${ref})` : ""}.`);
  } else {
    lines.push("No confirmed upcoming booking on file for this number.");
  }

  const step = String(bookingSession?.step || "");
  if (step === "awaiting_cancel_confirm") {
    const ref = bookingSession.appt_id ? `Ref #${bookingSession.appt_id}` : "";
    lines.push(
      lang === "sq"
        ? `Server state: duke pritur konfirmim anulimi ${ref}. Mos thuaj se u anulua — pyet për "konfirmo" ose "po anuloje".`
        : `Server state: awaiting cancel confirmation ${ref}. Do NOT say it is canceled — ask for explicit confirm.`
    );
  } else if (step === "awaiting_reschedule_dt") {
    lines.push(
      lang === "sq"
        ? "Server state: duke pritur orën e re për ndryshim. Mos thuaj se u ndryshua — mblidh orarin."
        : "Server state: awaiting new time for reschedule. Do NOT say it is moved yet."
    );
  }

  const phaseHints = {
    cancel_pending: lang === "sq" ? "Faza: konfirmim anulimi." : "Phase: cancel confirmation.",
    cancel_request: lang === "sq" ? "Faza: klienti do ta anulojë." : "Phase: customer wants to cancel.",
    reschedule_request: lang === "sq" ? "Faza: ndryshim ore." : "Phase: reschedule request.",
    booking_lookup: lang === "sq" ? "Faza: pyet për rezervimin ekzistues — përgjigju nga konteksti." : "Phase: ask about existing booking — answer from context.",
    name_change_request: lang === "sq" ? "Faza: ndryshim emri rezervimi — serveri e përditëson; mos e dërgo te ekipi." : "Phase: booking name change — server updates it; do not escalate.",
    booking_flow: lang === "sq"
      ? "Faza: rezervim i ri. Mos përsërit adresën. Mos konfirmo rezervimin pa emër klienti — pyet për emrin fillimisht."
      : "Phase: new booking. Do not repeat the address. Do not confirm the booking without the customer's name — ask for their name first.",
    availability_check: lang === "sq" ? "Faza: disponueshmëri." : "Phase: availability.",
  };
  if (phaseHints[phase]) lines.push(phaseHints[phase]);
  if (phase === "booking_flow" && mem.display_name) {
    lines.push(
      lang === "sq"
        ? `Emri në dosje: ${mem.display_name} — mos e pyet përsëri për emrin nëse nuk kërkon ta ndryshojë.`
        : `Name on file: ${mem.display_name} — do not ask for their name again unless they want to change it.`
    );
  }

  return lines.join("\n");
}

const WEAK_INTENTS = new Set(["none", "", null, undefined]);
const ACTION_INTENTS = new Set(["book", "availability", "cancel", "reschedule", "update_name", "handoff"]);

export function isUsableCustomerName(name, contactId = "") {
  const n = String(name || "").trim();
  if (!n || n.length < 2) return false;
  const digitsOnly = n.replace(/\D/g, "");
  const contactDigits = String(contactId || "").replace(/\D/g, "");
  if (contactDigits && digitsOnly === contactDigits) return false;
  if (/^\+?\d{7,15}$/.test(n.replace(/\s/g, ""))) return false;
  return true;
}

function replyCollectsMissingInfo(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (bookingReplyAsksForName(raw)) return true;
  if (!/\?/.test(raw)) return false;
  const sq = stripAccentsLower(raw);
  return /\b(sa persona|how many|what time|exact time|which time|n[ëe] cfar[ëe] ore|n[ëe] cilar ore|cila ore|preferred time|what date|which date|what name|emri|emrin)\b/.test(sq);
}

function shouldApplyInferredIntent(inferred, aiDecision, options = {}) {
  if (!inferred?.type || inferred.confidence < 0.75) return false;

  if (options.completingBookingWithName && inferred.type === "book") return true;

  const aiText = String(aiDecision?.text || options.aiText || "");
  const aiType = String(aiDecision?.intent?.type || "none").toLowerCase();

  if (replyCollectsMissingInfo(aiText)) {
    if (options.completingBookingWithName && inferred.type === "book") return true;
    if (["book", "availability"].includes(inferred.type)) return false;
  }

  if (inferred.type === "book" && isAvailabilityInquiry(options.userText || "")) return false;

  if (inferred.type === "availability" && !wantsTimeSlotSuggestions(options.userText || "")) return false;

  if (ACTION_INTENTS.has(inferred.type) && aiType !== "none" && aiType !== inferred.type) {
    if (!["cancel", "reschedule", "update_name", "handoff"].includes(inferred.type)) return false;
    if (inferred.confidence < 0.9) return false;
  }

  return true;
}

export function mergeAgentDecision(aiDecision, inferred, options = {}) {
  if (!aiDecision || typeof aiDecision !== "object") return aiDecision;
  if (!shouldApplyInferredIntent(inferred, aiDecision, options)) {
    return sanitizeBookIntentDecision(aiDecision, options);
  }

  const aiType = String(aiDecision.intent?.type || "none").toLowerCase();
  const merged = { ...aiDecision, intent: { ...(aiDecision.intent || {}) } };

  if (WEAK_INTENTS.has(aiType) || aiType === "none") {
    merged.intent = { type: inferred.type, data: inferred.data || {} };
    return sanitizeBookIntentDecision(merged, options);
  }

  if (aiType === inferred.type) {
    merged.intent.data = { ...(inferred.data || {}), ...(aiDecision.intent?.data || {}) };
    return sanitizeBookIntentDecision(merged, options);
  }

  if (inferred.confidence >= 0.85 && inferred.type === "update_name") {
    merged.intent = { type: "update_name", data: { ...(aiDecision.intent?.data || {}), ...(inferred.data || {}) } };
    return sanitizeBookIntentDecision(merged, options);
  }

  if (inferred.confidence >= 0.9 && ["cancel", "reschedule", "handoff"].includes(inferred.type)) {
    merged.intent = { type: inferred.type, data: { ...(aiDecision.intent?.data || {}), ...(inferred.data || {}) } };
  }

  return sanitizeBookIntentDecision(merged, options);
}

function resolveBookIntentName({ text, intentData = {}, historyMessages = [], knownCustomerName = "", contactId = "" } = {}) {
  let name = String(intentData?.name || intentData?.customerName || "").trim();
  if (!name && looksLikeStandaloneCustomerName(String(text || "").trim())) {
    name = String(text || "").trim();
  }
  if (!name && isUsableCustomerName(knownCustomerName, contactId)) {
    name = String(knownCustomerName).trim();
  }
  if (!name) {
    for (const m of [...(historyMessages || [])].reverse()) {
      if (m?.role !== "user") continue;
      const c = String(m.content || "").trim();
      if (looksLikeStandaloneCustomerName(c)) {
        name = c;
        break;
      }
    }
  }
  return name;
}

export function bookIntentReady({
  text,
  intentData = {},
  historyMessages = [],
  knownCustomerName = "",
  contactId = "",
  bookingFields = [],
  isUsableCustomerName: isUsableCustomerNameFn = isUsableCustomerName,
} = {}) {
  const fields = Array.isArray(bookingFields) && bookingFields.length
    ? bookingFields
    : [
      { id: "name", type: "name", required: true },
      { id: "party_size", type: "party_size", required: true },
    ];
  const values = resolveBookingFieldValues({
    fields,
    text,
    historyMessages,
    intentData,
    knownCustomerName,
    contactId,
    isUsableCustomerName: isUsableCustomerNameFn,
  });
  if (isBookingNameCompletion(text, historyMessages) && fieldsIncludeType(fields, "party_size")) {
    if (!bookingHasPartySize(text, intentData, historyMessages)) return false;
  }
  // A booking is never "ready" without genuine booking context — otherwise a plain
  // greeting from a known customer (name already on file) would be force-booked and
  // fail with a nonsensical "that slot was just taken" reply.
  if (!hasActiveBookingContext({ text, intentData, historyMessages })) return false;
  return bookingFieldsReady(values, fields).ready;
}

function sanitizeBookIntentDecision(decision, options = {}) {
  if (!decision || String(decision.intent?.type || "").toLowerCase() !== "book") return decision;
  if (options.completingBookingWithName) return decision;
  const fields = options.bookingFields || [];
  if (bookIntentReady({
    text: options.userText || "",
    intentData: decision.intent?.data,
    historyMessages: options.historyMessages || [],
    knownCustomerName: options.knownCustomerName || "",
    contactId: options.contactId || "",
    bookingFields: fields,
    isUsableCustomerName: options.isUsableCustomerName,
  })) {
    return decision;
  }
  if (bookingReplyAsksForAnyField(String(decision.text || options.aiText || ""), fields)
    || bookingReplyAsksForName(String(decision.text || options.aiText || ""))) {
    return { ...decision, intent: { type: "none", data: {} } };
  }
  return { ...decision, intent: { type: "none", data: {} } };
}

export function normalizeExecutedIntent({
  intentType,
  intentData,
  text,
  replyText,
  historyMessages = [],
  knownCustomerName = "",
  contactId = "",
  bookingFields = [],
}) {
  let type = String(intentType || "none").toLowerCase();
  const data = intentData && typeof intentData === "object" ? { ...intentData } : {};
  if (type === "availability" && !wantsTimeSlotSuggestions(text)) type = "none";
  if (type === "book" && !bookIntentReady({
    text,
    intentData: data,
    historyMessages,
    knownCustomerName,
    contactId,
    bookingFields,
  })) {
    type = "none";
  }
  return { intentType: type, intentData: data };
}

/** Strip redundant booking questions from the AI reply when the server is about to book. */
export function sanitizeReplyWhenBookingReady(text, { lang = "en", bookingFields = [] } = {}) {
  let s = String(text || "").trim();
  if (!s) return s;
  if (!bookingReplyAsksForName(s) && !bookingReplyAsksForAnyField(s, bookingFields)) return s;

  const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((sentence) => {
    if (!/\?/.test(sentence)) return true;
    if (bookingReplyAsksForName(sentence)) return false;
    if (bookingReplyAsksForAnyField(sentence, bookingFields)) return false;
    return true;
  });
  s = kept.join(" ").trim();
  if (!s || s.length < 4) {
    return lang === "sq" ? "Perfekt, faleminderit!" : "Perfect, thank you!";
  }
  return s;
}

export function guardPrematureActionClaims(text, { phase, lang = "en" } = {}) {
  let s = String(text || "").trim();
  if (!s) return s;

  const processing = lang === "sq"
    ? [
        /\bpo e (d[ëe]rgoj|p[ëe]rgatis|p[ëe]rpunoj|anuloj|ndryshoj|regjistroj)\b/gi,
        /\bprit (?:nj[ëe]|nje) (?:çast|moment)\b/gi,
      ]
    : [
        /\b(i'?m|i am) (sending|processing|submitting|canceling|cancelling|updating)\b/gi,
        /\bwait (?:a )?(?:moment|second)\b/gi,
        /\bhold on\b/gi,
      ];

  for (const re of processing) {
    if (re.test(s)) {
      s = s.replace(re, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  if (s.length < 12 || s.split(/\s+/).filter(Boolean).length < 2) {
    if (phase === "cancel_pending" || phase === "cancel_request") {
      return lang === "sq" ? "Në rregull." : "Got it.";
    }
    if (phase === "reschedule_pending" || phase === "reschedule_request") {
      return lang === "sq" ? "Në rregull." : "Got it.";
    }
  }

  const falseComplete = lang === "sq"
    ? /\b(rezervimi\s+u\s+krye|gjith[cç]ka u krye|u krye|u anulua|u konfirmua|u rezervua|u ndryshua|u zhvendos|e\s+shenova|e\s+shënova|kam\s+rezervuar|eshte\s+rezervuar|është\s+rezervuar|t[eë] kam\s+rezervuar)\b/i
    : /\b((?:booking|appointment|reservation).*(?:has been|is|was) (?:canceled|cancelled|confirmed|booked|moved|updated|reserved)|you(?:'re| are) all set|everything is (?:done|set|confirmed))\b/i;

  const guardedPhases = [
    "cancel_pending", "reschedule_pending", "cancel_request", "reschedule_request",
    "booking_flow", "availability_check", "name_change_request", "general",
  ];

  if (falseComplete.test(s) && guardedPhases.includes(phase)) {
    s = s.replace(falseComplete, "").replace(/\s{2,}/g, " ").trim();
  }

  s = s.replace(/^[.,!\s-]+|[.,!\s-]+$/g, "").trim();
  return s || text;
}

export function extractMemoryFacts(text) {
  const sq = stripAccentsLower(text);
  const out = {};
  const partyM = /\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.exec(sq);
  if (partyM) {
    const n = Number(partyM[1]);
    if (n >= 1 && n <= 100) out.partySize = n;
  }
  const nameM = /\b(?:emri\s+im\s+(?:eshte|është)|quhem|jam|my\s+name\s+is|i\s*am|i'm)\s+([a-zëç][a-zëç'\-]+(?:\s+[a-zëç][a-zëç'\-]+){0,2})/i.exec(String(text || ""));
  if (nameM) out.name = nameM[1].trim();
  return out;
}
