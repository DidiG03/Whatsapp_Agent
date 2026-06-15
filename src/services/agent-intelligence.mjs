/**
 * Lightweight agent intelligence layer: conversation phase, intent inference,
 * decision merging, and reply guardrails — keeps the LLM aligned with server truth.
 */

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** True when the customer explicitly wants to see open times, not merely make a reservation. */
export function isExplicitAvailabilityRequest(text) {
  const sq = stripAccentsLower(String(text || ""));
  if (!sq) return false;
  return /\b(disponuesh|availability|orare\s+(?:e\s+)?lira|lira\s+(?:jane|ka|keni)|free\s+(?:times|slots)|what\s+times|which\s+times|cilat\s+orare|cfare\s+orare|a\s+keni\s+vende|keni\s+orare|show\s+(?:me\s+)?(?:available|open)|slots?\s+available|when\s+are\s+you\s+free|check\s+availability|shiko\s+oraret|listo\s+oraret)\b/.test(sq);
}

export function detectConversationPhase({ text, bookingSession, hasUpcomingAppt, lang = "en" } = {}) {
  const step = String(bookingSession?.step || "");
  if (step === "awaiting_cancel_confirm") return "cancel_pending";
  if (step === "awaiting_reschedule_dt") return "reschedule_pending";

  const sq = stripAccentsLower(text);
  if (/\b(anul|cancel|kancel)\w*/.test(sq) && hasUpcomingAppt) return "cancel_request";
  if (/\b(ndrysh|ndrro|zhvendos|reschedule|change\s+(the\s+)?(time|appointment|date))\b/.test(sq) && hasUpcomingAppt && !isBookingNameChangeRequest(text)) {
    return "reschedule_request";
  }
  if (/\b(rezerv|book|booking|termin|takim)\w*/.test(sq)) return "booking_flow";
  if (isExplicitAvailabilityRequest(text)) {
    return "availability_check";
  }
  if (hasUpcomingAppt && isBookingNameChangeRequest(text)) return "name_change_request";
  if (hasUpcomingAppt && /\b(rezervimi\s+im|my\s+(booking|reservation)|cfare\s+ore|what\s+time\s+is\s+my|kur\s+eshte|nenshkruar|nënshkruar|under\s+what\s+name|saved\s+under)\b/.test(sq)) {
    return "booking_lookup";
  }
  if (/\b(njeri|human|agent|operator|staf)\b/.test(sq)) return "handoff_request";
  return "general";
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

  if (isExplicitAvailabilityRequest(raw)) {
    return { type: "availability", data: { datetime: raw }, confidence: 0.8, source: "rules" };
  }

  const partyM = /\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.exec(sq);
  const hasTimeCue = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|ora\s+\d|oren\s+\d|at\s+\d|neser|tomorrow|today|pasdite|evening|dark|data\s+\d{1,2})\b/.test(sq);
  if (/\b(rezerv|book|booking|termin)\w*/.test(sq) && hasTimeCue) {
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
      return {
        type: "book",
        data: { datetime: raw, partySize: Number(partyM[1]) },
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
    booking_flow: lang === "sq" ? "Faza: rezervim i ri." : "Phase: new booking.",
    availability_check: lang === "sq" ? "Faza: disponueshmëri." : "Phase: availability.",
  };
  if (phaseHints[phase]) lines.push(phaseHints[phase]);

  return lines.join("\n");
}

const WEAK_INTENTS = new Set(["none", "", null, undefined]);

export function mergeAgentDecision(aiDecision, inferred) {
  if (!aiDecision || typeof aiDecision !== "object") return aiDecision;
  if (!inferred?.type || inferred.confidence < 0.75) return aiDecision;

  const aiType = String(aiDecision.intent?.type || "none").toLowerCase();
  const merged = { ...aiDecision, intent: { ...(aiDecision.intent || {}) } };

  if (WEAK_INTENTS.has(aiType) || aiType === "none") {
    merged.intent = { type: inferred.type, data: inferred.data || {} };
    return merged;
  }

  if (aiType === inferred.type) {
    merged.intent.data = { ...(inferred.data || {}), ...(aiDecision.intent?.data || {}) };
    return merged;
  }

  if (inferred.confidence >= 0.85 && inferred.type === "update_name") {
    merged.intent = { type: "update_name", data: { ...(aiDecision.intent?.data || {}), ...(inferred.data || {}) } };
    return merged;
  }

  if (inferred.confidence >= 0.9 && ["cancel", "reschedule", "handoff"].includes(inferred.type)) {
    merged.intent = { type: inferred.type, data: { ...(aiDecision.intent?.data || {}), ...(inferred.data || {}) } };
  }

  return merged;
}

export function guardPrematureActionClaims(text, { phase, lang = "en" } = {}) {
  let s = String(text || "").trim();
  if (!s) return s;

  const processing = lang === "sq"
    ? [
        /\bpo e (d[ëe]rgoj|p[ëe]rgatis|p[ëe]rpunoj|anuloj|ndryshoj)\b/gi,
        /\bprit (?:nj[ëe]|nje) (?:çast|moment)\b/gi,
        /\bpo e d[ëe]rgoj\b/gi,
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
    ? /\b(rezervimi|termini|rezervim).*(?:u anulua|u konfirmua|u rezervua|u ndryshua|u zhvendos|e\s+shenova|e\s+shënova|kam\s+rezervuar|eshte\s+rezervuar|është\s+rezervuar)\b/i
    : /\b(booking|appointment|reservation).*(?:has been|is) (?:canceled|cancelled|confirmed|booked|moved|updated|reserved)\b/i;

  if (falseComplete.test(s) && ["cancel_pending", "reschedule_pending", "cancel_request", "reschedule_request", "booking_flow", "general"].includes(phase)) {
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
