/**
 * Orchestrates the AI reply path: retrieve context, route the message, dispatch
 * to the right handler, then execute booking/handoff intents when needed.
 */

import { getDB } from "../db-mongodb.mjs";
import { retrieveKbMatches, pickPrimaryKbMatch } from "./kb.mjs";
import { generateAgentDecision, answerFromKbFaq } from "./ai.mjs";
import {
  detectConversationPhase,
  inferServerIntent,
  buildLiveSessionBrief,
  mergeAgentDecision,
  guardPrematureActionClaims,
  extractMemoryFacts,
  normalizeExecutedIntent,
  sanitizeReplyWhenBookingReady,
  bookIntentReady,
  isBookingNameCompletion,
  isUsableCustomerName,
  looksLikeStandaloneCustomerName,
} from "./agent-intelligence.mjs";
import { buildCustomerProfileSnippet, rememberName, rememberPartySize, getContactMemory } from "./memory.mjs";
import { isGreeting as isGreetingMessage } from "./agentPipelineHelpers.mjs";
import { isKbMissReply, isLikelyFaqQuestion, isLocationQuestion, t as tr } from "./i18n.mjs";
import { MESSAGE_ROUTES, routeCustomerMessage } from "./messageRouter.mjs";
import { detectMessageTopics } from "./messageTopics.mjs";
import { buildConversationContextBrief } from "./conversationContext.mjs";
import {
  guardBookingEnforcement,
} from "./refiningEnforcement.mjs";
import { getBookingFieldsFromSettings, resolveBookingFieldValues, fieldIntentKey } from "./bookingFields.mjs";

