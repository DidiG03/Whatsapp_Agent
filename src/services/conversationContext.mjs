/**
 * Builds rolling conversation context from thread history so the AI stays
 * oriented when customers change topics mid-chat.
 */

import { detectMessageTopics } from "./messageTopics.mjs";
import { isLikelyFaqQuestion } from "./i18n.mjs";

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const PHASE_LABELS = {
  en: {
    booking_flow: "booking",
    cancel_pending: "cancel confirmation",
    cancel_request: "cancellation",
    reschedule_pending: "reschedule",
    reschedule_request: "reschedule",
    booking_lookup: "existing booking",
    name_change_request: "name change",
    availability_check: "availability",
    handoff_request: "human agent",
    general: "general chat",
  },
  sq: {
    booking_flow: "rezervim",
    cancel_pending: "konfirmim anulimi",
    cancel_request: "anulim",
    reschedule_pending: "ndryshim ore",
    reschedule_request: "ndryshim ore",
    booking_lookup: "rezervim ekzistues",
    name_change_request: "ndryshim emri",
    availability_check: "disponueshmëri",
    handoff_request: "agjent njerëzor",
    general: "bisedë e përgjithshme",
  },
};

export function formatMessageForHistory(msg, currentText = "") {
  const role = msg?.direction === "outbound" ? "assistant" : "user";
  const type = msg?.type || "text";
  let content = String(msg?.text_body || "").trim();

  if (!content || content === "[image]") {
    if (type === "image") content = "[Image]";
    else if (type === "document") content = "[Document]";
    else if (type === "audio") content = content && content !== "[audio]" ? `[Voice] ${content}` : "[Voice message]";
    else if (type === "video") content = "[Video]";
    else if (type === "interactive") content = "[Selection]";
  }

  if (!content) return null;
  if (content.trim() === String(currentText || "").trim()) return null;
  return { role, content: content.slice(0, 1000), type };
}

export function buildThreadHistory(rawMessages, currentText, limit = 20) {
  const trimmed = Array.isArray(rawMessages) ? rawMessages.slice(-limit) : [];
  return trimmed
    .map((m) => formatMessageForHistory(m, currentText))
    .filter(Boolean);
}

