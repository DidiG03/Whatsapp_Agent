/**
 * Classifies inbound customer messages into handler routes before the LLM runs.
 * Keeps FAQ fast-path, booking flows, and broad overview questions on separate rails.
 */

import { isGeneralBusinessOverviewQuestion, isLocationQuestion } from "./i18n.mjs";
import { assessPrimaryKbConfidence } from "./kb.mjs";
import { detectMessageTopics } from "./messageTopics.mjs";

export const MESSAGE_ROUTES = {
  OVERVIEW: "overview",
  FAQ: "faq",
  BOOKING: "booking",
  HANDOFF: "handoff",
  LOCATION: "location",
  GENERAL: "general",
};

const BOOKING_PHASES = new Set([
  "booking_flow",
  "cancel_request",
  "cancel_pending",
  "reschedule_request",
  "reschedule_pending",
  "availability_check",
  "booking_lookup",
  "name_change_request",
]);

const BOOKING_INTENTS = new Set(["book", "cancel", "reschedule", "availability", "update_name"]);

/**
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.conversationPhase]
 * @param {object|null} [options.inferredIntent]
 * @param {Array} [options.kbMatches]
 * @param {string} [options.lang]
 * @param {boolean} [options.bookingsEnabled]
 * @param {string} [options.conversationMode]
 */
export function routeCustomerMessage(text, options = {}) {
  const {
    conversationPhase = "general",
    inferredIntent = null,
    kbMatches = [],
    lang = "en",
    bookingsEnabled = false,
    conversationMode = "",
  } = options;

  const message = String(text || "").trim();
  if (!message) {
    return { route: MESSAGE_ROUTES.GENERAL, confidence: 0, reason: "empty_message" };
  }

  const topics = detectMessageTopics(message, { bookingsEnabled, lang });
  if (topics.length > 1) {
    return {
      route: MESSAGE_ROUTES.GENERAL,
      confidence: 0.92,
      reason: "multi_topic",
      topics,
    };
  }

  if (String(conversationMode).toLowerCase() === "escalation") {
    return { route: MESSAGE_ROUTES.HANDOFF, confidence: 1, reason: "escalation_mode" };
  }

  if (conversationPhase === "handoff_request") {
    return { route: MESSAGE_ROUTES.HANDOFF, confidence: 0.95, reason: "handoff_request" };
  }

  if (isLocationQuestion(message)) {
    return { route: MESSAGE_ROUTES.LOCATION, confidence: 0.95, reason: "location_question" };
  }

  if (isGeneralBusinessOverviewQuestion(message)) {
    return { route: MESSAGE_ROUTES.OVERVIEW, confidence: 0.95, reason: "business_overview" };
  }

  if (bookingsEnabled && BOOKING_PHASES.has(conversationPhase)) {
    return {
      route: MESSAGE_ROUTES.BOOKING,
      confidence: 0.9,
      reason: `phase_${conversationPhase}`,
    };
  }

  const intentType = String(inferredIntent?.type || "").toLowerCase();
  const intentConfidence = Number(inferredIntent?.confidence || 0);

  if (intentConfidence >= 0.85 && intentType === "handoff") {
    return {
      route: MESSAGE_ROUTES.HANDOFF,
      confidence: intentConfidence,
      reason: "intent_handoff",
    };
  }

  if (bookingsEnabled && intentConfidence >= 0.82 && BOOKING_INTENTS.has(intentType)) {
    return {
      route: MESSAGE_ROUTES.BOOKING,
      confidence: intentConfidence,
      reason: `intent_${intentType}`,
    };
  }

  const kbAssessment = assessPrimaryKbConfidence(message, kbMatches, lang);
  if (kbAssessment.useFastPath && kbAssessment.match) {
    return {
      route: MESSAGE_ROUTES.FAQ,
      confidence: kbAssessment.confidence,
      reason: kbAssessment.reason,
      primaryKbMatch: kbAssessment.match,
      kbAssessment,
    };
  }

  return {
    route: MESSAGE_ROUTES.GENERAL,
    confidence: 0.5,
    reason: kbAssessment.reason || "default_ai",
    primaryKbMatch: kbAssessment.match,
    kbAssessment,
  };
}

export default { MESSAGE_ROUTES, routeCustomerMessage };