export async function runAgentMessagePipeline(ctx) {
  const {
    text,
    lang,
    cfg,
    tenant,
    tenantUserId,
    from,
    fromDigits,
    req,
    historyMessages,
    conversationStarted,
    shouldGreet,
    knownCustomerName: initialName,
    aiOptions,
    cachedRetrieveKbMatches = retrieveKbMatches,
    buildAiContextSnippets,
    findUpcomingConfirmedAppointment,
    sendTextTracked,
    executeAgentIntent,
    finalizeAssistantReply,
    tryReplyWithBusinessLocation,
    trySendBusinessLocationPin,
    isGreeting = isGreetingMessage,
  } = ctx;

  let knownCustomerName = String(initialName || "").trim();
  const pipelineHistory = historyMessages;
  const bookingHistory = historyMessages;
  const bookingsEnabled = !!cfg?.bookings_enabled;
  const bookingFieldConfig = getBookingFieldsFromSettings(tenant || cfg, lang);
  const bookingFields = bookingFieldConfig.fields || [];

  const kbMatchesAIBase = await cachedRetrieveKbMatches(text, 8, tenantUserId, "", from, lang);
  const profileSnippet = await buildCustomerProfileSnippet(tenantUserId, from);
  const kbMatchesAI = buildAiContextSnippets(cfg, { kbMatches: kbMatchesAIBase, profileSnippet });

  let activeBookingSession = null;
  let upcomingAppt = null;
  let contactMem = {};
  try {
    const dbNative = getDB();
    activeBookingSession = await dbNative.collection("booking_sessions").findOne({
      user_id: String(tenantUserId),
      contact_id: String(from),
      step: { $in: ["awaiting_cancel_confirm", "awaiting_reschedule_dt"] },
    });
    contactMem = await getContactMemory(tenantUserId, from);
    if (!knownCustomerName && contactMem?.display_name) {
      knownCustomerName = String(contactMem.display_name).trim();
    }
    if (cfg?.bookings_enabled && bookingsEnabled) {
      upcomingAppt = await findUpcomingConfirmedAppointment({
        userId: tenantUserId,
        digits: fromDigits,
        projection: { id: 1, start_ts: 1, staff_id: 1, _id: 1 },
      });
    }
  } catch {}

  const conversationPhase = detectConversationPhase({
    text,
    bookingSession: activeBookingSession,
    hasUpcomingAppt: !!upcomingAppt,
    lang,
    historyMessages: bookingHistory,
  });
  const inferredIntent = inferServerIntent({
    text,
    phase: conversationPhase,
    bookingsEnabled,
    historyMessages: bookingHistory,
    upcomingAppt,
    bookingFields,
    knownCustomerName,
    contactId: from,
  });
  const liveSessionBrief = buildLiveSessionBrief({
    phase: conversationPhase,
    bookingSession: activeBookingSession,
    profileSnippet,
    upcomingAppt,
    mem: contactMem,
    lang,
  });

  const memoryFacts = extractMemoryFacts(text);
  if (memoryFacts.partySize) {
    try { await rememberPartySize(tenantUserId, from, memoryFacts.partySize); } catch {}
  }
  if (memoryFacts.name) {
    try { await rememberName(tenantUserId, from, memoryFacts.name); } catch {}
    knownCustomerName = memoryFacts.name;
  }
  if (
    looksLikeStandaloneCustomerName(String(text || "").trim())
    && (conversationPhase === "booking_flow" || isBookingNameCompletion(text, pipelineHistory))
  ) {
    const standaloneName = String(text || "").trim();
    try { await rememberName(tenantUserId, from, standaloneName); } catch {}
    knownCustomerName = standaloneName;
  }

  const routing = routeCustomerMessage(text, {
    conversationPhase,
    inferredIntent,
    kbMatches: kbMatchesAIBase,
    lang,
    bookingsEnabled,
    conversationMode: cfg?.conversation_mode || "",
  });

  const messageTopics = routing.topics || detectMessageTopics(text, { bookingsEnabled, lang });
  const multiTopic = messageTopics.length > 1 || routing.reason === "multi_topic";

  const conversationContextBrief = buildConversationContextBrief({
    text,
    historyMessages: pipelineHistory,
    phase: conversationPhase,
    mem: contactMem,
    lang,
    messageTopics,
    bookingsEnabled,
  });

  const enforcement = await guardBookingEnforcement({
    userId: tenantUserId,
    contactId: from,
    cfg,
    tenant,
    text,
    historyMessages: pipelineHistory,
    partySize: memoryFacts.partySize || null,
    memPartySize: contactMem?.last_party_size || null,
    lang,
    conversationPhase,
    route: routing.route,
    intentType: inferredIntent?.type || null,
    requireBookingContext: true,
  });
  if (enforcement?.blockBooking && enforcement.reply) {
    await sendTextTracked(from, String(enforcement.reply).slice(0, 1000), cfg);
    return { handled: true, route: "enforced_rule", knownCustomerName, enforcement };
  }

  console.log("[AI-path] route", {
    route: routing.route,
    reason: routing.reason,
    confidence: routing.confidence,
    phase: conversationPhase,
    inferred: inferredIntent?.type || null,
    topics: messageTopics,
    multiTopic,
  });

  if (
    !multiTopic
    && routing.route === MESSAGE_ROUTES.LOCATION
  ) {
    if (await tryReplyWithBusinessLocation(from, text, cfg, lang)) {
      return { handled: true, route: routing.route };
    }
  }

  if (
    !multiTopic
    && routing.route === MESSAGE_ROUTES.FAQ
    && routing.primaryKbMatch
  ) {
    const faqReply = await answerFromKbFaq(text, routing.primaryKbMatch, {
      tone: tenant?.ai_tone,
      style: tenant?.ai_style,
      lang,
      historyMessages: pipelineHistory,
      shouldGreet,
      businessName: cfg?.business_name || "",
      refiningRules: tenant?.ai_refining_rules || cfg?.ai_refining_rules || "",
      conversationContextBrief,
    });
    const faqNormalized = faqReply
      ? guardPrematureActionClaims(
          finalizeAssistantReply(faqReply, { conversationStarted, userMessage: text, lang, shouldGreet }),
          { phase: conversationPhase, lang }
        )
      : null;
    if (faqNormalized) {
      await sendTextTracked(from, String(faqNormalized).slice(0, 1000), cfg);
      return { handled: true, route: routing.route };
    }
  }

  const isOverview = routing.route === MESSAGE_ROUTES.OVERVIEW;
  const primaryKbMatch = isOverview ? null : (routing.primaryKbMatch || pickPrimaryKbMatch(text, kbMatchesAIBase, lang));

  let decision = await generateAgentDecision(text, kbMatchesAI, {
    tone: tenant?.ai_tone,
    style: tenant?.ai_style,
    blockedTopics: tenant?.ai_blocked_topics,
    historyMessages: pipelineHistory,
    lang,
    conversationStarted,
    userMessageIsGreeting: isGreeting(text),
    shouldGreet,
    primaryKbMatch,
    isBusinessOverviewQuestion: isOverview,
    liveSessionBrief,
    conversationContextBrief,
    inferredIntent,
    businessName: cfg?.business_name || "",
    businessType: cfg?.business_type || "",
    businessWebsite: cfg?.website_url || "",
    businessCategories: aiOptions.businessCategories,
    refiningRules: tenant?.ai_refining_rules || cfg?.ai_refining_rules || "",
    bookingFields,
    features: buildAgentFeatures(cfg, knownCustomerName, bookingsEnabled),
    multiTopic,
    messageTopics,
    conversationPhase,
  });

  decision = mergeAgentDecision(decision, inferredIntent, {
    aiText: decision?.text,
    userText: text,
    conversationPhase,
    completingBookingWithName: isBookingNameCompletion(text, bookingHistory),
    historyMessages: bookingHistory,
    knownCustomerName,
    contactId: from,
    bookingFields,
    isUsableCustomerName,
  });
  console.log("[AI-path] decision", {
    route: routing.route,
    hasText: !!decision?.text,
    textLen: decision?.text ? String(decision.text).length : 0,
    intent: decision?.intent?.type || "none",
    phase: conversationPhase,
    inferred: inferredIntent?.type || null,
  });

  let replyText = decision?.text
    ? guardPrematureActionClaims(
        finalizeAssistantReply(decision.text, { conversationStarted, userMessage: text, lang, shouldGreet }),
        { phase: conversationPhase, lang }
      )
    : null;

  const kbFallback = routing.kbAssessment;
  if (
    (!replyText || isKbMissReply(replyText, lang))
    && kbFallback?.match
    && isLikelyFaqQuestion(text)
    && !isOverview
    && routing.route !== MESSAGE_ROUTES.BOOKING
    && kbFallback.confidence >= 0.45
  ) {
    const fallbackReply = await answerFromKbFaq(text, kbFallback.match, {
      tone: tenant?.ai_tone,
      style: tenant?.ai_style,
      lang,
      historyMessages: pipelineHistory,
      shouldGreet,
      businessName: cfg?.business_name || "",
    });
    const fallbackNormalized = fallbackReply
      ? finalizeAssistantReply(fallbackReply, { conversationStarted, userMessage: text, lang, shouldGreet })
      : null;
    if (fallbackNormalized) replyText = fallbackNormalized;
  }

  const normalizedIntent = normalizeExecutedIntent({
    intentType: decision?.intent?.type,
    intentData: decision?.intent?.data,
    text,
    replyText,
    historyMessages: bookingHistory,
    knownCustomerName,
    contactId: from,
    bookingFields,
  });
  const intentType = normalizedIntent.intentType;
  let intentData = normalizedIntent.intentData;

  const bookingReady = bookIntentReady({
    text,
    intentData,
    historyMessages: bookingHistory,
    knownCustomerName,
    contactId: from,
    bookingFields,
    isUsableCustomerName,
  });

  if (replyText && bookingReady) {
    replyText = sanitizeReplyWhenBookingReady(replyText, { lang, bookingFields });
  }

  let effectiveIntentType = intentType;
  if (bookingReady && effectiveIntentType !== "book") {
    effectiveIntentType = "book";
    const values = resolveBookingFieldValues({
      fields: bookingFields,
      text,
      historyMessages: bookingHistory,
      intentData,
      knownCustomerName,
      contactId: from,
      isUsableCustomerName,
    });
    intentData = { ...intentData };
    for (const field of bookingFields) {
      const key = fieldIntentKey(field);
      const val = values[field.id];
      if (val != null && String(val).trim() !== "") intentData[key] = val;
    }
  }

  if (
    bookingsEnabled
    && effectiveIntentType
    && (effectiveIntentType === "book" || effectiveIntentType === "availability")
  ) {
    const intentBlock = await guardBookingEnforcement({
      userId: tenantUserId,
      contactId: from,
      cfg,
      tenant,
      text,
      historyMessages: bookingHistory,
      partySize: memoryFacts.partySize || null,
      memPartySize: contactMem?.last_party_size || null,
      lang,
      conversationPhase,
      route: routing.route,
      intentType: effectiveIntentType,
      requireBookingContext: false,
    });
    if (intentBlock?.blockBooking && intentBlock.reply) {
      await sendTextTracked(from, String(intentBlock.reply).slice(0, 1000), cfg);
      return { handled: true, route: "enforced_rule", knownCustomerName, enforcement: intentBlock };
    }
  }

  if (replyText) {
    await sendTextTracked(from, String(replyText).slice(0, 1000), cfg);
  } else if (decision?.text) {
    // Suppressed a redundant mid-conversation greeting-only reply.
  } else {
    console.error("[AI-path] empty decision — sending fallback notice to user", { from: String(from).slice(-6) });
    try {
      await sendTextTracked(from, tr("error_generic", cfg?.__lang), cfg);
    } catch (sendErr) {
      console.error("[AI-path] fallback sendText failed:", sendErr?.message || sendErr);
    }
  }

  if (
    isLocationQuestion(text)
    && conversationPhase !== "booking_flow"
    && typeof trySendBusinessLocationPin === "function"
  ) {
    try {
      await trySendBusinessLocationPin(from, cfg, lang);
    } catch (pinErr) {
      console.warn("[AI-path] location pin after multi-topic reply failed:", pinErr?.message || pinErr);
    }
  }

  if (effectiveIntentType && effectiveIntentType !== "none") {
    if (cfg?.conversation_mode === "escalation" && effectiveIntentType !== "handoff") {
      return { handled: true, route: routing.route, knownCustomerName };
    }
    await executeAgentIntent({
      intentType: effectiveIntentType,
      intentData,
      text,
      historyMessages,
      tenantUserId,
      from,
      fromDigits,
      cfg,
      tenant,
      req,
      replyText,
      knownCustomerName,
      bookingsEnabled,
    });
  }

  return { handled: true, route: routing.route, knownCustomerName };
}