function parsePartySizeFromHistory(historyMessages = []) {
  for (const m of [...historyMessages].reverse()) {
    if (m?.role !== "user") continue;
    const sq = stripAccentsLower(m.content);
    const match = /\b(\d{1,2})\s*(?:persona(?:ve)?|people|guests|veta)\b/.exec(sq);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseDateTimeHints(historyMessages = []) {
  const hints = new Set();
  for (const m of historyMessages) {
    if (m?.role !== "user") continue;
    const raw = String(m.content || "").trim();
    if (!raw || raw.length > 120) continue;
    const sq = stripAccentsLower(raw);
    if (
      /\b(neser|nesër|tomorrow|today|sot|pasneser|premte|hene|marte|merkure|enjte|shtune|diel|friday|monday)\b/.test(sq)
      || /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.test(sq)
      || /\b(ora|oren|at\s+\d|dark|evening|mbremje|pasdite)\b/.test(sq)
    ) {
      hints.add(raw.slice(0, 80));
    }
  }
  return [...hints].slice(-3);
}

function resolveNameFromHistory(historyMessages = []) {
  for (const m of [...historyMessages].reverse()) {
    if (m?.role !== "user") continue;
    const raw = String(m.content || "").trim();
    if (!raw || raw.length > 60) continue;
    if (/^\d+$/.test(raw)) continue;
    if (/\b(rezerv|book|cancel|anul|neser|tomorrow|persona|people)\b/i.test(raw)) continue;
    const asked = (historyMessages || []).some(
      (h) => h?.role === "assistant" && /\b(emri|emrin|name|quheni|si quheni)\b/i.test(String(h.content || ""))
    );
    if (asked && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-\s]{1,48}$/.test(raw)) return raw;
  }
  return null;
}

function lastAssistantQuestion(historyMessages = []) {
  for (const m of [...historyMessages].reverse()) {
    if (m?.role !== "assistant") continue;
    const raw = String(m.content || "").trim();
    if (raw.includes("?")) return raw.slice(0, 160);
  }
  return null;
}

function inferRecentTopics(historyMessages = [], lang = "en") {
  const topics = new Set();
  const userLines = (historyMessages || [])
    .filter((m) => m?.role === "user")
    .slice(-6);
  for (const m of userLines) {
    for (const t of detectMessageTopics(m.content, { bookingsEnabled: true })) {
      topics.add(t);
    }
    if (isLikelyFaqQuestion(m.content)) topics.add("faq");
  }
  return [...topics].slice(0, 5);
}

export function extractThreadFacts(historyMessages = [], mem = {}) {
  const partySize = parsePartySizeFromHistory(historyMessages);
  const dateTimeHints = parseDateTimeHints(historyMessages);
  const threadName = resolveNameFromHistory(historyMessages);
  const customerName = threadName || String(mem?.display_name || "").trim() || null;
  const pendingFromAssistant = lastAssistantQuestion(historyMessages);
  const recentTopics = inferRecentTopics(historyMessages);

  const missingForBooking = [];
  if (!dateTimeHints.length) missingForBooking.push("date/time");
  if (!partySize) missingForBooking.push("party size");
  if (!customerName) missingForBooking.push("customer name");

  return {
    customerName,
    partySize,
    dateTimeHints,
    pendingFromAssistant,
    recentTopics,
    missingForBooking,
  };
}

export function detectTopicShift({
  text,
  phase = "general",
  historyMessages = [],
  messageTopics = [],
  bookingsEnabled = true,
} = {}) {
  const currentTopics = messageTopics.length
    ? messageTopics
    : detectMessageTopics(text, { bookingsEnabled });
  const previousUser = [...(historyMessages || [])]
    .reverse()
    .find((m) => m?.role === "user" && String(m.content || "").trim() !== String(text || "").trim());
  const previousTopics = previousUser
    ? detectMessageTopics(previousUser.content, { bookingsEnabled })
    : [];

  const bookingPhases = new Set([
    "booking_flow",
    "availability_check",
    "reschedule_request",
    "reschedule_pending",
  ]);
  const infoTopics = new Set(["overview", "location", "faq"]);
  const currentIsInfo = currentTopics.some((t) => infoTopics.has(t))
    && !currentTopics.includes("booking")
    && !currentTopics.includes("availability");
  const wasBooking = bookingPhases.has(phase)
    || previousTopics.includes("booking")
    || previousTopics.includes("availability");

  if (wasBooking && currentIsInfo && !/\b(rezerv|book|termin|anul|cancel|ndrysh|resched)\w*/i.test(stripAccentsLower(text))) {
    const facts = extractThreadFacts(historyMessages);
    const preserve = [
      facts.partySize ? `party size ${facts.partySize}` : null,
      facts.dateTimeHints.length ? `date/time: ${facts.dateTimeHints.join(", ")}` : null,
      facts.customerName ? `name ${facts.customerName}` : null,
    ].filter(Boolean).join("; ");

    return {
      detected: true,
      from: PHASE_LABELS.en.booking_flow,
      to: currentTopics.filter((t) => infoTopics.has(t)).join(", ") || "information",
      preserveFacts: preserve || "booking details collected so far",
    };
  }

  if (phase === "general" && currentTopics.includes("booking") && previousTopics.some((t) => infoTopics.has(t))) {
    return {
      detected: true,
      from: "information",
      to: "booking",
      preserveFacts: "answer the booking request using any facts already shared",
    };
  }

  return { detected: false };
}

export function buildConversationContextBrief({
  text,
  historyMessages = [],
  phase = "general",
  mem = {},
  lang = "en",
  messageTopics = [],
  bookingsEnabled = true,
} = {}) {
  const facts = extractThreadFacts(historyMessages, mem);
  const shift = detectTopicShift({
    text,
    phase,
    historyMessages,
    messageTopics,
    bookingsEnabled,
  });
  const labels = PHASE_LABELS[lang === "sq" ? "sq" : "en"] || PHASE_LABELS.en;

  const lines = [
    lang === "sq"
      ? "KONTEKSTI I BISEDËS (ndërtuar nga kjo bisedë — beso këto fakte):"
      : "CONVERSATION CONTEXT (built from this thread — trust these facts):",
  ];

  if (facts.customerName) {
    lines.push(
      lang === "sq"
        ? `Emri i klientit në këtë bisedë: ${facts.customerName}`
        : `Customer name in this thread: ${facts.customerName}`
    );
  }
  if (facts.partySize) {
    lines.push(
      lang === "sq"
        ? `Numri i personave: ${facts.partySize}`
        : `Party size stated: ${facts.partySize}`
    );
  }
  if (facts.dateTimeHints.length) {
    lines.push(
      lang === "sq"
        ? `Data/ora e përmendur: ${facts.dateTimeHints.join("; ")}`
        : `Date/time mentioned: ${facts.dateTimeHints.join("; ")}`
    );
  }
  if (facts.recentTopics.length) {
    lines.push(
      lang === "sq"
        ? `Tema të fundit: ${facts.recentTopics.join(", ")}`
        : `Recent topics: ${facts.recentTopics.join(", ")}`
    );
  }
  if (facts.pendingFromAssistant) {
    lines.push(
      lang === "sq"
        ? `Pyetja juaj e fundit për klientin: ${facts.pendingFromAssistant}`
        : `Your last question to the customer: ${facts.pendingFromAssistant}`
    );
  }

  if (shift.detected) {
    const fromLabel = labels[phase] || shift.from;
    lines.push(
      lang === "sq"
        ? `NDRYSHIM TEME: Klienti kaloi nga "${fromLabel}" te "${shift.to}". Përgjigju pyetjes së RE së pari me profesionalizëm. Ruaj: ${shift.preserveFacts}.`
        : `TOPIC SHIFT: Customer moved from "${fromLabel}" to "${shift.to}". Answer the NEW question first, professionally. Preserve: ${shift.preserveFacts}.`
    );
  }

  if (
    (phase === "booking_flow" || phase === "availability_check")
    && facts.missingForBooking.length
    && facts.missingForBooking.length < 3
  ) {
    lines.push(
      lang === "sq"
        ? `Rezervimi ende i paplotë — mungon: ${facts.missingForBooking.join(", ")}.`
        : `Booking still incomplete — missing: ${facts.missingForBooking.join(", ")}.`
    );
  }

  lines.push(
    lang === "sq"
      ? "Rregulla: Mbaj profesionalizmin e biznesit. Kur pyetjet ndryshojnë, mos u ngatërro — përgjigju qartë çdo pyetjeje. Mos ripyet për diçka që klienti e ka thënë tashmë në këtë bisedë."
      : "Rules: Stay professional. When questions change, stay clear — answer each question directly. Do not re-ask for facts the customer already gave in this thread."
  );

  return lines.join("\n");
}

export default {
  buildThreadHistory,
  formatMessageForHistory,
  extractThreadFacts,
  detectTopicShift,
  buildConversationContextBrief,
};
