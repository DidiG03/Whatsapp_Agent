/**
 * Detect when a single WhatsApp message contains multiple customer intents.
 */

import { isGeneralBusinessOverviewQuestion, isLocationQuestion } from "./i18n.mjs";
import { isAvailabilityInquiry, wantsTimeSlotSuggestions } from "./agent-intelligence.mjs";

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const CONJUNCTION_SPLIT = /\s+(?:,\s*)?(?:dhe|edhe|and|&|plus|also|as well as|gjithashtu|po ashtu)\s+|\s*;\s*|\s*\?\s+(?=[A-Za-zÇËçë])|\s*\?\s*(?:dhe|edhe|and)\s+/i;

export function splitMessageClauses(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw.split(CONJUNCTION_SPLIT).map((s) => s.trim()).filter((s) => s.length > 2);
  return parts.length ? parts : [raw];
}

function hasBookingAsk(text) {
  const sq = stripAccentsLower(text);
  return /\b(rezerv|book(?:ing)?|termin|takim|appointment)\w*/.test(sq)
    && /\b(neser|tomorrow|today|sot|date|data|ora|oren|at\s+\d|\d{1,2}[\/\-.]\d{1,2})\b/.test(sq);
}

function hasHandoffAsk(text) {
  const sq = stripAccentsLower(text);
  return /\b(njeri|human|agent|operator|staf|colleague|person)\b/.test(sq)
    || /\b(flas\s+me|talk\s+to\s+a)\b/.test(sq);
}

function clauseTopics(clause, fullText, options = {}) {
  const topics = new Set();
  const piece = String(clause || "").trim();
  const full = String(fullText || piece).trim();
  if (!piece) return topics;

  if (isLocationQuestion(piece) || (/\b(ku|where)\b/i.test(piece) && /\b(ndodheni|jeni|gjeni|locat|address)\b/i.test(piece))) {
    topics.add("location");
  }
  if (isGeneralBusinessOverviewQuestion(piece) || isGeneralBusinessOverviewQuestion(full)) {
    topics.add("overview");
  }
  if (options.bookingsEnabled !== false && wantsTimeSlotSuggestions(piece)) {
    topics.add("availability");
  }
  if (options.bookingsEnabled !== false && (hasBookingAsk(piece) || isAvailabilityInquiry(piece))) {
    topics.add("booking");
  }
  if (hasHandoffAsk(piece)) {
    topics.add("handoff");
  }
  return topics;
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.bookingsEnabled]
 * @returns {string[]}
 */
export function detectMessageTopics(text, options = {}) {
  const full = String(text || "").trim();
  if (!full) return [];

  const topics = new Set();
  const clauses = splitMessageClauses(full);
  const parts = clauses.length > 1 ? clauses : [full];

  for (const clause of parts) {
    for (const topic of clauseTopics(clause, full, options)) topics.add(topic);
  }

  if (isLocationQuestion(full)) topics.add("location");
  if (isGeneralBusinessOverviewQuestion(full)) topics.add("overview");
  if (options.bookingsEnabled !== false && wantsTimeSlotSuggestions(full)) topics.add("availability");
  if (options.bookingsEnabled !== false && (hasBookingAsk(full) || isAvailabilityInquiry(full))) topics.add("booking");
  if (hasHandoffAsk(full)) topics.add("handoff");

  return [...topics];
}

export function isMultiTopicMessage(text, options = {}) {
  return detectMessageTopics(text, options).length > 1;
}

export default {
  splitMessageClauses,
  detectMessageTopics,
  isMultiTopicMessage,
};