function buildAgentFeatures(cfg, knownCustomerName, bookingsEnabled = false) {
  return {
    bookings_enabled: !!bookingsEnabled,
    reminders_enabled: !!cfg?.reminders_enabled,
    business_name: cfg?.business_name || "",
    business_website: cfg?.website_url || "",
    services: (() => { try { const s = JSON.parse(cfg?.services_json || "[]"); return Array.isArray(s) ? s : []; } catch { return []; } })(),
    conversation_mode: cfg?.conversation_mode || "",
    business_type: cfg?.business_type || "",
    business_categories: (() => { try { const arr = JSON.parse(cfg?.business_categories_json || "[]"); return Array.isArray(arr) ? arr : []; } catch { return []; } })(),
    escalation_questions: normalizeEscalationQuestions(cfg),
    customer_name: knownCustomerName || "",
  };
}

function normalizeEscalationQuestions(cfg) {
  let arr = [];
  try { arr = JSON.parse(cfg?.escalation_questions_json || "[]"); } catch {}
  if (!Array.isArray(arr)) arr = [];
  arr = arr.map((q) => String(q || "").trim()).filter(Boolean);
  if (!arr.length) arr.push("What's your name?");
  const idx = arr.findIndex((q) => /name/i.test(q));
  if (idx === -1) {
    arr.unshift("What's your name?");
  } else if (idx > 0) {
    const [nameQ] = arr.splice(idx, 1);
    arr.unshift(nameQ);
  }
  return arr.slice(0, 10);
}

export default { runAgentMessagePipeline };
