
import crypto from "node:crypto";
import { getRedisClient, isRedisConnected, rateLimiter } from "../scalability/redis.mjs";
import { db, getDB } from "../db-mongodb.mjs";
import { findSettingsByVerifyToken, findSettingsByPhoneNumberId, findSettingsByBusinessPhone, buildBusinessSettingsSnippet, getBusinessLocation, upsertSettingsForUser } from "../services/settings.mjs";
import { retrieveKbMatches, buildKbSuggestions } from "../services/kb.mjs";
import { Customer, Handoff, KBItem, Staff } from "../schemas/mongodb.mjs";
import { sendWhatsappButton, sendWhatsAppText, sendWhatsAppGroupText, sendWhatsAppLocation, sendWhatsappList, sendWhatsappReaction, sendWhatsappDocument } from "../services/whatsapp.mjs";
import { normalizePhone, buildUtcFromLocalWallTime } from "../utils.mjs";
import { runAgentMessagePipeline } from "../services/agentPipeline.mjs";
import { generateAiReply, generateAssistantNudge } from "../services/ai.mjs";
import { detectLanguage, resolveLanguage, sanitizeAssistantReply, isStandaloneGreeting, isLocationQuestion, shouldPrefaceWithGreeting, prependSessionGreeting, stripEmDashes, stripBoilerplateHelpOffers, t as tr } from "../services/i18n.mjs";
import { buildCustomerProfileSnippet, rememberService, rememberAgent, rememberAppointment, rememberName, rememberPartySize, updateContactMemory, getContactMemory } from "../services/memory.mjs";
import {
  isCancelAbort,
  isCancelConfirmation,
  isExplicitAvailabilityRequest,
  parseBookingNameChange,
} from "../services/agent-intelligence.mjs";
import { listMessagesForThread } from "../services/conversations.mjs";
import { listAvailability, createBooking, rescheduleBooking, cancelBooking, updateBookingName, buildDayRows, buildTimeRows, filterSlotsByTimeOfDay, getStaffById, ensureAppointmentLegacyId, findAppointmentForUser, resolveAppointmentRefId } from "../services/booking.mjs";
import { recordOutboundMessage, recordInboundMessage } from "../services/messages.mjs";
import { sendEscalationNotification, sendBookingNotification } from "../services/email.mjs";
import { isStaffGroupConnectCommand, sendStaffGroupBookingNotification } from "../services/staffGroupNotifications.mjs";
import { handleCoexistenceMessageEchoes } from "../services/coexistenceLiveMode.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { incrementUsage, getUserPlan, isUsageExceeded } from "../services/usage.mjs";
import { addReaction, removeReaction } from "../services/reactions.mjs";
import { broadcastNewMessage, broadcastReaction, broadcastMessageStatus } from "./realtime.mjs";
import { updateMessageDeliveryStatus, updateMessageReadStatus, READ_STATUS, MESSAGE_STATUS } from "../services/messageStatus.mjs";
import { getConversationStatus, updateConversationStatus, CONVERSATION_STATUSES } from "../services/conversationStatus.mjs";
import { businessMetrics, incrementCounter } from "../monitoring/metrics.mjs";
import { enqueueOutboundMessage } from "../jobs/outboundQueue.mjs";
// Build AI/nudge options from a per-request settings object. The resolved
// conversation language is stashed on the settings object as `__lang` (see the
// webhook handler) so every call site — which already has `tenant`/`cfg` in
// scope — can pass it through without extra plumbing.
function aiOpts(settings, extra = {}) {
  let businessCategories = [];
  try {
    const arr = JSON.parse(settings?.business_categories_json || '[]');
    businessCategories = Array.isArray(arr) ? arr : [];
  } catch {}
  return {
    tone: settings?.ai_tone,
    style: settings?.ai_style,
    lang: (settings && (settings.__lang === 'sq' || settings.__lang === 'en')) ? settings.__lang : 'en',
    businessName: settings?.business_name || '',
    businessType: settings?.business_type || '',
    businessWebsite: settings?.website_url || '',
    businessCategories,
    ...extra,
  };
}

function buildAiContextSnippets(cfg, { kbMatches = [], profileSnippet = null } = {}) {
  const settingsSnippet = buildBusinessSettingsSnippet(cfg);
  return [
    ...(settingsSnippet ? [settingsSnippet] : []),
    ...(profileSnippet ? [profileSnippet] : []),
    ...(Array.isArray(kbMatches) ? kbMatches : []),
  ];
}

const RE_GREETING_SIMPLE = /^(hi|hello|hey|yo|hiya|howdy|greetings)\b/;
const RE_GREETING_GOOD = /^good\s+(morning|afternoon|evening)\b/;
const RE_ACK_ONLY_EMOJI = /^[\u{1F44D}\u{1F44C}\u{1F64F}\u{1F44F}\u{2764}\u{1F60A}\u{1F642}]+$/u;
const ACK_TOKENS = [
  'thanks','thank you','many thanks','appreciated','thx','tnx','thanx','ty','tks','thank u',
  'ok','okay','k','kk','roger','got it','gotcha','cool','nice','great','perfect','awesome','cheers','sounds good','noted','understood',
  // Albanian
  'faleminderit','flm','rrofsh','mire','mirë','ne rregull','në rregull','dakord','sigurisht','kuptova','perfekt','shume mire','shumë mirë','okej'
];
const ACK_TOKENS_SET = new Set(ACK_TOKENS);
const SUBSTANTIVE_INTENT_RE = /(book|booking|reserve|reservation|appointment|order|buy|purchase|price|cost|quote|hours|open|closing|when\s*open|location|address|where|near|deliver|delivery|ship|shipping|pickup|refund|return|exchange|warranty|support|help|issue|problem|complaint|agent|human|connect|cancel|resched|change|modify|update|subscribe|signup|register|payment|pay|invoice|billing|menu|service|services|product|products|availability|slot|table|contact|phone|email)/i;
const DEFAULT_ESCALATION_ACK = "An agent will respond to you shortly.";
const memKb = new Map();
const KB_CACHE_TTL_MS = Number(process.env.KB_CACHE_TTL_MS || 5000);
function kbCacheKey(userId, contact, text) {
  return `${String(userId||'')}:${String(contact||'')}:${String(text||'').toLowerCase().trim().slice(0,200)}`;
}
async function cachedRetrieveKbMatches(text, limit, userId, scope, contact, lang) {
  try {
    if (!KB_CACHE_TTL_MS || KB_CACHE_TTL_MS <= 0) {
      return await retrieveKbMatches(text, limit, userId, scope, lang);
    }
    const key = `${kbCacheKey(userId, contact, text)}:${lang || 'en'}`;
    const now = Date.now();
    const hit = memKb.get(key);
    if (hit && hit.expires > now) return hit.val;
    const val = await retrieveKbMatches(text, limit, userId, scope, lang);
    memKb.set(key, { val, expires: now + KB_CACHE_TTL_MS });
    return val;
  } catch {
    return await retrieveKbMatches(text, limit, userId, scope, lang);
  }
}

function finalizeAssistantReply(raw, { conversationStarted, userMessage, lang, shouldGreet = false }) {
  let reply = sanitizeAssistantReply(raw, { conversationStarted, userMessage, lang });
  if (!reply) return null;
  if (conversationStarted && !isGreeting(userMessage) && isStandaloneGreeting(reply)) {
    return null;
  }
  if (shouldGreet) {
    reply = prependSessionGreeting(reply, lang, userMessage);
  }
  return reply;
}

const RE_GREETING_SQ = /^(pershendetje|tungjatjeta|tung|tungi|ckemi|c'kemi|miremengjes|miredita|mirembrema|hej|tjeta)\b/;

function isGreeting(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;

  if (RE_GREETING_SIMPLE.test(s)) return true;
  if (RE_GREETING_GOOD.test(s)) return true;

  if(["hi", "hello", "hey", "yo", "hiya", "howdy", "greetings", "good morning", "good afternoon", "good evening"].includes(s)) return true;

  const sq = stripAccentsLower(s);
  if (RE_GREETING_SQ.test(sq)) return true;
  if (["pershendetje", "tungjatjeta", "tung", "ckemi", "miremengjes", "miredita", "mirembrema"].includes(sq)) return true;
  return false;
}

function isAcknowledgement(raw) {
  const text = String(raw || '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  if (!text) return false;
  if (/\btest\b/.test(text)) return false;
  const onlyEmoji = text.replace(/[\p{L}\p{N}\s]/gu, '').trim();
  if (RE_ACK_ONLY_EMOJI.test(onlyEmoji)) return true;
  if (ACK_TOKENS_SET.has(text)) return true;
  const tokens = text.split(' ').filter(Boolean);
  const candidates = [text, ...tokens];
  for (const c of candidates) {
    for (const a of ACK_TOKENS) {
      const lenOk = c.length >= 4 && a.length >= 4;
      if (!lenOk) continue;      const dist = levenshtein(c, a);
      const rel = dist / Math.max(c.length, a.length);
      if (dist <= 1 || rel <= 0.2) return true;
    }
  }
  return false;
}

function levenshtein(a, b) {
  const s = a || '', t = b || '';
  const m = s.length, n = t.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function wantsHuman(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return false;
  if (/\b(human|agent|representative|real person|support|customer service|talk to (a )?human|speak to (a )?human|live chat)\b/.test(s)) return true;
  // Albanian: njeri (person), agjent, operator, "flas me dikë", "person real", ndihmë nga dikush
  const sq = stripAccentsLower(raw);
  return /\b(agjent|operator|njeri|person\s+real|flas\s+me\s+(dike|nje\s+njeri|dikend)|me\s+nje\s+njeri|dua\s+nje\s+njeri)\b/.test(sq);
}

function needsAgentFollowup(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return false;
  if (wantsHuman(s)) return true;
  if (/still\s+(waiting|not|get)/.test(s) && /(agent|human|reply|response|connected)/.test(s)) return true;
  if (/not\s+(yet\s+)?(connected|hearing)/.test(s) && /(agent|human)/.test(s)) return true;
  if (/(anyone|someone)\s+(there|available)/.test(s)) return true;
  if (/connect(ed)?\s+(me\s+)?(with|to)\s+(an?\s+)?(agent|human)/.test(s)) return true;
  if (/\bhelp\b/.test(s) && s.length <= 40) return true;
  if (/^(hi|hello|hey)\b/.test(s) && s.length <= 16) return true;
  return false;
}
async function sendKbItemByTitle({ tenantUserId, to, title, cfg }) {
  try {
    const row = await KBItem.findOne({ user_id: tenantUserId, title }).select('content file_url file_mime title').lean();
    if (row?.file_url) {
      const isPdf = /pdf/i.test(String(row.file_mime||'')) || /\.pdf(\?|#|$)/i.test(String(row.file_url||''));
      if (isPdf) {
        try {
          const resp = await sendDocumentTracked(to, row.file_url, ((row.title||'document') + '.pdf'), cfg);
          let outboundId = resp?.messages?.[0]?.id;
          if (!outboundId) outboundId = `local_${Date.now()}_${Math.floor(Math.random()*1e9)}`;
          recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to, type: 'document', text: null, raw: { to, reply: 'kb_pdf' } });
          return true;
        } catch {}
      }
    }
    const outText = row?.content || "I couldn't find that info.";
    const resp = await sendTextTracked(to, outText, cfg);
    try {
      let outboundId = resp?.messages?.[0]?.id;
      if (!outboundId) outboundId = `local_${Date.now()}_${Math.floor(Math.random()*1e9)}`;
      recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to, type: 'text', text: outText, raw: { to, reply: 'kb_text' } });
    } catch {}
    return true;
  } catch {
    return false;
  }
}
const SQ_MONTHS = {
  janar: 'january', shkurt: 'february', mars: 'march', prill: 'april', maj: 'may',
  qershor: 'june', korrik: 'july', gusht: 'august', shtator: 'september',
  tetor: 'october', nentor: 'november', dhjetor: 'december'
};

function stripAccentsLower(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Translate Albanian date/time phrasing into the English forms the parsers below
// already understand. Safe to run on English input (acts as a no-op there).
function normalizeTemporal(raw) {
  let s = stripAccentsLower(raw);
  // Weekday names (with optional "e"/"të" article and accusative endings).
  s = s.replace(/\b(?:e\s+|te\s+)?(?:henen|hene)\b/g, 'monday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:marten|marte)\b/g, 'tuesday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:merkuren|merkure)\b/g, 'wednesday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:enjten|enjte)\b/g, 'thursday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:premten|premte)\b/g, 'friday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:shtunen|shtune)\b/g, 'saturday');
  s = s.replace(/\b(?:e\s+|te\s+)?(?:dielen|diel)\b/g, 'sunday');
  // Week ranges.
  s = s.replace(/\bjaven\s+(?:tjeter|e\s+ardhshme|e\s+ardheshme)\b/g, 'next week');
  s = s.replace(/\bkete\s+jave\b/g, 'this week');
  // "<weekday> tjetër/e ardhshme" -> "next <weekday>".
  s = s.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:tjeter|e\s+ardhshme|e\s+ardheshme)\b/g, 'next $1');
  // Relative days (check the longer phrase first).
  s = s.replace(/\bpasneser\b/g, 'day after tomorrow');
  s = s.replace(/\bneser\b/g, 'tomorrow');
  s = s.replace(/\bsot\b/g, 'today');
  s = s.replace(/\bdje\b/g, 'yesterday');
  // "tek ora 8", "rreth ores 8", "ne oren 8" -> "at 8"
  s = s.replace(/\btek\b/g, ' ');
  s = s.replace(/\brreth\b/g, ' around ');
  s = s.replace(/\bdiku\b/g, ' around ');
  s = s.replace(/\b(?:ne\s+)?ores?\b/g, ' at ');
  s = s.replace(/\bne\s+oren\b/g, ' at ');
  s = s.replace(/\boren\b/g, ' at ');
  s = s.replace(/\bora\b/g, 'at');
  // Dayparts used to disambiguate a bare hour.
  s = s.replace(/\bparadite\b/g, ' am ');
  s = s.replace(/\bmengjes(?:i|in)?\b/g, ' am ');
  s = s.replace(/\bte\s+pasdites?\b/g, ' pm ');
  s = s.replace(/\bpasdites?\b/g, ' pm ');
  s = s.replace(/\bmbremje(?:s|n)?\b/g, ' pm evening ');
  s = s.replace(/\bnaten?\b/g, ' pm ');
  s = s.replace(/\bdark(?:a|e|es)?\b/g, ' pm evening dinner ');
  s = s.replace(/\bnga\s+darka\b/g, ' pm evening ');
  // Albanian month names -> English.
  for (const [sq, en] of Object.entries(SQ_MONTHS)) {
    s = s.replace(new RegExp('\\b' + sq + '\\b', 'g'), en);
  }
  // Albanian writes day-before-month ("3 nëntor"); reorder to "november 3".
  s = s.replace(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, '$2 $1');
  return s;
}

function dayOfMonthToISO(day, now = new Date()) {
  const d = Number(day);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  if (d < now.getUTCDate()) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDayOfMonthFromText(text) {
  const s = normalizeTemporal(text);
  let m = /\b(?:me\s+dat(?:en|e)|nga\s+data|data)\s+(\d{1,2})\b/.exec(s);
  if (!m) m = /\b(?:dit(?:en|e))\s+(\d{1,2})\b/.exec(s);
  if (!m) return null;
  return dayOfMonthToISO(Number(m[1]));
}

const BOOKING_CLOSURE_RE = /\b(jo\s+kaq|kaq\s+esht|kjo\s+eshte|that's\s+all|thats\s+all|nothing\s+else|all\s+good|ne\s+rregull|ok\s+faleminderit|faleminderit\s+kaq|vetem\s+kaq)\b/i;

function disambiguateHour(hh, normalizedText) {
  let hour = Number(hh);
  if (!Number.isFinite(hour)) return hour;
  const s = stripAccentsLower(normalizedText);
  const hasPmCue = /\b(pm|pasdites?|mbremje|naten|dark|dinner|evening|night)\b/.test(s);
  const hasAmCue = /\b(am|paradite|mengjes|morning)\b/.test(s);
  if (hasPmCue && !hasAmCue && hour >= 1 && hour <= 11) hour += 12;
  else if (!hasPmCue && !hasAmCue && hour >= 7 && hour <= 11) hour += 12;
  return hour;
}

function parsePartySize(raw) {
  const s = stripAccentsLower(raw);
  const patterns = [
    /\b(?:jemi|ne\s+jemi|for\s+)?(\d{1,2})\s*(?:persona(?:ve)?|person(?:s|en)?|people|guests|veta|te\s+rinj)\b/,
    /\b(\d{1,2})\s*(?:persona(?:ve)?|person(?:s|en)?|people|guests|veta)\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

function parseClockTimeFromText(raw) {
  const text = normalizeTemporal(raw);
  if (!text) return null;
  let mt = /(?:\bat|\bfor|\baround|tek\s+oren|rreth\s+ores|ne\s+oren|\boren)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!mt) {
    const explicit = Array.from(text.matchAll(/(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*(am|pm)\b/gi));
    if (explicit.length) mt = explicit[explicit.length - 1];
  }
  if (!mt) return null;
  const h = mt[1] || mt[3];
  const m = mt[2] || null;
  const ap = (mt[4] || mt[3] || "").toLowerCase();
  let hh = Number(h);
  let mm = Number(m || 0);
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  hh = disambiguateHour(hh, text);
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
    return { hour: hh, minute: mm };
  }
  return null;
}

function dateISOFromTs(ts) {
  const d = new Date(Number(ts || 0) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function findBookingDatetimeInHistory(historyMessages, currentText) {
  const current = parseRequestedDateTime(String(currentText || ""));
  if (current?.dateISO && current?.hour != null) return current;

  const timeOnly = parseClockTimeFromText(String(currentText || ""));

  const userLines = (historyMessages || [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);

  let dateISO = current?.dateISO || null;
  if (!dateISO) {
    for (let i = userLines.length - 1; i >= 0; i--) {
      const parsed = parseRequestedDateTime(userLines[i]);
      if (parsed?.dateISO) {
        dateISO = parsed.dateISO;
        break;
      }
    }
  }

  if (dateISO && (current?.hour != null || timeOnly?.hour != null)) {
    return {
      dateISO,
      hour: current?.hour ?? timeOnly.hour,
      minute: current?.minute ?? timeOnly?.minute ?? 0,
    };
  }

  userLines.push(String(currentText || "").trim());
  for (let i = userLines.length - 1; i >= 0; i--) {
    const parsed = parseRequestedDateTime(userLines[i]);
    if (parsed?.dateISO && parsed.hour != null) return parsed;
  }
  return null;
}

function resolveRescheduleDatetime(phrase, historyMessages, intentData, apptStartTs) {
  const parsed = resolveBookDatetime(phrase, historyMessages, intentData);
  if (parsed?.dateISO && parsed.hour != null) return parsed;
  const timeOnly = parseClockTimeFromText(String(intentData?.datetime || phrase || ""));
  if (timeOnly?.hour == null || !apptStartTs) return parsed;
  return {
    dateISO: dateISOFromTs(apptStartTs),
    hour: timeOnly.hour,
    minute: timeOnly.minute ?? 0,
  };
}

function resolveBookDatetime(phrase, historyMessages, intentData) {
  if (intentData?.datetime) {
    const fromIntent = parseRequestedDateTime(String(intentData.datetime));
    if (fromIntent?.dateISO && fromIntent.hour != null) return fromIntent;
    const intentTime = parseClockTimeFromText(String(intentData.datetime));
    if (intentTime?.hour != null) {
      const merged = findBookingDatetimeInHistory(historyMessages, phrase);
      if (merged?.dateISO) {
        return { dateISO: merged.dateISO, hour: intentTime.hour, minute: intentTime.minute ?? 0 };
      }
    }
  }
  const fromPhrase = parseRequestedDateTime(String(phrase || ""));
  if (fromPhrase?.dateISO && fromPhrase.hour != null) return fromPhrase;
  const merged = findBookingDatetimeInHistory(historyMessages, phrase);
  if (merged) return merged;
  const partySize = parsePartySize(phrase) || Number(intentData?.partySize || intentData?.guests || 0) || null;
  if (partySize) return findBookingDatetimeInHistory(historyMessages, phrase);
  return fromPhrase?.dateISO ? fromPhrase : null;
}

function formatSlotSuggestions(slots, lang, tz) {
  const locale = lang === "sq" ? "sq-AL" : undefined;
  return (slots || []).map((slot) => {
    try {
      return new Date(slot.start).toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz || "UTC",
      });
    } catch {
      return new Date(slot.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
  });
}

function formatBookingDateLabel(dateISO, lang, tz) {
  const locale = lang === "sq" ? "sq-AL" : undefined;
  const ymd = String(dateISO || "").slice(0, 10);
  try {
    return new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString(locale, {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: tz || "UTC",
    });
  } catch {
    return new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
}

function describeTimeOfDay(tod, lang) {
  if (!tod) return null;
  if (lang === "sq") {
    if (tod.startHour >= 17) return "mbremjes";
    if (tod.startHour >= 12) return "pasdites";
    return "mëngjesit";
  }
  if (tod.startHour >= 17) return "evening";
  if (tod.startHour >= 12) return "afternoon";
  return "morning";
}

async function loadThreadHistoryForBooking(userId, from, currentText) {
  try {
    const hist = await listMessagesForThread(userId, from);
    return (Array.isArray(hist) ? hist.slice(-12) : [])
      .map((m) => ({
        role: m.direction === "outbound" ? "assistant" : "user",
        content: String(m.text_body || ""),
      }))
      .filter((h) => h.content && h.content.trim() && h.content.trim() !== String(currentText || "").trim());
  } catch {
    return [];
  }
}

function looksLikeStandaloneName(raw) {
  const s = String(raw || "").trim();
  return /^[A-ZËÇ][a-zëç]+(?:\s+[A-ZËÇ][a-zëç]+){0,2}$/.test(s);
}

function parseBookingReasonFromMessage(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 120) return null;
  if (parseNameFromMessage(s) || looksLikeStandaloneName(s)) return null;
  if (parseRequestedDateTime(s) || parsePartySize(s)) return null;
  if (/^(yes|no|ok|po|jo|faleminderit|thanks|mirë|mire|ne rregull|okej|flm)$/i.test(s)) return null;
  if (/\b(rezerv|termin|orar|book|appointment|pasdite|mengjes|neser|nesër)\b/i.test(stripAccentsLower(s))) return null;
  const re = /\b(?:reason|occasion|because|per|për|ne\s+lidhje\s+me|motivi|rast(?:i)?)\s*(?:is|:|ë?)?\s*(.+)$/i;
  const m = re.exec(s);
  if (m) return m[1].trim().slice(0, 120);
  return null;
}

function findBookingDateInHistory(historyMessages, currentText) {
  const merged = findBookingDatetimeInHistory(historyMessages, currentText);
  if (merged?.dateISO) return merged.dateISO;
  const fromCurrent = parseDateOnly(String(currentText || ""));
  if (fromCurrent) return fromCurrent;
  const userLines = (historyMessages || [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  for (let i = userLines.length - 1; i >= 0; i--) {
    const d = parseDateOnly(userLines[i]);
    if (d) return d;
  }
  return null;
}

function resolvePartySizeFromBookingContext(text, historyMessages, intentData = {}) {
  const direct = parsePartySize(text) || Number(intentData?.partySize || intentData?.guests || 0) || null;
  if (direct) return direct;

  for (const m of [...(historyMessages || [])].reverse()) {
    if (m?.role === "assistant") {
      const ac = stripAccentsLower(String(m.content || ""));
      if (/\b(ref #|numri i referenc|u krye|all set|gjithcka u krye|booking confirmed)\b/.test(ac)) break;
      continue;
    }
    if (m?.role !== "user") continue;
    const c = String(m.content || "").trim();
    if (!c) continue;
    if (/\b(rezervim\s+te\s+ri|new\s+reservation|another\s+booking)\b/.test(stripAccentsLower(c))) break;
    const p = parsePartySize(c);
    if (p) return p;
  }
  return null;
}

function buildBookingNotesFromConversation({ text, historyMessages, intentData, knownCustomerName }) {
  let name = String(intentData?.name || intentData?.customerName || "").trim() || parseNameFromMessage(text) || String(knownCustomerName || "").trim() || null;
  const partySize = resolvePartySizeFromBookingContext(text, historyMessages, intentData);

  for (const m of [...(historyMessages || [])].reverse()) {
    if (m?.role !== "user") continue;
    const c = String(m.content || "").trim();
    if (!c) continue;
    if (!name) name = parseNameFromMessage(c) || (looksLikeStandaloneName(c) ? c : null);
  }

  const notesParts = [];
  if (name) notesParts.push(`Name: ${String(name).slice(0, 80)}`);
  if (partySize) notesParts.push(`Party size: ${partySize}`);
  return { notes: notesParts.join(" | "), name, partySize };
}

function getPublicBaseUrl(req) {
  if (req?.protocol && typeof req.get === "function" && req.get("host")) {
    return `${req.protocol}://${req.get("host")}`;
  }
  return String(process.env.PUBLIC_BASE_URL || process.env.WEBHOOK_BASE_URL || "").trim().replace(/\/$/, "");
}

async function attemptBookFromRequest({
  userId, from, staff, phrase, historyMessages, intentData, cfg, knownCustomerName,
}) {
  const details = buildBookingNotesFromConversation({
    text: phrase,
    historyMessages,
    intentData,
    knownCustomerName,
  });
  const parsed = resolveBookDatetime(String(intentData?.datetime || phrase), historyMessages, intentData);
  if (!parsed?.dateISO || parsed.hour == null) return { status: "unparsed" };

  const notes = details.notes;

  const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
  const start = buildUtcFromLocalWallTime(parsed.dateISO, parsed.hour, parsed.minute || 0, staff.timezone || "UTC");
  const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
  if (start.getTime() < Date.now() + minLeadMs) return { status: "past" };

  const durationMin = Number(staff.slot_minutes || 30);
  const avail = await listAvailability({
    userId,
    staffId: String(staff._id),
    dateISO: base.toISOString(),
    days: 1,
    slotMinutes: durationMin,
  });
  const nowCutoff = Date.now() + minLeadMs;
  const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(
    (s) => new Date(s.start).getTime() >= nowCutoff
  );
  const toleranceMs = Math.max(120000, Math.floor(durationMin * 60000 / 2));
  const scored = slots.map((s) => ({
    slot: s,
    diff: Math.abs(new Date(s.start).getTime() - start.getTime()),
  }));
  scored.sort((a, b) => a.diff - b.diff);
  const match = scored.find((x) => x.diff <= toleranceMs)?.slot || null;

  if (!match) {
    return { status: "no_slot", suggestions: scored.slice(0, 3).map((x) => x.slot) };
  }

  try {
    const fromDigits = String(from || "").replace(/\D/g, "");
    const existing = fromDigits
      ? await findUpcomingConfirmedAppointment({ userId, digits: fromDigits })
      : null;
    if (existing?.start_ts) {
      const diffMs = Math.abs(existing.start_ts * 1000 - new Date(match.start).getTime());
      if (diffMs <= toleranceMs) {
        const refId = resolveAppointmentRefId(existing) || await ensureAppointmentLegacyId(existing, userId);
        const when = new Date(match.start).toLocaleString(cfg?.__lang === "sq" ? "sq-AL" : undefined, {
          timeZone: staff.timezone || "UTC",
          dateStyle: "medium",
          timeStyle: "short",
        });
        return {
          status: "already_booked",
          booking: { id: refId },
          match,
          when,
          ...details,
        };
      }
    }

    const r = await createBooking({
      userId,
      staffId: String(staff._id),
      startISO: match.start,
      endISO: match.end,
      contactPhone: from,
      notes,
    });
    const when = new Date(match.start).toLocaleString(cfg?.__lang === "sq" ? "sq-AL" : undefined, {
      timeZone: staff.timezone || "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    });
    try {
      await getDB().collection("booking_sessions").deleteOne({ user_id: String(userId), contact_id: String(from) });
    } catch {}
    return { status: "booked", booking: r, match, when, ...details };
  } catch (err) {
    console.error("[book-request]", err?.message || err);
    return { status: "error" };
  }
}

function conversationHasBookableDetails(historyMessages, currentText, intentData = {}) {
  const parsed = resolveBookDatetime(String(intentData?.datetime || currentText || ""), historyMessages, intentData);
  if (!parsed?.dateISO || parsed.hour == null) return false;
  const party = parsePartySize(currentText)
    || Number(intentData?.partySize || intentData?.guests || 0)
    || null;
  if (party) return true;
  for (const m of [...(historyMessages || [])].reverse()) {
    if (m?.role !== "user") continue;
    if (parsePartySize(m.content)) return true;
  }
  return false;
}

function isPureBookingAcknowledgement(text) {
  const sq = stripAccentsLower(String(text || "")).trim();
  if (!sq) return false;
  if (/\b(rezerv|book|termin|anul|ndrysh|provoj|ribej|perseri|again|retry|ndrysho)\b/.test(sq)) return false;
  return /^(faleminderit|flm|thanks|thank you|ok|okej|ne rregull|super|mir|perfect|great|shume faleminderit)([!.?\s]+.*)?$/i.test(sq)
    || (/\b(faleminderit|flm|thanks)\b/.test(sq) && sq.split(/\s+/).length <= 3);
}

function parseRequestedDateTime(raw) {
  const text = normalizeTemporal(raw);
  const now = new Date();
  const out = { dateISO: null, hour: null, minute: null };
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (/\bday after tomorrow\b/.test(text)) {
    const d = new Date(Date.now() + 2 * 86400000);
    out.dateISO = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  } else if (/\b(today)\b/.test(text)) {
    const d = new Date();
    out.dateISO = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  } else if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) {
    const d = new Date(Date.now() + 86400000);
    out.dateISO = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  } else {
    const mWeek = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
    if (mWeek) {
      const target = weekdays.indexOf(mWeek[1]);
      let d = new Date();
      const delta = ((7 - d.getDay()) + target) % 7 || 7;
      d = new Date(d.getTime() + delta*86400000);
      out.dateISO = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    } else {
      const mDay = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
      if (mDay) {
        const target = weekdays.indexOf(mDay[1]);
        const d = new Date();
        const delta = ((target - d.getDay()) + 7) % 7 || 7;
        const nd = new Date(d.getTime() + delta*86400000);
        out.dateISO = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth()+1).padStart(2,'0')}-${String(nd.getUTCDate()).padStart(2,'0')}`;
      }
    }
  }
  if (!out.dateISO) {
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const mm = new RegExp(`\\b(${months.map(m=>m.slice(0,3)).join('|')}|${months.join('|')})\\.?,?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`);
    const m = mm.exec(text);
    if (m) {
      const monStr = m[1];
      const day = Number(m[2]);
      const yr = Number(m[3] || now.getUTCFullYear());
      const monIdx = months.findIndex(x => monStr.startsWith(x.slice(0,3)));
      if (monIdx >= 0 && day >= 1 && day <= 31) {
        out.dateISO = `${yr}-${String(monIdx+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
    }
  }
  if (!out.dateISO) {
    let m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (m) {
      out.dateISO = `${m[1]}-${m[2]}-${m[3]}`;
    } else {
      m = /(\b\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/.exec(text);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = m[3] ? Number(m[3]) : now.getUTCFullYear();
        const mm = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? b : a;
        const dd = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? a : b;
        const yr = c < 100 ? (2000 + c) : c;
        out.dateISO = `${yr}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      }
    }
  }
  if (!out.dateISO) {
    out.dateISO = parseDayOfMonthFromText(text);
  }
  let mt = /(?:\bat|\bfor|\baround)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  let matchedByKeyword = !!mt;
  if (!mt) {
    const explicit = Array.from(text.matchAll(/(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*(am|pm)\b/gi));
    if (explicit.length) {
      mt = explicit[explicit.length - 1];
      matchedByKeyword = false;
    }
  }
  if (mt) {
    const h = mt[1] || mt[3];
    const m = mt[2] || null;
    const ap = (mt[4] || mt[3] || '').toLowerCase();
    let hh = Number(h);
    let mm = Number(m || 0);
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    hh = disambiguateHour(hh, text);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      out.hour = hh; out.minute = mm;
    }
  }

  if (!out.dateISO || out.hour == null) return null;
  return out;
}
function parseDateOnly(raw) {
  const text = normalizeTemporal(raw);
  const now = new Date();
  if (/\bday after tomorrow\b/.test(text)) {
    const d = new Date(Date.now() + 2 * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  if (/\btoday\b/.test(text)) {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) {
    const d = new Date(Date.now()+86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const mm = new RegExp(`\\b(${months.map(m=>m.slice(0,3)).join('|')}|${months.join('|')})\\.?,?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`);
  let m = mm.exec(text);
  if (m) {
    const monStr = m[1];
    const day = Number(m[2]);
    const yr = Number(m[3] || now.getUTCFullYear());
    const monIdx = months.findIndex(x => monStr.startsWith(x.slice(0,3)));
    if (monIdx >= 0 && day >= 1 && day <= 31) {
      return `${yr}-${String(monIdx+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\b\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/.exec(text);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]); const c = m[3] ? Number(m[3]) : now.getUTCFullYear();
    const mm2 = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? b : a;
    const dd2 = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? a : b;
    const yr = c < 100 ? (2000 + c) : c;
    return `${yr}-${String(mm2).padStart(2,'0')}-${String(dd2).padStart(2,'0')}`;
  }
  return parseDayOfMonthFromText(text);
}

function parseDateRange(raw) {
  const s = normalizeTemporal(raw);
  const todayISO = (()=>{ const d=new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; })();
  let m = /next\s+(\d{1,2})\s+day(s)?/.exec(s);
  if (m) { const n = Math.max(1, Number(m[1]||1)); return { startISO: todayISO, days: Math.min(30, n) }; }
  if (/\bthis\s+week\b/.test(s)) {
    const now = new Date();
    const wd = now.getUTCDay();    const remain = 7 - wd;
    return { startISO: todayISO, days: Math.max(1, remain) };
  }
  if (/\bnext\s+week\b/.test(s)) {
    const d = new Date();
    const delta = ((8 - d.getUTCDay()) % 7) || 7;    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()+delta));
    return { startISO: `${start.getUTCFullYear()}-${String(start.getUTCMonth()+1).padStart(2,'0')}-${String(start.getUTCDate()).padStart(2,'0')}`, days: 7 };
  }
  m = /(?:between|from)\s+([\w\s\/.\-]+?)\s+(?:and|to|-)\s+([\w\s\/.\-]+)/.exec(s);
  if (m) {
    const a = parseDateOnly(m[1]);
    const b = parseDateOnly(m[2]);
    if (a && b) {
      const start = new Date(`${a}T00:00:00.000Z`);
      const end = new Date(`${b}T00:00:00.000Z`);
      const days = Math.max(1, Math.min(30, Math.floor((end - start)/86400000) + 1));
      return { startISO: a, days };
    }
  }
  const single = parseDateOnly(s);
  if (single) return { startISO: single, days: 1 };
  return null;
}

function parseTimeOfDayFilter(raw) {
  const s = normalizeTemporal(raw);
  const hasClockTime = /\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(s);
  if (/\bmorning\b/.test(s) || /\bparadite\b/.test(s) || /\bmengjes/.test(s) || (!hasClockTime && /\bam\b/.test(s))) return { startHour: 6, endHour: 12 };
  if (/\bafternoon\b/.test(s) || /\bpasdite\b/.test(s)) return { startHour: 12, endHour: 17 };
  if (/\bevening\b|\bnight\b|\bdinner\b/.test(s) || /\bmbremje/.test(s) || /\bdark/.test(s) || /\bnaten?\b/.test(s)) return { startHour: 17, endHour: 23 };
  return null;
}

function parseNameFromMessage(raw) {
  try {
    const s = String(raw || '').trim();
    const nameChars = "[a-zA-ZëçËÇ][a-zA-ZëçËÇ'\\-]+(?:\\s+[a-zA-ZëçËÇ][a-zA-ZëçËÇ'\\-]+){0,2}";
    // English + Albanian openers: "emri im është X", "unë jam X", "quhem X", "jam X".
    const re = new RegExp(`(my\\s+name\\s+is|i\\s*am|i'm|im|emri\\s+im\\s+(?:eshte|është)|une\\s+jam|unë\\s+jam|quhem|jam)\\s+(${nameChars})`, 'i');
    const m = re.exec(s);
    if (m) {
      const name = m[2].replace(/\s+/g,' ').trim();
      const titled = name.split(' ').map(w => w.slice(0,1).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
      return titled;
    }
  } catch {}
  return null;
}

function hasSubstantiveRequest(raw) {
  try {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return false;
    const pureGreeting = isGreeting(s) && /^(hi|hello|hey|yo|hiya|howdy|greetings|good\s+(morning|afternoon|evening))\b/.test(s) && s.split(/\s+/).length <= 3;
    if (pureGreeting) return false;
    if (s.includes('?')) return true;
    if (SUBSTANTIVE_INTENT_RE.test(s)) return true;
    if (/(rezervo|rezervim|termin|takim|cakto|anulo|ndrysho|disponueshmeri|cmim|kushton|porosi|sherbim|orar|adres|ndihme|njeri|agjent)/.test(stripAccentsLower(s))) return true;
    if (/(\d{1,2}[:.][0-5]\d\s*(am|pm)?|\b\d{1,2}\s*(am|pm)\b|today|tomorrow|next\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\b\d+\b)/i.test(s)) return true;
    const wc = s.split(/\s+/).filter(Boolean).length;
    return wc >= 3 || s.length >= 15;
  } catch { return false; }
}

function digitsOnly(value) {
  try {
    return String(value || '').replace(/\D/g, '');
  } catch {
    return '';
  }
}

async function findUpcomingConfirmedAppointment({ userId, digits, projection } = {}) {
  const userIdStr = String(userId || '').trim();
  const contactDigits = digits ? digitsOnly(digits) : '';
  if (!userIdStr || !contactDigits) return null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const dbNative = getDB();
    const rows = await dbNative.collection('appointments')
      .find({
        user_id: userIdStr,
        status: 'confirmed',
        $or: [
          { contact_phone: contactDigits },
          { contact_phone: '+' + contactDigits }
        ],
        start_ts: { $gte: nowSec }
      })
      .project(projection || { id: 1, start_ts: 1, staff_id: 1, _id: 1 })
      .sort({ start_ts: 1 })
      .limit(1)
      .toArray();
    const row = rows[0] || null;
    if (row) await ensureAppointmentLegacyId(row, userIdStr);
    return row;
  } catch {
    return null;
  }
}
const memEscalation = new Map();
const memTenant = new Map();
const memStatus = new Map();
  const memSpam = new Map();function memKey(userId, contact) {
  return `${String(userId || '')}:${String(contact || '')}`;
}
const memProgress = new Map();const memEscalationHold = new Map();async function getMemSession(userId, contact) {
  const key = memKey(userId, contact);
  try {
    if (isRedisConnected()) {
      const redis = getRedisClient();
      const rkey = `esc:${key}`;
      const raw = await redis.get(rkey);
      if (!raw) return { key, rec: null };
      try { return { key, rec: JSON.parse(raw) || null }; } catch { return { key, rec: null }; }
    }
  } catch {}
  const rec = memEscalation.get(key) || null;
  const now = Date.now();
  if (rec && rec.expires > now) return { key, rec };
  if (rec) memEscalation.delete(key);
  return { key, rec: null };
}
async function setMemSession(userId, contact, data, ttlMs = 30*60*1000) {
  const key = memKey(userId, contact);
  try {
    if (isRedisConnected()) {
      const redis = getRedisClient();
      const rkey = `esc:${key}`;
      await redis.set(rkey, JSON.stringify(data), 'PX', Math.max(1000, Number(ttlMs)||0));
      return;
    }
  } catch {}
  const now = Date.now();
  memEscalation.set(key, { ...data, expires: now + ttlMs });
}

async function cachedFindSettingsByPhoneNumberId(pnid) {
  if (!pnid) return null;
  const ttlMs = Number(process.env.TENANT_CACHE_TTL_MS || 30000);
  try {
    if (isRedisConnected()) {
      const redis = getRedisClient();
      const key = `tenant:pnid:${pnid}`;
      const hit = await redis.get(key);
      if (hit) { try { return JSON.parse(hit); } catch { return null; } }
      const val = await findSettingsByPhoneNumberId(pnid);
      if (val) { try { await redis.set(key, JSON.stringify(val), 'PX', Math.max(1000, ttlMs)); } catch {} }
      return val || null;
    }
  } catch {}
  const now = Date.now();
  const k = `pnid:${pnid}`;
  const rec = memTenant.get(k);
  if (rec && rec.expires > now) return rec.val;
  const val = await findSettingsByPhoneNumberId(pnid);
  memTenant.set(k, { val: val || null, expires: now + ttlMs });
  return val || null;
}

async function cachedFindSettingsByBusinessPhone(digits) {
  if (!digits) return null;
  const ttlMs = Number(process.env.TENANT_CACHE_TTL_MS || 30000);
  try {
    if (isRedisConnected()) {
      const redis = getRedisClient();
      const key = `tenant:phone:${digits}`;
      const hit = await redis.get(key);
      if (hit) { try { return JSON.parse(hit); } catch { return null; } }
      const val = await findSettingsByBusinessPhone(digits);
      if (val) { try { await redis.set(key, JSON.stringify(val), 'PX', Math.max(1000, ttlMs)); } catch {} }
      return val || null;
    }
  } catch {}
  const now = Date.now();
  const k = `phone:${digits}`;
  const rec = memTenant.get(k);
  if (rec && rec.expires > now) return rec.val;
  const val = await findSettingsByBusinessPhone(digits);
  memTenant.set(k, { val: val || null, expires: now + ttlMs });
  return val || null;
}

export default function registerWebhookRoutes(app) {
  const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
  function maskPhone(p) {
    try {
      const d = digitsOnly(p);
      if (d.length <= 4) return '***';
      return d.slice(0,2) + '******' + d.slice(-2);
    } catch { return '***'; }
  }
  const rateWindowMs = Number(process.env.WEBHOOK_RATE_WINDOW_MS || 15_000);
  const maxHits = Number(process.env.WEBHOOK_RATE_MAX || 60);
  const hits = new Map();  const rateLimit = async (req, res, next) => {
    try {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
      if (isRedisConnected()) {
        const redis = getRedisClient();
        const key = `rate:ip:${ip}`;
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, Math.max(1000, rateWindowMs));
        }
        if (count > maxHits) {
          res.setHeader('Retry-After', Math.ceil(rateWindowMs/1000));
          return res.status(429).send('Too Many Requests');
        }
      } else {
      const now = Date.now();
      const rec = hits.get(ip) || { count: 0, ts: now };
        if (now - rec.ts > rateWindowMs) { rec.count = 0; rec.ts = now; }
      rec.count += 1;
      hits.set(ip, rec);
      if (rec.count > maxHits) {
        return res.status(429).send('Too Many Requests');
        }
      }
    } catch {}
    next();
  };
  async function getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg) {
    const tenant = cfg;
    try {
      const s = await getDB().collection('staff')
        .find({ user_id: String(tenantUserId) })
        .project({ _id: 1, slot_minutes: 1, timezone: 1, working_hours_json: 1 })
        .sort({ createdAt: 1 })
        .limit(1)
        .toArray();
      let staff = s[0] || null;
      if (!staff) {
        try {
          const row = await Staff.findOne({ user_id: String(tenantUserId) }).select('_id slot_minutes timezone working_hours_json').lean();
          if (row) staff = { _id: row._id, slot_minutes: row.slot_minutes, timezone: row.timezone, working_hours_json: row.working_hours_json };
        } catch {}
      }
      if (!staff) {
        const n = await generateAssistantNudge('no_staff', {}, aiOpts(tenant));
        await sendTextTracked(from, n || "Bookings are enabled, but no staff is configured yet.", cfg);
        return null;
      }
      return staff;
    } catch {
      const n = await generateAssistantNudge('no_staff', {}, aiOpts(tenant));
      await sendTextTracked(from, n || "Bookings are enabled, but no staff is configured yet.", cfg);
      return null;
    }
  }

  async function sendDayPicker(from, staffId, apptId, cfg, header = null, body = null) {
    const days = buildDayRows(staffId, apptId);
    const h = header || tr(apptId ? 'pick_new_day_header' : 'pick_day_header', cfg?.__lang);
    const b = body || tr('choose_date', cfg?.__lang);
    await sendListTracked(from, h, b, tr('select_button', cfg?.__lang), days, cfg);
  }

  async function notifyTooClose(from, minLead, cfg) {
    const tenant = cfg;
    const n = await generateAssistantNudge('too_close', { minLead }, aiOpts(tenant));
    await sendTextTracked(from, n || `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
  }
  async function sendDayAvailabilityText({ from, tenantUserId, staffId, startISODate, tod, cfg, staff, skipIntro = false, limit = 8 }) {
    const lang = cfg?.__lang || "en";
    const tz = staff?.timezone || "UTC";
    const dateLabel = formatBookingDateLabel(startISODate, lang, tz);
    const period = describeTimeOfDay(tod, lang);
    const avail = await listAvailability({ userId: tenantUserId, staffId: String(staffId), dateISO: startISODate, days: 1 });
    let slots = Array.isArray(avail) ? (avail[0]?.slots || []) : [];
    const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
    slots = slots.filter((s) => new Date(s.start).getTime() >= Date.now() + minLeadMs);
    if (tod) slots = filterSlotsByTimeOfDay(slots, tod, tz);
    const times = formatSlotSuggestions(slots.slice(0, limit), lang, tz);
    if (!times.length) {
      const n = await generateAssistantNudge("no_times", { date: dateLabel, period }, aiOpts(cfg));
      await sendTextTracked(from, n || tr("no_times", lang), cfg);
      return false;
    }
    const intro = await generateAssistantNudge("availability_offer", { date: dateLabel, period, count: times.length }, aiOpts(cfg));
    if (intro && !skipIntro) await sendTextTracked(from, intro, cfg);
    const body = `${tr("available_times_header", lang)}\n${dateLabel}: ${times.join(", ")}\n\n${tr("type_preferred_time", lang)}`;
    await sendTextTracked(from, body.slice(0, 900), cfg);
    return true;
  }

  async function sendAvailabilityRange({ from, tenantUserId, staffId, startISODate, days, tod, cfg, bodyLabel = null, staff = null, skipIntro = false }) {
    try {
      const lang = cfg?.__lang || "en";
      const tz = staff?.timezone || "UTC";
      const effectiveDays = Math.min(14, Math.max(1, Number(days || 1)));
      const dateLabel = formatBookingDateLabel(startISODate, lang, tz);
      const period = describeTimeOfDay(tod, lang);

      if (effectiveDays === 1) {
        await sendDayAvailabilityText({ from, tenantUserId, staffId, startISODate, tod, cfg, staff, skipIntro });
        return;
      }

      const avail = await listAvailability({ userId: tenantUserId, staffId: String(staffId), dateISO: startISODate, days: effectiveDays });
      const lines = [];
      const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
      const cutoff = Date.now() + minLeadMs;
      const locale = lang === "sq" ? "sq-AL" : undefined;
      for (const day of (avail || [])) {
        let slots = day.slots || [];
        slots = slots.filter((s) => new Date(s.start).getTime() >= cutoff);
        if (tod) slots = filterSlotsByTimeOfDay(slots, tod, tz);
        const times = slots
          .slice(0, 6)
          .map((s) => new Date(s.start).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone: tz }));
        if (times.length) {
          lines.push(`${formatBookingDateLabel(`${day.date}T00:00:00.000Z`, lang, tz)}: ${times.join(", ")}`);
        }
      }
      if (lines.length) {
        const intro = await generateAssistantNudge("availability_offer", { period, count: lines.length }, aiOpts(cfg));
        if (intro && !skipIntro) await sendTextTracked(from, intro, cfg);
        await sendTextTracked(from, `${tr("available_times_header", lang)}\n${lines.join("\n")}\n\n${tr("type_preferred_time", lang)}`.slice(0, 900), cfg);
      } else {
        const n = await generateAssistantNudge("no_times", { period }, aiOpts(cfg));
        await sendTextTracked(from, n || tr("no_times", lang), cfg);
      }
    } catch {}
  }

  async function tryFinalizeBookingFromContext({
    tenantUserId, from, fromDigits, text, historyMessages, intentData, cfg, tenant, req, knownCustomerName,
  }) {
    if (!cfg?.bookings_enabled) return null;
    if (!conversationHasBookableDetails(historyMessages, text, intentData || {})) return null;

    const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
    if (!staff) return { handled: true };

    const bookResult = await attemptBookFromRequest({
      userId: tenantUserId,
      from,
      staff,
      phrase: text,
      historyMessages,
      intentData: intentData || {},
      cfg,
      knownCustomerName,
    });

    if (bookResult.status === "booked") {
      if (bookResult.partySize) {
        try { await rememberPartySize(tenantUserId, from, bookResult.partySize); } catch {}
      }
      await sendOrganicBookingConfirmation({
        req,
        tenantUserId,
        from,
        cfg,
        tenant,
        staff,
        startISO: bookResult.match.start,
        endISO: bookResult.match.end,
        bookingId: bookResult.booking.id,
        when: bookResult.when,
        details: bookResult,
      });
      return { handled: true, booked: true };
    }
    if (bookResult.status === "already_booked") {
      return { handled: true, booked: false };
    }
    if (bookResult.status === "no_slot" && bookResult.suggestions?.length) {
      const suggestions = formatSlotSuggestions(bookResult.suggestions, cfg?.__lang, staff.timezone);
      await sendTextTracked(from, tr("closest_times", cfg?.__lang, { suggestions }), cfg);
      return { handled: true };
    }
    if (bookResult.status === "past") {
      await sendTextTracked(from, tr("past_time_warning", cfg?.__lang), cfg);
      return { handled: true };
    }
    if (bookResult.status === "error") {
      await sendTextTracked(from, tr("slot_book_failed", cfg?.__lang), cfg);
      return { handled: true };
    }
    return null;
  }

  async function completeCancellation({ tenantUserId, from, apptId, apptOid, cfg, sessionId, fromDigits }) {
    const minLead = Number(cfg.cancel_min_lead_minutes || 60);
    const dbNative = getDB();
    let row = await findAppointmentForUser({
      userId: tenantUserId,
      appointmentId: apptId,
      mongoId: apptOid,
    });
    if (!row && fromDigits) {
      row = await findUpcomingConfirmedAppointment({ userId: tenantUserId, digits: fromDigits });
      if (row) {
        apptOid = row._id;
        apptId = resolveAppointmentRefId(row) || await ensureAppointmentLegacyId(row, tenantUserId);
      }
    }
    if (!row || row.status !== "confirmed") {
      await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
      if (sessionId) await dbNative.collection("booking_sessions").deleteOne({ _id: sessionId });
      return false;
    }
    const refId = resolveAppointmentRefId(row) || await ensureAppointmentLegacyId(row, tenantUserId);
    const minsToStart = Math.floor(((row.start_ts || 0) - Math.floor(Date.now() / 1000)) / 60);
    if (minsToStart < minLead) {
      await notifyTooClose(from, minLead, cfg);
      if (sessionId) await dbNative.collection("booking_sessions").deleteOne({ _id: sessionId });
      return false;
    }
    await cancelBooking({ userId: tenantUserId, appointmentId: refId, mongoId: row._id });
    await sendTextTracked(from, tr("canceled", cfg?.__lang, { ref: refId }), cfg);
    if (row?.staff_id && row?.start_ts) {
      await notifyWaitlistForNewAvailability({ tenantUserId, staffId: row.staff_id, startTs: row.start_ts, cfg });
    }
    if (sessionId) {
      await dbNative.collection("booking_sessions").deleteOne({ _id: sessionId });
    } else {
      await dbNative.collection("booking_sessions").deleteOne({
        user_id: String(tenantUserId),
        contact_id: String(from),
        step: "awaiting_cancel_confirm",
      });
    }
    return true;
  }

  async function handleStructuredBookingSession({ tenantUserId, from, text, cfg, fromDigits }) {
    if (!tenantUserId || !text) return false;
    try {
      const dbNative = getDB();
      const sess = await dbNative.collection("booking_sessions").findOne({
        user_id: String(tenantUserId),
        contact_id: String(from),
        step: { $in: ["awaiting_cancel_confirm", "awaiting_reschedule_dt"] },
      });
      if (!sess) return false;

      try {
        const langMem = await getContactMemory(tenantUserId, from);
        const effectiveLang = resolveLanguage(text, langMem?.lang, sess.lang);
        if (cfg) cfg.__lang = effectiveLang;
      } catch {}

      if (sess.step === "awaiting_cancel_confirm") {
        let apptOid = sess.appt_oid || null;
        let apptId = resolveAppointmentRefId({ id: sess.appt_id })
          || (Number.isFinite(Number(sess.appt_id)) && Number(sess.appt_id) > 0 ? Number(sess.appt_id) : null);
        if (!apptOid && !apptId) {
          const upcoming = await findUpcomingConfirmedAppointment({ userId: tenantUserId, digits: fromDigits });
          if (upcoming) {
            apptOid = upcoming._id;
            apptId = resolveAppointmentRefId(upcoming) || await ensureAppointmentLegacyId(upcoming, tenantUserId);
            await dbNative.collection("booking_sessions").updateOne(
              { _id: sess._id },
              { $set: { appt_id: apptId, appt_oid: apptOid } }
            );
          }
        }
        if (!apptOid && !apptId) {
          await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
          await dbNative.collection("booking_sessions").deleteOne({ _id: sess._id });
          return true;
        }
        const refId = apptId || resolveAppointmentRefId({ id: sess.appt_id });
        if (isCancelAbort(text)) {
          await sendTextTracked(from, tr("cancel_aborted", cfg?.__lang), cfg);
          await dbNative.collection("booking_sessions").deleteOne({ _id: sess._id });
          return true;
        }
        if (!isCancelConfirmation(text)) {
          const displayRef = refId || "";
          await sendTextTracked(from, tr("cancel_confirm_instructions", cfg?.__lang, { ref: displayRef }), cfg);
          return true;
        }
        await completeCancellation({
          tenantUserId,
          from,
          apptId: refId,
          apptOid,
          cfg,
          sessionId: sess._id,
          fromDigits,
        });
        return true;
      }

      if (sess.step === "awaiting_reschedule_dt" && (sess.appt_id || sess.appt_oid)) {
        const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
        if (!staff) return true;
        const hist = await loadThreadHistoryForBooking(tenantUserId, from, text);
        const apptRow = await findAppointmentForUser({
          userId: tenantUserId,
          appointmentId: sess.appt_id,
          mongoId: sess.appt_oid,
        });
        const parsed = resolveRescheduleDatetime(text, hist, {}, apptRow?.start_ts);
        if (!parsed?.dateISO || parsed.hour == null) {
          const n = await generateAssistantNudge("ask_datetime", { examples: ["tomorrow 9pm", "nesër ora 21:00"] }, aiOpts(cfg));
          await sendTextTracked(from, n || tr("ask_datetime", cfg?.__lang), cfg);
          return true;
        }

        const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
        const start = buildUtcFromLocalWallTime(parsed.dateISO, parsed.hour, parsed.minute || 0, staff.timezone || "UTC");
        const durationMin = Number(sess.service_minutes || staff.slot_minutes || 30);
        const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
        if (start.getTime() < Date.now() + minLeadMs) {
          await sendTextTracked(from, tr("past_time_warning", cfg?.__lang), cfg);
          return true;
        }
        const avail = await listAvailability({
          userId: tenantUserId,
          staffId: String(staff._id),
          dateISO: base.toISOString(),
          days: 1,
          slotMinutes: durationMin,
        });
        const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(
          (s) => new Date(s.start).getTime() >= Date.now() + minLeadMs
        );
        const toleranceMs = Math.max(120000, Math.floor(durationMin * 60000 / 2));
        const scored = slots.map((s) => ({
          slot: s,
          diff: Math.abs(new Date(s.start).getTime() - start.getTime()),
        }));
        scored.sort((a, b) => a.diff - b.diff);
        const match = scored.find((x) => x.diff <= toleranceMs)?.slot;
        if (!match) {
          const suggestions = formatSlotSuggestions(
            scored.slice(0, 3).map((x) => x.slot),
            cfg?.__lang,
            staff.timezone
          );
          await sendTextTracked(from, tr("closest_times", cfg?.__lang, { suggestions }), cfg);
          return true;
        }
        const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
        const minsToStart = apptRow ? Math.floor(((apptRow.start_ts || 0) - Math.floor(Date.now() / 1000)) / 60) : 99999;
        if (minsToStart < minLead) {
          await notifyTooClose(from, minLead, cfg);
          return true;
        }
        try {
          const apptRefId = resolveAppointmentRefId(apptRow) || await ensureAppointmentLegacyId(apptRow, tenantUserId);
          await rescheduleBooking({
            userId: tenantUserId,
            appointmentId: apptRefId,
            mongoId: apptRow?._id,
            startISO: match.start,
            endISO: match.end,
          });
        } catch (err) {
          console.error("[reschedule-session]", err?.message || err);
          await sendTextTracked(from, tr("slot_book_failed", cfg?.__lang), cfg);
          return true;
        }
        const locale = cfg?.__lang === "sq" ? "sq-AL" : undefined;
        const when = new Date(match.start).toLocaleString(locale, {
          timeZone: staff.timezone || "UTC",
          dateStyle: "medium",
          timeStyle: "short",
        });
        const refId = resolveAppointmentRefId(apptRow) || sess.appt_id;
        await sendTextTracked(from, tr("rescheduled", cfg?.__lang, { when, ref: refId }), cfg);
        await dbNative.collection("booking_sessions").deleteOne({ _id: sess._id });
        return true;
      }
    } catch (err) {
      console.error("[booking-session]", err?.message || err);
    }
    return false;
  }

  async function executeAgentIntent({
    intentType,
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
  }) {
    if (!intentType || intentType === "none") return false;

    if (intentType === "availability" && cfg?.bookings_enabled) {
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return true;
      const availabilityPhrase = [text, intentData?.datetime, intentData?.range].filter(Boolean).join(" ");
      if (!isExplicitAvailabilityRequest(availabilityPhrase)) {
        if (!replyText) {
          const n = await generateAssistantNudge("ask_specific_time", {}, aiOpts(tenant));
          await sendTextTracked(from, n || tr("ask_specific_time", cfg?.__lang), cfg);
        }
        return true;
      }
      const resolved = resolveBookDatetime(String(intentData.datetime || text), historyMessages, intentData);
      if (resolved?.dateISO && resolved?.hour != null) {
        return executeAgentIntent({
          intentType: "book",
          intentData: { ...intentData, datetime: String(intentData.datetime || text) },
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
        });
      }
      let range = null;
      if (intentData.startDate) {
        range = { startISO: String(intentData.startDate), days: Math.min(30, Math.max(1, Number(intentData.days || 1))) };
      } else {
        range = parseDateRange(String(intentData.range || intentData.datetime || text));
      }
      const tod = (() => {
        const t = String(intentData.timeOfDay || "");
        if (/morning/i.test(t)) return { startHour: 6, endHour: 12 };
        if (/afternoon/i.test(t)) return { startHour: 12, endHour: 17 };
        if (/evening|night/i.test(t)) return { startHour: 17, endHour: 23 };
        return parseTimeOfDayFilter(String(intentData.datetime || text));
      })();
      if (range) {
        const days = Math.min(14, Math.max(1, range.days || 1));
        const startISODate = `${range.startISO}T00:00:00.000Z`;
        await sendAvailabilityRange({
          from,
          tenantUserId,
          staffId: String(staff._id),
          startISODate,
          days,
          tod,
          cfg,
          staff,
          skipIntro: !!replyText,
        });
      }
      return true;
    }

    if (intentType === "book" && cfg?.bookings_enabled) {
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return true;
      const bookResult = await attemptBookFromRequest({
        userId: tenantUserId,
        from,
        staff,
        phrase: text,
        historyMessages,
        intentData,
        cfg,
        knownCustomerName,
      });
      if (bookResult.status === "booked") {
        if (bookResult.partySize) {
          try { await rememberPartySize(tenantUserId, from, bookResult.partySize); } catch {}
        }
        await sendOrganicBookingConfirmation({
          req,
          tenantUserId,
          from,
          cfg,
          tenant,
          staff,
          startISO: bookResult.match.start,
          endISO: bookResult.match.end,
          bookingId: bookResult.booking.id,
          when: bookResult.when,
          details: bookResult,
        });
        return true;
      }
      if (bookResult.status === "already_booked") {
        return true;
      }
      if (bookResult.status === "no_slot" && bookResult.suggestions?.length) {
        const suggestions = formatSlotSuggestions(bookResult.suggestions, cfg?.__lang, staff.timezone);
        if (!replyText) {
          await sendTextTracked(from, tr("closest_times", cfg?.__lang, { suggestions }), cfg);
        }
        return true;
      }
      if (bookResult.status === "past") {
        if (!replyText) await sendTextTracked(from, tr("past_time_warning", cfg?.__lang), cfg);
        return true;
      }
      if (bookResult.status === "error") {
        await sendTextTracked(from, tr("slot_book_failed", cfg?.__lang), cfg);
        return true;
      }
      if (bookResult.status === "unparsed") {
        const lang = cfg?.__lang || "en";
        const dateISO = findBookingDateInHistory(historyMessages, String(intentData.datetime || text));
        if (dateISO) {
          if (!replyText) {
            const n = await generateAssistantNudge("ask_specific_time", {}, aiOpts(tenant));
            await sendTextTracked(from, n || tr("ask_specific_time", lang), cfg);
          }
        } else if (!replyText) {
          const n = await generateAssistantNudge("ask_datetime", { examples: ["tomorrow 8pm", "Nov 3 at 14:30"] }, aiOpts(tenant));
          await sendTextTracked(from, n || tr("ask_datetime", lang), cfg);
        }
        return true;
      }
      return true;
    }

    if (intentType === "cancel" && cfg?.bookings_enabled) {
      const appt = await findUpcomingConfirmedAppointment({ userId: tenantUserId, digits: fromDigits });
      if (!appt) {
        if (!replyText) await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
        return true;
      }
      const now = Math.floor(Date.now() / 1000);
      const minLead = Number(cfg.cancel_min_lead_minutes || 60);
      const minsToStart = Math.floor((appt.start_ts - now) / 60);
      if (minsToStart < minLead) {
        await notifyTooClose(from, minLead, cfg);
        return true;
      }
      const dbNative = getDB();
      const pendingCancel = await dbNative.collection("booking_sessions").findOne({
        user_id: String(tenantUserId),
        contact_id: String(from),
        step: "awaiting_cancel_confirm",
      });
      const apptRefId = resolveAppointmentRefId(appt) || await ensureAppointmentLegacyId(appt, tenantUserId);
      const apptId = Number(pendingCancel?.appt_id) > 0
        ? Number(pendingCancel.appt_id)
        : apptRefId;
      const apptOid = pendingCancel?.appt_oid || appt._id;
      if (!apptId && !apptOid) {
        await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
        return true;
      }
      if (isCancelConfirmation(text)) {
        await completeCancellation({
          tenantUserId,
          from,
          apptId,
          apptOid,
          cfg,
          sessionId: pendingCancel?._id,
          fromDigits,
        });
        return true;
      }
      await dbNative.collection("booking_sessions").updateOne(
        { user_id: String(tenantUserId), contact_id: String(from) },
        {
          $set: {
            step: "awaiting_cancel_confirm",
            appt_id: apptId,
            appt_oid: apptOid,
            lang: cfg?.__lang === "sq" ? "sq" : "en",
          },
          $currentDate: { updatedAt: true },
        },
        { upsert: true }
      );
      await sendTextTracked(from, tr("cancel_confirm_instructions", cfg?.__lang, { ref: apptId || apptRefId }), cfg);
      return true;
    }

    if (intentType === "reschedule" && cfg?.bookings_enabled) {
      const appt = await findUpcomingConfirmedAppointment({ userId: tenantUserId, digits: fromDigits });
      if (!appt) {
        if (!replyText) await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
        return true;
      }
      const now = Math.floor(Date.now() / 1000);
      const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
      const minsToStart = Math.floor((appt.start_ts - now) / 60);
      if (minsToStart < minLead) {
        await notifyTooClose(from, minLead, cfg);
        return true;
      }
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return true;
      const apptRefId = resolveAppointmentRefId(appt) || await ensureAppointmentLegacyId(appt, tenantUserId);
      const parsed = resolveRescheduleDatetime(String(intentData.datetime || text), historyMessages, intentData, appt.start_ts);
      if (parsed?.dateISO && parsed.hour != null) {
        const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
        const start = buildUtcFromLocalWallTime(parsed.dateISO, parsed.hour, parsed.minute || 0, staff.timezone || "UTC");
        const durationMin = Number(staff.slot_minutes || 30);
        const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
        const avail = await listAvailability({
          userId: tenantUserId,
          staffId: String(staff._id),
          dateISO: base.toISOString(),
          days: 1,
          slotMinutes: durationMin,
        });
        const slots = (avail[0]?.slots || []).filter((s) => new Date(s.start).getTime() >= Date.now() + minLeadMs);
        const toleranceMs = Math.max(120000, Math.floor(durationMin * 60000 / 2));
        const scored = slots.map((s) => ({ slot: s, diff: Math.abs(new Date(s.start).getTime() - start.getTime()) }));
        scored.sort((a, b) => a.diff - b.diff);
        const match = scored.find((x) => x.diff <= toleranceMs)?.slot;
        if (match) {
          try {
            await rescheduleBooking({
              userId: tenantUserId,
              appointmentId: apptRefId,
              mongoId: appt._id,
              startISO: match.start,
              endISO: match.end,
            });
          } catch (err) {
            console.error("[reschedule-intent]", err?.message || err);
            await sendTextTracked(from, tr("slot_book_failed", cfg?.__lang), cfg);
            return true;
          }
          const locale = cfg?.__lang === "sq" ? "sq-AL" : undefined;
          const when = new Date(match.start).toLocaleString(locale, {
            timeZone: staff.timezone || "UTC",
            dateStyle: "medium",
            timeStyle: "short",
          });
          await sendTextTracked(from, tr("rescheduled", cfg?.__lang, { when, ref: apptRefId }), cfg);
          try {
            await getDB().collection("booking_sessions").deleteOne({
              user_id: String(tenantUserId),
              contact_id: String(from),
              step: "awaiting_reschedule_dt",
            });
          } catch {}
          return true;
        }
        const suggestions = formatSlotSuggestions(
          scored.slice(0, 3).map((x) => x.slot),
          cfg?.__lang,
          staff.timezone
        );
        if (suggestions.length) {
          await sendTextTracked(from, tr("closest_times", cfg?.__lang, { suggestions }), cfg);
          return true;
        }
      }
      await getDB().collection("booking_sessions").updateOne(
        { user_id: String(tenantUserId), contact_id: String(from) },
        {
          $set: {
            step: "awaiting_reschedule_dt",
            appt_id: apptRefId,
            appt_oid: appt._id,
            staff_id: appt.staff_id,
            lang: cfg?.__lang === "sq" ? "sq" : "en",
          },
          $currentDate: { updatedAt: true },
        },
        { upsert: true }
      );
      return true;
    }

    if (intentType === "update_name" && cfg?.bookings_enabled) {
      const appt = await findUpcomingConfirmedAppointment({
        userId: tenantUserId,
        digits: fromDigits,
        projection: { id: 1, start_ts: 1, notes: 1, _id: 1 },
      });
      if (!appt) {
        if (!replyText) await sendTextTracked(from, tr("no_booking_found", cfg?.__lang), cfg);
        return true;
      }
      const parsedChange = parseBookingNameChange(text);
      const newName = String(
        intentData?.name || intentData?.newName || parsedChange?.newName || parseNameFromMessage(text) || ""
      ).trim();
      if (!newName) {
        if (!replyText) await sendTextTracked(from, tr("ask_booking_new_name", cfg?.__lang), cfg);
        return true;
      }
      try {
        const apptRefId = resolveAppointmentRefId(appt) || await ensureAppointmentLegacyId(appt, tenantUserId);
        await updateBookingName({
          userId: tenantUserId,
          appointmentId: apptRefId,
          mongoId: appt._id,
          newName,
        });
        try { await rememberName(tenantUserId, from, newName); } catch {}
        await sendTextTracked(from, tr("booking_name_updated", cfg?.__lang, { name: newName, ref: apptRefId }), cfg);
      } catch (err) {
        console.error("[booking-name-update]", err?.message || err);
        if (!replyText) await sendTextTracked(from, tr("error_generic", cfg?.__lang), cfg);
      }
      return true;
    }

    if (intentType === "handoff") {
      try {
        if (await handleOutOfHoursGuard(tenantUserId, from, cfg)) return true;
      } catch {}
      const intendedName = String(intentData?.name || "").trim();
      if (intendedName) {
        try {
          db.prepare(`INSERT INTO customers (user_id, contact_id, display_name, created_at, updated_at)
            VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))
            ON CONFLICT(user_id, contact_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`).run(
            tenantUserId,
            from,
            intendedName.slice(0, 80)
          );
        } catch {}
      }
      const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
      const hasName = !!customer.display_name;
      const step = hasName ? "ask_reason" : "ask_name";
      db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
        VALUES (?, ?, ?, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, updated_at = excluded.updated_at`).run(
        from,
        tenantUserId,
        step
      );
      if (!replyText) {
        const n = await generateAssistantNudge(
          hasName ? "handoff_ask_reason" : "handoff_ask_name",
          { name: customer.display_name },
          aiOpts(tenant)
        );
        if (n) await sendTextTracked(from, n, cfg);
      }
      return true;
    }

    return false;
  }

  function getServicesFromSettings(cfg) {
    try {
      const arr = JSON.parse(cfg?.services_json || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => s && s.name && s.minutes).slice(0, 20);
    } catch { return []; }
  }

  async function sendServicePicker(to, cfg) {
    const services = getServicesFromSettings(cfg);
    if (!services.length) return false;
    const rows = services.slice(0,10).map((s, i) => ({
      id: `SERV_PICK_${i}`,
      title: s.name,
      description: (s.minutes ? `${s.minutes} min` : '') + (s.price ? ` · ${s.price}` : '')
    }));
    await sendListTracked(to, tr('choose_service_header', cfg?.__lang), tr('choose_service_body', cfg?.__lang), tr('select_button', cfg?.__lang), rows, cfg);
    return true;
  }
  function formatYmdFromTs(ts) {
    const d = new Date((Number(ts)||0)*1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth()+1).padStart(2,'0');
    const dd = String(d.getUTCDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  }

  async function notifyWaitlistForNewAvailability({ tenantUserId, staffId, startTs, cfg }) {
    try {
      if (!cfg?.waitlist_enabled) return;
      const dateKey = formatYmdFromTs(startTs);
      const dbNative = getDB();
      const watchers = await dbNative.collection('waitlist')
        .find({ user_id: String(tenantUserId), staff_id: staffId, date: dateKey })
        .limit(50)
        .toArray();
      if (!watchers || !watchers.length) return;
      for (const w of watchers) {
        try {
          const dateISO = `${dateKey}T00:00:00.000Z`;
          const staff = await getStaffById(String(staffId), tenantUserId);
          if (staff) {
            await sendDayAvailabilityText({
              from: w.contact_id,
              tenantUserId,
              staffId: String(staffId),
              startISODate: dateISO,
              tod: null,
              cfg,
              staff,
              skipIntro: false,
            });
          }
        } catch {}
      }
      try { await dbNative.collection('waitlist').deleteMany({ user_id: String(tenantUserId), staff_id: staffId, date: dateKey }); } catch {}
    } catch {}
  }
  async function sendTextTracked(to, text, cfg, options = {}) {
    text = stripBoilerplateHelpOffers(stripEmDashes(String(text || "")));
    if (!text) return null;
    try {
      const jobId = await enqueueOutboundMessage({
        userId: cfg?.user_id || null,
        cfg,
        to,
        message: text,
        replyToMessageId: options.replyToMessageId || null,
        idempotencyKey: options.idempotencyKey || options.replyToMessageId || null
      });
      if (jobId) {
        return { messages: [{ id: `queued:${jobId}` }] };
      }
    } catch (error) {
      console.error('[Webhook] Failed to enqueue outbound message:', error?.message || error);
    }

    const resp = await sendWhatsAppText(to, text, cfg, options.replyToMessageId || null);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        recordOutboundMessage({ messageId: outboundId, userId: cfg?.user_id || null, cfg, to, type: 'text', text, raw: { to, text } });
        businessMetrics.trackWhatsAppMessage('sent', 'text', true);
      }
    } catch {}
    return resp;
  }

  async function sendLocationTracked(to, location, cfg, options = {}) {
    const resp = await sendWhatsAppLocation(to, location, cfg, options.replyToMessageId || null);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        const label = location?.address || location?.name || "Location";
        recordOutboundMessage({
          messageId: outboundId,
          userId: cfg?.user_id || null,
          cfg,
          to,
          type: "location",
          text: label,
          raw: { to, location },
        });
        businessMetrics.trackWhatsAppMessage("sent", "location", true);
      }
    } catch {}
    return resp;
  }

  async function tryReplyWithBusinessLocation(from, text, cfg, lang) {
    if (!isLocationQuestion(text)) return false;
    const location = getBusinessLocation(cfg);
    const address = String(cfg?.business_address || "").trim();
    if (!location && !address) {
      await sendTextTracked(from, tr("location_not_configured", lang), cfg);
      return true;
    }
    if (location) {
      await sendTextTracked(from, tr("location_reply_with_pin", lang, { address: location.address || address }), cfg);
      await sendLocationTracked(from, location, cfg);
      return true;
    }
    await sendTextTracked(from, tr("location_text_only", lang, { address }), cfg);
    return true;
  }

  async function sendOrganicBookingConfirmation({
    req, tenantUserId, from, cfg, tenant, staff, startISO, endISO, bookingId, when, details = {},
  }) {
    const refKey = String(bookingId || "").trim();
    if (refKey) {
      try {
        const mem = await getContactMemory(tenantUserId, from);
        const lastRef = String(mem?.last_booking_confirm_ref || "");
        const lastTs = Number(mem?.last_booking_confirm_ts || 0);
        if (lastRef === refKey && Math.floor(Date.now() / 1000) - lastTs < 86400) {
          return false;
        }
      } catch {}
    }

    const baseUrl = getPublicBaseUrl(req);
    const title = tenant?.business_name ? `Appointment with ${tenant.business_name}` : "Appointment";
    const icsUrl = baseUrl
      ? `${baseUrl}/ics?title=${encodeURIComponent(title)}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&desc=${encodeURIComponent("Ref #" + bookingId)}`
      : "";
    const msg = icsUrl
      ? `${tr("booking_confirmed_ref", cfg?.__lang, { when, ref: bookingId })}\n\n${tr("add_to_calendar", cfg?.__lang)} ${icsUrl}`.trim()
      : tr("booking_confirmed_ref", cfg?.__lang, { when, ref: bookingId });
    await sendTextTracked(from, msg, cfg);

    const customerName = details.name || from;
    const notes = details.notes || "";
    try {
      await sendBookingNotification(tenantUserId, {
        customerName,
        customerPhone: from,
        startTime: startISO,
        endTime: endISO,
        notes,
        appointmentId: bookingId,
        staffName: staff?.name || null,
      });
    } catch (e) {
      console.error("[Webhook] Failed to send booking email:", e.message);
    }
    try {
      await sendStaffGroupBookingNotification(tenantUserId, {
        customerName,
        customerPhone: from,
        startTime: startISO,
        endTime: endISO,
        notes,
        appointmentId: bookingId,
        staffName: staff?.name || null,
      }, cfg);
    } catch (e) {
      console.error("[Webhook] Failed to send staff group booking alert:", e.message);
    }
    try {
      const formattedTime = new Date(startISO).toLocaleString();
      db.prepare(`INSERT INTO notifications (user_id, type, title, message, link, metadata)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        tenantUserId,
        "booking",
        "New Booking Confirmed",
        `${customerName} booked an appointment for ${formattedTime} (Ref #${bookingId})`,
        `/bookings`,
        JSON.stringify({
          contact_phone: from,
          appointment_id: bookingId,
          start_time: startISO,
          customer_name: customerName,
        })
      );
    } catch (e) {
      console.error("[Webhook] Failed to create booking notification:", e.message);
    }
    try { if (details.name) await rememberName(tenantUserId, from, details.name); } catch {}
    try { if (details.partySize) await rememberPartySize(tenantUserId, from, details.partySize); } catch {}
    try { await rememberAppointment(tenantUserId, from, { startISO }); } catch {}
    try { if (staff?.name) await rememberAgent(tenantUserId, from, staff.name); } catch {}
    if (refKey) {
      try {
        await updateContactMemory(tenantUserId, from, {
          last_booking_confirm_ref: refKey,
          last_booking_confirm_ts: Math.floor(Date.now() / 1000),
        });
      } catch {}
    }
    return true;
  }

  async function sendListTracked(to, header, body, buttonText, rows, cfg) {
    const resp = await sendWhatsappList(to, header, body, buttonText, rows, cfg);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        const combinedText = `${header}\n${body}`;
        recordOutboundMessage({
          messageId: outboundId,
          userId: cfg?.user_id || null,
          cfg,
          to,
          type: 'interactive',
          text: combinedText,
          raw: { to, interactive: { body: { text: header }, type: 'list' } }
        });
        businessMetrics.trackWhatsAppMessage('sent', 'interactive', true);
      }
    } catch {}
    return resp;
  }

  async function sendButtonTracked(to, text, buttons, cfg) {
    const resp = await sendWhatsappButton(to, text, buttons, cfg);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        recordOutboundMessage({ messageId: outboundId, userId: cfg?.user_id || null, cfg, to, type: 'interactive', text, raw: { to, interactive: 'button' } });
        businessMetrics.trackWhatsAppMessage('sent', 'interactive', true);
      }
    } catch {}
    return resp;
  }

  async function sendDocumentTracked(to, fileUrl, filename, cfg) {
    const resp = await sendWhatsappDocument(to, fileUrl, filename, cfg);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        recordOutboundMessage({ messageId: outboundId, userId: cfg?.user_id || null, cfg, to, type: 'document', text: null, raw: { to, document: fileUrl } });
        businessMetrics.trackWhatsAppMessage('sent', 'document', true);
      }
    } catch {}
    return resp;
  }
  async function recordAndBroadcastInbound({ message, tenantUserId, metadata, normalizedType, text, mediaUrl }) {
    try {
      const inboundId = message?.id;
      if (!inboundId || !tenantUserId) return false;
      const inserted = await recordInboundMessage({
        messageId: inboundId,
        userId: tenantUserId,
        from: message.from,
        businessPhone: metadata?.display_phone_number?.replace(/\D/g, ""),
        type: normalizedType,
        text: normalizedType === 'image' ? null : text,
        timestamp: message.timestamp ? Number(message.timestamp) : undefined,
        raw: message
      });
      if (inserted) {
        try { incrementUsage(tenantUserId, 'inbound_messages'); } catch {}
        const messageData = {
          id: inboundId,
          direction: 'inbound',
          type: normalizedType || 'text',
          text_body: normalizedType === 'image' ? null : text,
          timestamp: message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000),
          from_digits: normalizePhone(message.from),
          to_digits: normalizePhone(metadata?.display_phone_number),
          contact_name: null,
          contact: message.from,
          formatted_time: new Date((message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000)) * 1000).toLocaleString(),
          media_url: mediaUrl || null
        };
        try { broadcastNewMessage(tenantUserId, message.from, messageData); } catch {}
        try {
          await Handoff.findOneAndUpdate(
            { user_id: tenantUserId, contact_id: message.from },
            { $set: { is_archived: false, deleted_at: null, updatedAt: new Date() }, $setOnInsert: { user_id: tenantUserId, contact_id: message.from } },
            { upsert: true }
          );
        } catch {}
        try {
          const current = await getConversationStatus(tenantUserId, message.from);
          if (current === CONVERSATION_STATUSES.RESOLVED || current === CONVERSATION_STATUSES.CLOSED) {
            let shouldReopen = false;
            try {
              if (normalizedType === 'text') {
                const s = String(text || '').trim();
                if (s) {
                  const ack = isAcknowledgement(s) || isGreeting(s);
                  const substantive = hasSubstantiveRequest(s) || wantsHuman(s) || s.includes('?');
                  shouldReopen = substantive && !ack;
                }
              } else if (normalizedType === 'interactive') {
                shouldReopen = true;
              } else {
                shouldReopen = false;
              }
            } catch { shouldReopen = false; }
            if (shouldReopen) {
              await updateConversationStatus(tenantUserId, message.from, CONVERSATION_STATUSES.NEW, 'Customer sent a substantive message after resolution');
            }
          }
        } catch {}
      }
      return !!inserted;
    } catch {
      return false;
    }
  }

  async function maybeSendHoldingMessage(tenantUserId, from, cfg) {
    const tenant = cfg;
    try {
      if (!tenantUserId) return false;
      const current = await getConversationStatus(tenantUserId, from);
      if (current !== CONVERSATION_STATUSES.IN_PROGRESS) {
        try { memProgress.delete(memKey(tenantUserId, from)); } catch {}
        return false;
      }
      const nowMs = Date.now();
      const key = memKey(tenantUserId, from);
      const rec = memProgress.get(key) || { lastHoldingAtMs: 0, hits: [] };
      const spamWindowMs = Number(process.env.INPROGRESS_SPAM_WINDOW_MS || 30000);
      const spamThresh = Number(process.env.INPROGRESS_SPAM_THRESHOLD || 3);
      rec.hits = (rec.hits || []).filter(ts => (nowMs - ts) <= spamWindowMs);
      rec.hits.push(nowMs);
      if (rec.hits.length >= spamThresh) { memProgress.set(key, rec); return true; }
      const cooldownMs = Number(process.env.INPROGRESS_HOLDING_COOLDOWN_MS || 60000);
      if (nowMs - (rec.lastHoldingAtMs || 0) >= cooldownMs) {
        try { const n = await generateAssistantNudge('holding', {}, aiOpts(tenant)); await sendTextTracked(from, n, cfg); } catch {}
        rec.lastHoldingAtMs = nowMs;
      }
      memProgress.set(key, rec);
      return true;
    } catch {
      return false;
    }
  }
  function maybeSuppressNonSubstantiveSpam(tenantUserId, from, text) {
    try {
      const key = memKey(tenantUserId, from);
      const nowMs = Date.now();
      const windowMs = Number(process.env.SPAM_WINDOW_MS || 20000);
      const threshold = Number(process.env.SPAM_THRESHOLD || 3);
      const rec = memSpam.get(key) || { hits: [] };
      rec.hits = (rec.hits || []).filter(ts => (nowMs - ts) <= windowMs);
      rec.hits.push(nowMs);
      memSpam.set(key, rec);
      if (hasSubstantiveRequest(text)) return false;
      if (rec.hits.length >= threshold) return true;
    } catch {}
    return false;
  }

  async function handleOutOfHoursGuard(tenantUserId, from, cfg) {
    const tenant = cfg;
    try {
      if (!tenantUserId) return false;
      const within = await isWithinStaffWorkingHours(tenantUserId, cfg);
      if (!within) {
        const ok = await shouldSendOutOfHours(tenantUserId, from);
        if (ok) {
          const oohMsg = cfg.escalation_out_of_hours_message || await generateAssistantNudge('out_of_hours', {}, aiOpts(tenant));
          await sendTextTracked(from, oohMsg, cfg);
        }
        return true;
      }
    } catch {}
    return false;
  }

function getEscalationAckMessage(cfg) {
  const raw = String(cfg?.escalation_additional_message || '').trim();
  return raw || DEFAULT_ESCALATION_ACK;
}

async function sendEscalationIntroMessage(to, cfg) {
  const intro = getEscalationAckMessage(cfg);
  if (!intro) return;
  await sendTextTracked(to, intro, cfg);
}

function shouldThrottleEscalationHolding(userId, contact) {
  const key = memKey(userId, contact);
  const now = Date.now();
  const last = memEscalationHold.get(key) || 0;
  const windowMs = Number(process.env.ESCALATION_HOLD_COOLDOWN_MS || 60000);
  if (now - last < windowMs) return true;
  memEscalationHold.set(key, now);
  return false;
}

async function sendEscalationHoldingMessage({ tenantUserId, to, cfg, reason, waitMinutes }) {
  if (shouldThrottleEscalationHolding(tenantUserId, to)) return false;
  const payload = {
    reason: reason || null,
    waitMinutes: Number.isFinite(waitMinutes) && waitMinutes > 0 ? Math.round(waitMinutes) : null
  };
  const holding = await generateAssistantNudge('handoff_followup', payload, aiOpts(cfg));
  await sendTextTracked(to, holding, cfg);
  return true;
}

async function promptForEscalationName(to, cfg) {
  const prompt = await generateAssistantNudge('handoff_ask_name', {}, aiOpts(cfg));
  await sendTextTracked(to, prompt, cfg);
}

async function promptForEscalationReason(to, cfg) {
  const prompt = await generateAssistantNudge('handoff_ask_reason', {}, aiOpts(cfg));
  await sendTextTracked(to, prompt, cfg);
}

async function maybeHandleEscalationFollowup({ tenantUserId, from, text, cfg }) {
  try {
    const row = await db.prepare(`SELECT is_human, human_expires_ts, escalation_reason FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId).catch(() => null);
    if (!row?.is_human) return false;
    const now = Math.floor(Date.now() / 1000);
    const stillWaiting = !row.human_expires_ts || Number(row.human_expires_ts) > now;
    if (!stillWaiting) return false;
    if (!needsAgentFollowup(text)) return false;
    const remainingMinutes = row.human_expires_ts ? Math.max(1, Math.round((Number(row.human_expires_ts) - now) / 60)) : null;
    return await sendEscalationHoldingMessage({
      tenantUserId,
      to: from,
      cfg,
      reason: row.escalation_reason || null,
      waitMinutes: remainingMinutes
    });
  } catch (error) {
    console.error('[Webhook] Failed to send escalation follow-up:', error?.message || error);
    return false;
  }
}

async function completeEscalationHandoff({ tenantUserId, from, reason, cfg, customerName }) {
  const expires = Math.floor(Date.now() / 1000) + 5 * 60;
  try {
    await db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, escalation_reason, is_human, human_expires_ts, updated_at)
      VALUES (?, ?, NULL, ?, 1, ?, strftime('%s','now'))
      ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = NULL, escalation_reason = excluded.escalation_reason, is_human = 1, human_expires_ts = excluded.human_expires_ts, updated_at = excluded.updated_at`).run(from, tenantUserId, reason, expires);
  } catch (e) {
    console.error('[Webhook] Failed to store escalation completion:', e?.message || e);
  }
  try {
    await sendEscalationNotification(tenantUserId, {
      customerName: customerName || null,
      customerPhone: from,
      reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[Webhook] Failed to send escalation email:', e?.message || e);
  }
  try {
    const displayName = customerName || from;
    await db.prepare(`INSERT INTO notifications (user_id, type, title, message, link, metadata) 
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        tenantUserId,
        'escalation',
        'New Support Escalation',
        `${displayName} requested to speak with a human: "${reason}"`,
        `/inbox/${encodeURIComponent(from)}`,
        JSON.stringify({ contact_id: from, reason, customer_name: displayName })
      );
  } catch (e) {
    console.error('[Webhook] Failed to create escalation notification:', e?.message || e);
  }
  try {
    await updateConversationStatus(tenantUserId, from, CONVERSATION_STATUSES.IN_PROGRESS, 'escalation_pending_handoff');
  } catch (e) {
    console.error('[Webhook] Failed to update conversation status for escalation:', e?.message || e);
  }
  const connecting = await generateAssistantNudge('handoff_connecting', {}, aiOpts(cfg));
  await sendTextTracked(from, connecting, cfg);
}

async function handleSimpleEscalationFlow({ tenantUserId, from, text, cfg }) {
  try {
    if (!tenantUserId || !from) return true;
    try {
      const m = await getContactMemory(tenantUserId, from);
      if (cfg) cfg.__lang = resolveLanguage(text, m?.lang);
    } catch {}

    const outHandled = await handleOutOfHoursGuard(tenantUserId, from, cfg);
    if (outHandled) return true;

    const state = await db.prepare(`SELECT escalation_step, is_human, human_expires_ts, escalation_reason FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId).catch(() => null) || {};
    const customer = await db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from).catch(() => null) || {};
    const trimmed = String(text || '').trim();
    const step = state.escalation_step || null;
    const now = Math.floor(Date.now() / 1000);
    const waitingForAgent = !!state.is_human && (!state.human_expires_ts || Number(state.human_expires_ts) > now);
    const remainingMinutes = state.human_expires_ts ? Math.max(1, Math.round((Number(state.human_expires_ts) - now) / 60)) : null;

    if (!step) {
      if (waitingForAgent) {
        if (needsAgentFollowup(trimmed)) {
          await sendEscalationHoldingMessage({
            tenantUserId,
            to: from,
            cfg,
            reason: state.escalation_reason || null,
            waitMinutes: remainingMinutes
          });
        }
        return true;
      }
      const isShortGreeting = /^(\s*(hi|hello|hey)\b.*)$/i.test(trimmed) && trimmed.length <= 40;
      if (trimmed && !isShortGreeting) {
        const reason = trimmed.slice(0, 300);
        await completeEscalationHandoff({
          tenantUserId,
          from,
          reason,
          cfg,
          customerName: customer.display_name || null
        });
        return true;
      }
      await sendEscalationIntroMessage(from, cfg);
      if (customer.display_name) {
        try {
          await db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
            VALUES (?, ?, 'ask_reason', strftime('%s','now'))
            ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
        } catch (e) {
          console.error('[Webhook] Failed to set escalation step ask_reason:', e?.message || e);
        }
        await promptForEscalationReason(from, cfg);
      } else {
        try {
          await db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
            VALUES (?, ?, 'ask_name', strftime('%s','now'))
            ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_name', updated_at = excluded.updated_at`).run(from, tenantUserId);
        } catch (e) {
          console.error('[Webhook] Failed to set escalation step ask_name:', e?.message || e);
        }
        await promptForEscalationName(from, cfg);
      }
      return true;
    }

    if (step === 'ask_name') {
      const parsed = parseNameFromMessage(text) || trimmed.slice(0, 80);
      if (parsed) {
        try {
          await db.prepare(`INSERT INTO customers (user_id, contact_id, display_name, created_at, updated_at)
            VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))
            ON CONFLICT(user_id, contact_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`).run(tenantUserId, from, parsed);
        } catch (e) {
          console.error('[Webhook] Failed to store customer name:', e?.message || e);
        }
        try { await rememberName(tenantUserId, from, parsed); } catch {}
        customer.display_name = parsed;
        try {
          await db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
            VALUES (?, ?, 'ask_reason', strftime('%s','now'))
            ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
        } catch (e) {
          console.error('[Webhook] Failed to advance to ask_reason:', e?.message || e);
        }
        await sendTextTracked(from, tr('escalation_reason_prompt', cfg?.__lang, { business: cfg?.business_name }), cfg);
      } else {
        await promptForEscalationName(from, cfg);
      }
      return true;
    }

    if (step === 'ask_reason') {
      const reason = trimmed.slice(0, 300);
      if (reason) {
        await completeEscalationHandoff({
          tenantUserId,
          from,
          reason,
          cfg,
          customerName: customer.display_name || null
        });
      } else {
        await promptForEscalationReason(from, cfg);
      }
      return true;
    }
    await sendEscalationIntroMessage(from, cfg);
    try {
      await db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
        VALUES (?, ?, 'ask_name', strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_name', updated_at = excluded.updated_at`).run(from, tenantUserId);
    } catch (e) {
      console.error('[Webhook] Failed to reset escalation step:', e?.message || e);
    }
    await promptForEscalationName(from, cfg);
    return true;
  } catch (err) {
    console.error('[Webhook] Simple escalation flow error:', err?.message || err);
    try {
      await sendTextTracked(from, tr('error_connecting_agent', cfg?.__lang), cfg);
    } catch {}
    return true;
  }
}

  async function maybeJoinRecentFragments({ text, from, tenantUserId, timestampSec }) {
    try {
      const nowSec = Number(timestampSec || Math.floor(Date.now()/1000));
      const digits = digitsOnly(from);
      if (!digits) return text;
      const windowSec = 20;
      const recent = db.prepare(`
        SELECT text_body AS t, timestamp AS ts
        FROM messages
        WHERE user_id = ? AND direction = 'inbound' AND type = 'text'
          AND (REPLACE(from_id,'+','') = ? OR from_digits = ?)
          AND timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT 8
      `).all(tenantUserId, digits, digits, nowSec - windowSec);
      const parts = (recent || []).map(r => String(r.t || '').trim()).filter(Boolean);
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
      const isShort = (s) => {
        const trimmed = String(s || '').trim();
        const wc = trimmed ? trimmed.split(/\s+/).length : 0;
        return trimmed.length <= 4 || wc <= 2;
      };
      if (joined && (isShort(text) || parts.length >= 3)) return joined;
    } catch {}
    return text;
  }

  async function sendBrandingIfFree({ tenantUserId, to, cfg, planHint = null }) {
    try {
      const plan = planHint || await getUserPlan(tenantUserId);
      if ((plan?.plan_name || 'free') === 'free') {
        try { await sendTextTracked(to, 'This chat is powered by https://agent.codeorbit.tech', cfg); } catch {}
      }
    } catch {}
  }

  const memHolidays = new Map();  async function getHolidayDatesForTenant(cfg) {
    const userId = cfg?.user_id || cfg?.userId || null;
    const now = Date.now();
    const ttlMs = Number(process.env.HOLIDAYS_TTL_MS || 12*60*60*1000);
    const key = String(userId||'null');
    const hit = memHolidays.get(key);
    if (hit && hit.expires > now) return hit.dates;
    let dates = new Set();
    try {
      try {
        const arr = JSON.parse(cfg?.closed_dates_json || '[]');
        if (Array.isArray(arr)) arr.forEach(d => { if (typeof d === 'string') dates.add(d); });
      } catch {}
      if (cfg?.holidays_json_url) {
        const url = String(cfg.holidays_json_url);
        try {
          if (isRedisConnected()) {
            const redis = getRedisClient();
            const rkey = `holidays:url:${url}`;
            const cached = await redis.get(rkey);
            if (cached) {
              try { const arr = JSON.parse(cached); if (Array.isArray(arr)) arr.forEach(d => dates.add(String(d))); }
              catch {}
            } else {
              const fetch = (await import('node-fetch')).default;
              const resp = await fetch(url, { timeout: Number(process.env.HOLIDAYS_FETCH_TIMEOUT_MS||5000) });
              if (resp.ok) {
                const body = await resp.json().catch(()=>null);
                const arr = Array.isArray(body) ? body : (Array.isArray(body?.dates) ? body.dates : []);
                if (Array.isArray(arr)) {
                  await redis.set(rkey, JSON.stringify(arr), 'PX', Math.max(1000, ttlMs));
                  arr.forEach(d => dates.add(String(d)));
                }
              }
            }
          } else {
            const fetch = (await import('node-fetch')).default;
            const resp = await fetch(url, { timeout: Number(process.env.HOLIDAYS_FETCH_TIMEOUT_MS||5000) });
            if (resp.ok) {
              const body = await resp.json().catch(()=>null);
              const arr = Array.isArray(body) ? body : (Array.isArray(body?.dates) ? body.dates : []);
              if (Array.isArray(arr)) arr.forEach(d => dates.add(String(d)));
            }
          }
        } catch {}
      }
    } catch {}
    memHolidays.set(key, { dates, expires: now + ttlMs });
    return dates;
  }

  function isClosedByHolidayForMoment(cfg, tz, dateKey, minutesNow) {
    try {
      try {
        const arr = JSON.parse(cfg?.closed_dates_json || '[]');
        if (Array.isArray(arr) && arr.includes(dateKey)) return true;
      } catch {}
      try {
        const rules = JSON.parse(cfg?.holidays_rules_json || '[]');
        if (Array.isArray(rules)) {
          for (const r of rules) {
            if (String(r?.date) !== dateKey) continue;
            const sm = /^\s*(\d{2}):(\d{2})\s*$/.exec(String(r?.start||''));
            const em = /^\s*(\d{2}):(\d{2})\s*$/.exec(String(r?.end||''));
            if (!sm || !em) continue;
            const startMin = Number(sm[1]) * 60 + Number(sm[2]);
            const endMin = Number(em[1]) * 60 + Number(em[2]);
            if (minutesNow >= startMin && minutesNow <= endMin) return true;
          }
        }
      } catch {}
    } catch {}
    return false;
  }
  async function shouldSendOutOfHours(tenantUserId, contactId) {
    try {
      const dbNative = getDB();
      const now = Math.floor(Date.now() / 1000);
      const cooldown = Number(process.env.OOH_COOLDOWN_SEC || 300);
      const st = await dbNative.collection('contact_state')
        .findOne({ user_id: String(tenantUserId), contact_id: String(contactId) }, { projection: { last_ooh_ts: 1 } });
      const last = Number(st?.last_ooh_ts || 0);
      if (last && (now - last) <= cooldown) return false;
      await dbNative.collection('contact_state').updateOne(
        { user_id: String(tenantUserId), contact_id: String(contactId) },
        { $set: { last_ooh_ts: now, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      return true;
    } catch { return true; }
  }
  async function isWithinStaffWorkingHours(tenantUserId, cfg) {
    try {
      const dbNative = getDB();
      const staff = await dbNative.collection('staff')
        .find({ user_id: String(tenantUserId) })
        .project({ timezone: 1, working_hours_json: 1 })
        .sort({ createdAt: 1 })
        .limit(1)
        .toArray();
      const s = staff[0] || null;
      if (!s) return true;      const working = (() => { try { return JSON.parse(s.working_hours_json || '{}'); } catch { return {}; } })();
      const tz = s.timezone || 'UTC';
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
      const hh = Number(parts.find(p => p.type === 'hour')?.value || '00');
      const mm = Number(parts.find(p => p.type === 'minute')?.value || '00');
      const wd = (parts.find(p => p.type === 'weekday')?.value || 'Mon').slice(0,3).toLowerCase();
      const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const yyyy = dateParts.find(p=>p.type==='year')?.value || '0000';
      const mm2 = dateParts.find(p=>p.type==='month')?.value || '00';
      const dd2 = dateParts.find(p=>p.type==='day')?.value || '00';
      const dateKey = `${yyyy}-${mm2}-${dd2}`;
      const dayKey = ({ mon:'mon', tue:'tue', wed:'wed', thu:'thu', fri:'fri', sat:'sat', sun:'sun' })[wd] || 'mon';
      const slots = Array.isArray(working[dayKey]) ? working[dayKey] : [];
      try {
        if (isClosedByHolidayForMoment(cfg||{}, tz, dateKey, hh*60+mm)) return false;
        const hol = await getHolidayDatesForTenant(cfg||{});
        if (hol && hol.has(dateKey)) return false;
      } catch {}
      if (!slots.length) return false;      const nowMin = hh * 60 + mm;
      for (const slot of slots) {
        const m = /^(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})$/.exec(String(slot||''));
        if (!m) continue;
        const start = Number(m[1]) * 60 + Number(m[2]);
        const end = Number(m[3]) * 60 + Number(m[4]);
        if (nowMin >= start && nowMin <= end) return true;
      }
      return false;
    } catch { return true; }
  }
  async function handleButtonReply({ id, title, tenantUserId, from, cfg }) {
    const tenant = cfg;
    try { if (cfg && !cfg.__lang) { const m = await getContactMemory(tenantUserId, from); cfg.__lang = (m?.lang === 'sq' || m?.lang === 'en') ? m.lang : 'en'; } } catch {}
    if (!id) return;
    if (id === 'BOOKING_START') {
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return;
      await sendDayPicker(from, staff._id, null, cfg);
      return;
    }
    if (id === 'YES_GRAPH') {
      const n = await generateAssistantNudge('generic_ack', {}, aiOpts(tenant));
      await sendTextTracked(from, n || 'Great, sending the report graph now.', cfg);
      return;
    }
    if (id === 'NO_GRAPH') {
      const n = await generateAssistantNudge('generic_ack', {}, aiOpts(tenant));
      await sendTextTracked(from, n || 'Okay. If you need it later, just ask.', cfg);
      return;
    }
    if (id.startsWith('RESCHED_CONFIRM_')) {
      try {
        const parts = id.split('_');
        const apptId = Number(parts[2] || 0);
        const startISO = parts[3];
        const endISO = parts[4];
        if (apptId && startISO && endISO) {
          const now = Math.floor(Date.now()/1000);
          const row = db.prepare(`SELECT start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
          const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
          const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
          if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return; }
          await rescheduleBooking({ userId: tenantUserId, appointmentId: apptId, startISO, endISO });
          await sendTextTracked(from, tr('rescheduled', cfg?.__lang, { when: new Date(startISO).toLocaleString(), ref: apptId }), cfg);
        }
      } catch {}
      return;
    }
    if (id.startsWith('RESCHED_CANCEL_')) {
      const n = await generateAssistantNudge('cancel_aborted', {}, aiOpts(tenant));
      await sendTextTracked(from, n, cfg);
      return;
    }
    if (id.startsWith('CANCEL_CONFIRM_')) {
      try {
        const apptId = Number(id.split('_')[2] || 0);
        if (apptId) {
          const now = Math.floor(Date.now()/1000);
          const row = db.prepare(`SELECT start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
          let rowDetail = null;
          try {
            const dbNative = getDB();
            rowDetail = await dbNative.collection('appointments').findOne({ id: apptId, user_id: String(tenantUserId) }, { projection: { start_ts: 1, staff_id: 1 } });
          } catch {}
          const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
          const minLead = Number(cfg.cancel_min_lead_minutes || 60);
          if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return; }
          await cancelBooking({ userId: tenantUserId, appointmentId: apptId });
          await sendTextTracked(from, tr('canceled', cfg?.__lang, { ref: apptId }), cfg);
          if (rowDetail?.staff_id && rowDetail?.start_ts) {
            await notifyWaitlistForNewAvailability({ tenantUserId, staffId: rowDetail.staff_id, startTs: rowDetail.start_ts, cfg });
          }
        }
      } catch {}
      return;
    }
    if (id.startsWith('CANCEL_ABORT_')) {
      const n = await generateAssistantNudge('cancel_aborted', {}, aiOpts(tenant));
      await sendTextTracked(from, n, cfg);
      return;
    }
    if (id.startsWith('REM_OK_')) {
      const apptId = Number(id.split('_')[2] || 0);
      if (apptId) {
        const dbNative = getDB();
        const row = await dbNative.collection('appointments').findOne({ id: apptId, user_id: String(tenantUserId) }, { projection: { status: 1, start_ts: 1 } });
        if (row && row.status === 'confirmed') {
          const n = await generateAssistantNudge('reminder_ok', {}, aiOpts(tenant));
          await sendTextTracked(from, n, cfg);
        } else {
          const n = await generateAssistantNudge('reminder_missing', {}, aiOpts(tenant));
          await sendTextTracked(from, n, cfg);
        }
      }
      return;
    }
    if (id.startsWith('REM_CANCEL_')) {
      const apptId = Number(id.split('_')[2] || 0);
      if (apptId) {
        const now = Math.floor(Date.now()/1000);
        const dbNative = getDB();
        const row = await dbNative.collection('appointments').findOne({ id: apptId, user_id: String(tenantUserId) }, { projection: { start_ts: 1 } });
        const minsToStart = row ? Math.floor(((row.start_ts || 0) - now)/60) : 99999;
        const minLead = Number(cfg.cancel_min_lead_minutes || 60);
        if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); }
        else { try { await cancelBooking({ userId: tenantUserId, appointmentId: apptId }); await sendTextTracked(from, tr('canceled', cfg?.__lang, { ref: apptId }), cfg); } catch {} }
      }
      return;
    }
    if (id.startsWith('REM_RESCHED_')) {
      const apptId = Number(id.split('_')[2] || 0);
      if (apptId) {
        const now = Math.floor(Date.now()/1000);
        const dbNative = getDB();
        const row = await dbNative.collection('appointments').findOne({ id: apptId, user_id: String(tenantUserId) }, { projection: { start_ts: 1, staff_id: 1 } });
        const minsToStart = row ? Math.floor(((row.start_ts || 0) - now)/60) : 99999;
        const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
        if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); }
        else if (row?.staff_id) { await sendDayPicker(from, row.staff_id, apptId, cfg); }
      }
      return;
    }
    if (id.startsWith('KB_TITLE_')) {
      const wanted = id.replace('KB_TITLE_', '');
      await sendKbItemByTitle({ tenantUserId, to: from, title: wanted, cfg });
      return;
    }
    if (id.startsWith('CLINIC_')) {
      await sendTextTracked(from, tr('you_chose', cfg?.__lang, { title }), cfg);
      await sendButtonTracked(
        from,
        'Would you like me to send the report graph so you can forward it to your doctor?',
        [{ id: 'YES_GRAPH', title: 'Yes' }, { id: 'NO_GRAPH', title: 'No' }],
        cfg
      );
      return;
    }
  }

  async function saveCsatRating({ tenantUserId, contactId, score, emoji = null, messageText = '' }) {
    if (!score || !tenantUserId || !contactId) return;
    const dbNative = getDB();
    let cycleTs = null;
    try {
      const st = await dbNative.collection('contact_state')
        .findOne({ user_id: String(tenantUserId), contact_id: String(contactId) }, { projection: { await_rating_ts: 1 } });
      cycleTs = Number(st?.await_rating_ts || 0) || null;
    } catch {}
    await dbNative.collection('csat_ratings').updateOne(
      { user_id: String(tenantUserId), contact_id: String(contactId), cycle_ts: cycleTs },
      { $set: { score, emoji, message_text: messageText, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), cycle_ts: cycleTs } },
      { upsert: true }
    );
    await dbNative.collection('contact_state').updateOne(
      { user_id: String(tenantUserId), contact_id: String(contactId) },
      { $set: { await_rating: 0, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async function handleListReply({ id, title, tenantUserId, from, cfg, req }) {
    const tenant = cfg;
    try { if (cfg && !cfg.__lang) { const m = await getContactMemory(tenantUserId, from); cfg.__lang = (m?.lang === 'sq' || m?.lang === 'en') ? m.lang : 'en'; } } catch {}
    if (!id) return;
    if (/^CSAT_[1-5]$/.test(id)) {
      const score = Number(id.split('_')[1]);
      const emojiMap = { 1: '😡', 2: '😕', 3: '🙂', 4: '😀', 5: '🤩' };
      const emoji = emojiMap[score] || null;
      try { await saveCsatRating({ tenantUserId, contactId: from, score, emoji, messageText: `[List] ${title || ''}` }); } catch {}
      return;
    }
    if (id === 'GREET_BOOK') {
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return;
      const services = getServicesFromSettings(cfg);
      if (services.length) {
        try {
          const dbNative = getDB();
          await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_service', staff_id: staff._id }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
            { upsert: true }
          );
        } catch {}
        await sendServicePicker(from, cfg);
      } else {
        try {
          const dbNative = getDB();
          await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_datetime', staff_id: staff._id }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
            { upsert: true }
          );
        } catch {}
        { const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, aiOpts(tenant)); await sendTextTracked(from, n, cfg); }
      }
      return;
    }
    if (id.startsWith('SERV_PICK_')) {
      try {
        const idx = Number(id.split('_')[2] || -1);
        const services = getServicesFromSettings(cfg);
        const svc = services[idx] || null;
        if (svc) {
          const dbNative = getDB();
          await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_datetime', service_name: svc.name, service_minutes: Number(svc.minutes||0) }, $currentDate: { updatedAt: true } },
            { upsert: true }
          );
          try { await rememberService(tenantUserId, from, { name: svc.name, minutes: Number(svc.minutes||0) }); } catch {}
          const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, aiOpts(tenant));
          await sendTextTracked(from, n, cfg);
        }
      } catch {}
      return;
    }
    if (id.startsWith('GREET_KB_TITLE_')) {
      const titleDec = decodeURIComponent(id.replace('GREET_KB_TITLE_', ''));
      await sendKbItemByTitle({ tenantUserId, to: from, title: titleDec, cfg });
      return;
    }
    if (id.startsWith('RESCHED_PICK_DAY_')) {
      try {
        const parts = id.split('_');
        const dateStr = parts.slice(3, 4)[0];
        const staffId = Number(parts.slice(4, 5)[0] || 0);
        const apptId = Number(parts.slice(5, 6)[0] || 0);
        if (tenantUserId && staffId && dateStr && apptId) {
          const dateISO = new Date(`${dateStr}T12:00:00.000Z`).toISOString();
          const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
          if (!staff) return;
          const ok = await sendDayAvailabilityText({
            from,
            tenantUserId,
            staffId: String(staffId),
            startISODate: dateISO,
            tod: null,
            cfg,
            staff,
            skipIntro: false,
          });
          if (!ok) return;
        }
      } catch {}
      return;
    }
    if (id.startsWith('RESCHED_PICK_TIME_')) {
      try {
        const parts = id.split('_');
        const apptId = Number(parts[3] || 0);
        const staffId = Number(parts[4] || 0);
        const startISO = parts[5];
        const endISO = parts[6];
        if (apptId && staffId && startISO && endISO) {
          await sendButtonTracked(from, `Reschedule to ${new Date(startISO).toLocaleString()}?`, [
            { id: `RESCHED_CONFIRM_${apptId}_${startISO}_${endISO}`, title: 'Yes' },
            { id: `RESCHED_CANCEL_${apptId}`, title: 'No' }
          ], cfg);
        }
      } catch {}
      return;
    }
    if (id.startsWith('PICK_DAY_')) {
      try {
        const parts = id.split('_');
        let dateStr = parts.slice(2, 3)[0];
        let staffId = parts.slice(3, 4)[0];
        if (!staffId) {
          const staff = await (async () => { try { const s = await getDB().collection('staff').find({ user_id: String(tenantUserId) }).project({ _id: 1 }).sort({ createdAt: 1 }).limit(1).toArray(); return s[0] || null; } catch { return null; } })();
          staffId = staff?._id || null;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
          const yr = new Date().getUTCFullYear();
          const maybe = Date.parse(`${title} ${yr}`);
          if (!Number.isNaN(maybe)) {
            const d = new Date(maybe);
            const mm = String(d.getUTCMonth()+1).padStart(2,'0');
            const dd = String(d.getUTCDate()).padStart(2,'0');
            dateStr = `${d.getUTCFullYear()}-${mm}-${dd}`;
          }
        }
        if (tenantUserId && staffId && dateStr) {
          const dateISO = new Date(`${dateStr}T12:00:00.000Z`).toISOString();
          const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
          if (!staff) return;
          let slotOverride = undefined;
          try {
            const dbNative = getDB();
            const sess = await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { service_minutes: 1 } });
            if (sess?.service_minutes) slotOverride = Number(sess.service_minutes);
          } catch {}
          const avail = await listAvailability({ userId: tenantUserId, staffId: String(staffId), dateISO, days: 1, slotMinutes: slotOverride });
          let slots = avail[0]?.slots || [];
          const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
          slots = slots.filter((s) => new Date(s.start).getTime() >= Date.now() + minLeadMs);
          if (!slots.length) { const n = await generateAssistantNudge('no_times', {}, aiOpts(tenant)); await sendTextTracked(from, n, cfg); return; }
          await sendDayAvailabilityText({
            from,
            tenantUserId,
            staffId: String(staffId),
            startISODate: dateISO,
            tod: null,
            cfg,
            staff,
            skipIntro: false,
          });
        } else {
          { const n = await generateAssistantNudge('ask_range', {}, aiOpts(tenant)); await sendTextTracked(from, n, cfg); }
        }
      } catch {
        await sendTextTracked(from, tr('load_times_error', cfg?.__lang), cfg);
      }
      return;
    }
    if (id.startsWith('BOOK_SLOT_')) {
      try {
        const parts = id.split('_');
        const staffId = parts[parts.length - 1];
        const endISO = parts[parts.length - 2];
        const startISO = parts[parts.length - 3];
        if (tenantUserId && staffId && startISO && endISO) {
          const histForBook = await loadThreadHistoryForBooking(tenantUserId, from, title || "");
          const details = buildBookingNotesFromConversation({
            text: title || "",
            historyMessages: histForBook,
            intentData: {},
            knownCustomerName: "",
          });
          const r = await createBooking({
            userId: tenantUserId,
            staffId: String(staffId),
            startISO,
            endISO,
            contactPhone: from,
            notes: details.notes,
          });
          let staff = null;
          try {
            staff = await getDB().collection("staff").findOne(
              { _id: staffId },
              { projection: { name: 1, timezone: 1 } }
            );
          } catch {}
          const when = new Date(startISO).toLocaleString(cfg?.__lang === "sq" ? "sq-AL" : undefined, {
            timeZone: staff?.timezone || "UTC",
            dateStyle: "medium",
            timeStyle: "short",
          });
          await sendOrganicBookingConfirmation({
            req,
            tenantUserId,
            from,
            cfg,
            tenant,
            staff: staff || { _id: staffId },
            startISO,
            endISO,
            bookingId: r.id,
            when,
            details: { ...details, name: details.name },
          });
          try {
            await getDB().collection("booking_sessions").deleteOne({ user_id: String(tenantUserId), contact_id: String(from) });
          } catch {}
        } else {
          { const n = await generateAssistantNudge('slot_book_failed', {}, aiOpts(tenant)); await sendTextTracked(from, n, cfg); }
        }
      } catch {
        { const n = await generateAssistantNudge('slot_book_failed', {}, aiOpts(tenant)); await sendTextTracked(from, n || tr('slot_book_failed', cfg?.__lang), cfg); }
      }
      return;
    }
  }
  function isValidWebhookPayload(p) {
    try {
      const changeNode = (() => {
        const entryNode = Array.isArray(p?.entry) ? p.entry[0] : (p?.entry && typeof p.entry === 'object' ? Object.values(p.entry)[0] : undefined);
        const ch = Array.isArray(entryNode?.changes) ? entryNode.changes[0] : (entryNode?.changes && typeof entryNode.changes === 'object' ? Object.values(entryNode.changes)[0] : undefined);
        return ch;
      })();
      const val = changeNode?.value || changeNode || {};
      const hasMsgs = Array.isArray(val?.messages) || (val?.messages && typeof val.messages === 'object' && Object.values(val.messages).length > 0);
      const hasStatuses = Array.isArray(val?.statuses) || (val?.statuses && typeof val.statuses === 'object' && Object.values(val.statuses).length > 0);
      const hasEchoes = ['message_echoes', 'smb_message_echoes'].some((key) => {
        const raw = val?.[key];
        return Array.isArray(raw) ? raw.length > 0 : (raw && typeof raw === 'object' && Object.values(raw).length > 0);
      });
      return hasMsgs || hasStatuses || hasEchoes;
    } catch { return false; }
  }
  app.post("/test-webhook", async (req, res) => {
    if (!process.env.ENABLE_TEST_WEBHOOK) {
      return res.status(404).send('Not Found');
    }
    try {
      const payload = req.body;
      const firstOf = (x) => Array.isArray(x) ? x[0] : (x && typeof x === 'object' ? Object.values(x)[0] : undefined);
      const entry = firstOf(payload.entry);
      const changeNode = firstOf(entry?.changes);
      const change = changeNode?.value || changeNode;
      const msgArr = Array.isArray(change?.messages) ? change.messages : (change?.messages && typeof change.messages === 'object' ? Object.values(change.messages) : []);
      const message = msgArr?.[0];
      
      if (!message) {
        return res.sendStatus(200);
      }

      const metadata = change?.metadata;
      const tenant = (await cachedFindSettingsByPhoneNumberId(metadata?.phone_number_id)) || (await cachedFindSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, "")));
      const tenantUserId = tenant?.user_id || null;
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      if (DEBUG_LOGS) console.log('[Webhook] Tenant resolution:', {
        phone_number_id: metadata?.phone_number_id || null,
        businessNumber,
        tenantFound: !!tenant,
        tenantUserId
      });
      
      if (businessNumber && message.from === businessNumber) {
        return res.sendStatus(200);
      }
      
      const cfg = { ...tenant, user_id: tenantUserId };
      let tenantPlan = null;
      try {
        tenantPlan = await getUserPlan(tenantUserId);
        if ((tenantPlan?.plan_name || 'free') === 'free') {
          cfg.conversation_mode = 'escalation';
          cfg.bookings_enabled = 0;
          cfg.reminders_enabled = 0;
        }
      } catch {
        tenantPlan = null;
      }
      const from = message.from;
      let text = message.text?.body || "";

      if (DEBUG_LOGS) console.log("Test webhook received:", { from, text, tenantUserId, conversation_mode: cfg.conversation_mode });
      if (cfg.conversation_mode === 'escalation') {
        if (DEBUG_LOGS) console.log("Simple Escalation Mode active in test");
        const state = db.prepare(`SELECT escalation_step FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (!state) {
          const additionalMessage = String(cfg.escalation_additional_message || "").trim();
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(cfg.escalation_questions_json || '[]');
          } catch {}
          
          let response = additionalMessage;
          if (escalationQuestions[0]) {
            response = response ? `${response}\n\n${escalationQuestions[0]}` : escalationQuestions[0];
          }
          if (!response) {
            response = await generateAssistantNudge('handoff_ask_name', {}, aiOpts(tenant));
          }
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, escalation_questions_json, escalation_question_index, updated_at)
              VALUES (?, ?, 'ask_question', ?, 0, strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, escalation_questions_json = excluded.escalation_questions_json, escalation_question_index = excluded.escalation_question_index, updated_at = excluded.updated_at`).run(from, tenantUserId, JSON.stringify(escalationQuestions));
          } catch {}
          
          return res.json({ success: true, response: response, type: "escalation_first_message" });
        }
        const currentState = db.prepare(`SELECT escalation_step, escalation_questions_json, escalation_question_index FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (currentState?.escalation_step === 'ask_question') {
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(currentState.escalation_questions_json || '[]');
          } catch {}
        
          
          const currentIndex = currentState.escalation_question_index || 0;
          const nextIndex = currentIndex + 1;
          const answerKey = `escalation_answer_${currentIndex}`;
          try {
            db.prepare(`UPDATE handoff SET ${answerKey} = ?, escalation_question_index = ?, updated_at = strftime('%s','now') WHERE contact_id = ? AND user_id = ?`).run(text, nextIndex, from, tenantUserId);
          } catch {}
          if (nextIndex < escalationQuestions.length) {
            return res.json({ success: true, response: escalationQuestions[nextIndex], type: "escalation_ask_question" });
          } else {
            return res.json({ success: true, response: await generateAssistantNudge('handoff_connecting', {}, aiOpts(tenant)), type: "escalation_complete" });
          }
        }
        
        return res.json({ success: true, response: "What's your name?", type: "escalation_ask_name" });
      }
      const kbMatchesBase = await cachedRetrieveKbMatches(text, 8, tenantUserId, '', from, tenant?.__lang || cfg?.__lang);
      const prof = await buildCustomerProfileSnippet(tenantUserId, from);
      const kbMatches = buildAiContextSnippets(cfg, { kbMatches: kbMatchesBase, profileSnippet: prof });
      if (DEBUG_LOGS) console.log("KB Matches:", Array.isArray(kbMatches) ? kbMatches : []);
      
      const aiStart = Date.now();
      const aiReply = await generateAiReply(text, kbMatches, {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics,
        businessType: cfg?.business_type || '',
        businessCategories: (() => { try { const arr = JSON.parse(cfg?.business_categories_json || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; } })()
      });
      try { businessMetrics.trackAIRequest(true, Date.now() - aiStart); } catch {}
      if (DEBUG_LOGS) console.log("AI Reply:", aiReply);
      return res.json({ success: true, response: aiReply, type: "kb_response", kbMatches: Array.isArray(kbMatches) ? kbMatches.length : 0 });
      
    } catch (e) {
      console.error("Test webhook error:", e);
      return res.status(500).json({ error: e.message });
    }
  });
  app.get("/webhook", rateLimit, (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const s = findSettingsByVerifyToken(token);
    if (mode === "subscribe" && s) {
      if (DEBUG_LOGS) console.log("[WEBHOOK][GET] verified", {
        mode,
        tokenPresent: !!token,
        challengePresent: !!challenge
      });
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });
  app.post("/webhook", rateLimit, async (req, res) => {
    try {
      const maxBytes = Number(process.env.WEBHOOK_MAX_BYTES || 1048576);      const contentLen = Number(req.headers['content-length'] || 0);
      if (contentLen && contentLen > maxBytes) {
        res.setHeader('Connection', 'close');
        return res.status(413).send('Payload too large');
      }
      try {
        const rawLen = req.rawBody instanceof Buffer
          ? req.rawBody.length
          : Buffer.byteLength(JSON.stringify(req.body || {}));
        if (rawLen > maxBytes) {
          res.setHeader('Connection', 'close');
          return res.status(413).send('Payload too large');
        }
      } catch {}
      const sig = req.header("X-Hub-Signature-256") || req.header("x-hub-signature-256");
      let s = {};
      try {
        const obj = JSON.parse((req.rawBody || Buffer.from("{}"))?.toString("utf8"));
        const firstOf = (x) => Array.isArray(x) ? x[0] : (x && typeof x === 'object' ? Object.values(x)[0] : undefined);
        const entry = firstOf(obj?.entry);
        const changeNode = firstOf(entry?.changes);
        const change = changeNode?.value || changeNode;
        const pnid = change?.metadata?.phone_number_id || null;
        if (pnid) {
          s = (await findSettingsByPhoneNumberId(pnid)) || {};
        }
      } catch {}
      const REQUIRE_SIG = (process.env.NODE_ENV === 'production') && (process.env.REQUIRE_WEBHOOK_SIGNATURE !== '0');
      if (REQUIRE_SIG && (!sig || !s.app_secret)) {
        return res.sendStatus(403);
      }
      if (s.app_secret && sig) {
        const [algo, theirHex] = String(sig||'').split("=");
        if (algo !== "sha256") return res.sendStatus(403);
        const raw = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        const hmac = crypto.createHmac("sha256", s.app_secret);
        hmac.update(raw);
        const oursHex = hmac.digest("hex");
        try {
          const a = Buffer.from(oursHex, 'hex');
          const b = Buffer.from(theirHex || '', 'hex');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            req.log?.warn({ theirs: theirHex ? theirHex.slice(0,8)+'...' : 'missing' }, "Invalid webhook signature");
            return res.sendStatus(403);
          }
        } catch {
          return res.sendStatus(403);
        }
      }

      const payload = req.body;
      if (!isValidWebhookPayload(payload)) {
        if (DEBUG_LOGS) {
          try { console.log("[WEBHOOK] Invalid payload shape", JSON.stringify(payload).slice(0,500)); } catch { console.log("[WEBHOOK] Invalid payload shape"); }
        }
        return res.sendStatus(200);
      }
      const firstOf = (x) => Array.isArray(x) ? x[0] : (x && typeof x === 'object' ? Object.values(x)[0] : undefined);
      const entry = firstOf(payload.entry);
      const changeNode = firstOf(entry?.changes);
      const change = changeNode?.value || changeNode;
      const statusesRaw = change?.statuses;
      const statuses = Array.isArray(statusesRaw) ? statusesRaw : (statusesRaw && typeof statusesRaw === 'object' ? Object.values(statusesRaw) : []);
      const metadata = change?.metadata;
      const tenantSettings = (await cachedFindSettingsByPhoneNumberId(metadata?.phone_number_id)) || (await cachedFindSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, "")));
      const tenantUserId = tenantSettings?.user_id || null;
      try {
        const limit = Number(process.env.WEBHOOK_TENANT_LIMIT || 120);
        const windowSec = Number(process.env.WEBHOOK_TENANT_WINDOW || 60);
        if (tenantUserId) {
          const rl = await rateLimiter.checkLimit(`tenant:${tenantUserId}:webhook`, limit, windowSec);
          if (!rl.allowed) {
            res.setHeader('Retry-After', Math.ceil((rl.resetTime - Date.now())/1000));
            return res.status(429).send('Rate limit exceeded');
          }
        }
      } catch {}
      
      if (DEBUG_LOGS) console.log("Webhook received payload:", JSON.stringify(payload, null, 2));

      try {
        if (tenantUserId) {
          await handleCoexistenceMessageEchoes({
            tenantUserId,
            change,
            webhookField: changeNode?.field || null,
          });
        }
      } catch (e) {
        console.error("[Webhook] Coexistence echo handling failed:", e?.message || e);
      }

      if (Array.isArray(statuses) && statuses.length > 0) {
        try {
          const dbNative = getDB();
          for (const st of statuses) {
            const status = st.status;
            const recipientId = st.recipient_id;
            const messageId = st.id || st.message_id;
            const tsNum = st.timestamp ? Number(st.timestamp) : null;
            const error = Array.isArray(st.errors) ? st.errors[0] : undefined;
            if (!messageId || !status) continue;
            try {
              const ttl = Number(process.env.STATUS_NONCE_TTL || 600);
              if (isRedisConnected()) {
                const redis = getRedisClient();
                const skey = `wp:status:${tenantUserId || 'null'}:${messageId}:${status}:${tsNum || 0}`;
                const r = await redis.set(skey, '1', 'EX', ttl, 'NX');
                if (r !== 'OK') continue;              } else {
                const nkey = `status:${tenantUserId || 'null'}:${messageId}:${status}:${tsNum || 0}`;
                const now = Date.now();
                const rec = memStatus.get(nkey);
                if (rec && rec > now) continue;
                memStatus.set(nkey, now + ttl*1000);
              }
            } catch {}
            try {
              await dbNative.collection('message_statuses').updateOne(
                { message_id: messageId, status, timestamp: tsNum, user_id: tenantUserId || null },
                { $setOnInsert: {
                    message_id: messageId,
                    status,
                    recipient_id: recipientId || null,
                    timestamp: tsNum,
                    error_code: error?.code ?? null,
                    error_title: error?.title ?? null,
                    error_message: error?.message ?? null,
                    user_id: tenantUserId || null,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } },
                { upsert: true }
              );
            } catch {}
            try {
              if (status === 'read') {
                await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.READ, tsNum || undefined);
                await updateMessageReadStatus(messageId, READ_STATUS.READ, tsNum || undefined);
              } else if (status === 'delivered') {
                await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.DELIVERED, tsNum || undefined);
              } else if (status === 'sent') {
                await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.SENT, tsNum || undefined);
              } else if (status === 'failed') {
                await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.FAILED, tsNum || undefined);
              }
            } catch {}
            try {
              if (tenantUserId) {
                const messageDoc = await dbNative.collection('messages').findOne(
                  { id: messageId, user_id: String(tenantUserId) },
                  { projection: { from_digits: 1, to_digits: 1, direction: 1 } }
                );
                const phone =
                  String(recipientId || '').replace(/\D/g, '') ||
                  (messageDoc?.direction === 'inbound'
                    ? (messageDoc?.from_digits || messageDoc?.to_digits)
                    : (messageDoc?.to_digits || messageDoc?.from_digits));
                if (phone) {
                  const statusData = {
                    messageId,
                    status,
                    recipientId,
                    timestamp: tsNum,
                    error: error ? { code: error.code, title: error.title, message: error.message } : null
                  };
                  broadcastMessageStatus(tenantUserId, phone, messageId, status, statusData);
                  if (DEBUG_LOGS) console.log(`📡 Broadcasted message status update: ${status} for message ${messageId}`);
                }
              }
            } catch {}
          }
        } catch {}
      }

      const _msgArr = Array.isArray(change?.messages) ? change.messages : (change?.messages && typeof change.messages === 'object' ? Object.values(change.messages) : []);
      const message = _msgArr?.[0];
      if (!message) {
      if (DEBUG_LOGS) console.log("No message found in webhook payload");
        return res.sendStatus(200);
      }
      
      if (DEBUG_LOGS) console.log("Processing message:", message);

      const inboundGroupId = String(message.group_id || "").trim();
      if (inboundGroupId) {
        const groupText = String(message.text?.body || "").trim();
        const groupCfg = tenantUserId && tenantSettings
          ? { ...tenantSettings, user_id: tenantUserId }
          : null;

        if (tenantUserId && isStaffGroupConnectCommand(groupText)) {
          try {
            await upsertSettingsForUser(tenantUserId, {
              staff_whatsapp_group_id: inboundGroupId,
              staff_whatsapp_group_enabled: true,
            });
            if (groupCfg?.whatsapp_token && groupCfg?.phone_number_id) {
              const businessName = String(tenantSettings?.business_name || "your business").trim();
              await sendWhatsAppGroupText(
                inboundGroupId,
                `✅ Staff group connected for ${businessName}. New reservations will be posted here.`,
                groupCfg
              );
            }
            if (DEBUG_LOGS) {
              console.log("[Webhook] Staff group connected:", {
                tenantUserId,
                groupId: inboundGroupId.slice(0, 24),
              });
            }
          } catch (e) {
            console.error("[Webhook] Failed to connect staff group:", e?.message || e);
          }
        } else if (DEBUG_LOGS) {
          console.log("[Webhook] Ignoring group message", {
            groupId: inboundGroupId.slice(0, 24),
            type: message.type,
          });
        }
        return res.sendStatus(200);
      }

      if (message.type === 'reaction') {
        if (DEBUG_LOGS) console.log("Received reaction message, skipping bot processing");
        try {
          
          if (tenantUserId && message.reaction && message.reaction.message_id) {
            const customerUserId = `customer_${message.from}`;
            const phone = normalizePhone(message.from);
            if (message.reaction.emoji && message.reaction.emoji.trim() !== '') {
              const result = addReaction(message.reaction.message_id, customerUserId, message.reaction.emoji);
              if (DEBUG_LOGS) console.log("Stored customer reaction:", result);
              if (result.success) {
                const reactionData = {
                  messageId: message.reaction.message_id,
                  emoji: message.reaction.emoji,
                  userId: customerUserId,
                  added: true,
                  removed: false
                };
                
                broadcastReaction(tenantUserId, phone, message.reaction.message_id, message.reaction.emoji, 'added', reactionData);
                if (DEBUG_LOGS) console.log("📡 Broadcasted customer reaction addition to agents");
              }
            } else {
              if (DEBUG_LOGS) console.log("Received reaction removal from customer");
              const dbNative = getDB();
              const latestReaction = await dbNative.collection('message_reactions')
                .find({ message_id: message.reaction.message_id, user_id: customerUserId })
                .sort({ createdAt: -1 })
                .limit(1)
                .toArray();
              const existingReactions = latestReaction[0] || null;
              if (existingReactions) {
                const emojiToRemove = existingReactions.emoji;
                const result = removeReaction(message.reaction.message_id, customerUserId, emojiToRemove);
                if (DEBUG_LOGS) console.log("Removed customer reaction:", result);
                if (result.success) {
                  const reactionData = {
                    messageId: message.reaction.message_id,
                    emoji: emojiToRemove,
                    userId: customerUserId,
                    added: false,
                    removed: true
                  };
                  
                  broadcastReaction(tenantUserId, phone, message.reaction.message_id, emojiToRemove, 'removed', reactionData);
                  if (DEBUG_LOGS) console.log("📡 Broadcasted customer reaction removal to agents");
                }
              } else {
                if (DEBUG_LOGS) console.log("No existing reaction found to remove for customer");
              }
            }
          }
        } catch (error) {
          console.error("Error storing customer reaction:", error);
        }
        
        return res.sendStatus(200);
      }
      if (message.context && message.context.id) {
        if (DEBUG_LOGS) console.log("Received reply message; storing and deciding whether to suppress bot");

        try {
          if (tenantUserId && message.from && message.text?.body) {
            const messageId = message.id;
            const textBody = message.text.body;
            const timestamp = message.timestamp;
            const businessPhone = metadata?.display_phone_number?.replace(/\D/g, "");

            const inserted = await recordInboundMessage({
              messageId,
              userId: tenantUserId,
              from: message.from,
              businessPhone,
              type: 'text',
              text: textBody,
              timestamp: timestamp ? Number(timestamp) : undefined,
              raw: message
            });
            if (inserted) {
              if (DEBUG_LOGS) console.log("Stored customer reply message:", messageId);
            }
            try {
              const { createReply } = await import('../services/replies.mjs');
              const replyResult = createReply(message.context.id, messageId);
              if (DEBUG_LOGS) console.log("Created customer reply relationship:", replyResult);
            } catch (error) {
              console.error("Error creating customer reply relationship:", error);
            }
          }
        } catch (error) {
          console.error("Error storing customer reply message:", error);
        }
        let shouldSuppressBot = false;
        try {
          let hsSql = null;
          let hsMongo = null;
          try {
            hsSql = db.prepare(`SELECT is_human, COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(message.from, tenantUserId);
          } catch {}
          try {
            const doc = await Handoff.findOne({ user_id: tenantUserId, contact_id: message.from }).select('is_human human_expires_ts').lean();
            if (doc) hsMongo = { is_human: !!doc.is_human, exp: Number(doc.human_expires_ts || 0) };
          } catch {}
          const now = Math.floor(Date.now()/1000);
          const sqlLive = !!(hsSql?.is_human && (!hsSql.exp || hsSql.exp > now));
          const mongoLive = !!(hsMongo?.is_human && (!hsMongo.exp || hsMongo.exp > now));
          shouldSuppressBot = sqlLive || mongoLive;
        } catch {}

        if (shouldSuppressBot) {
          if (DEBUG_LOGS) console.log("Reply received while human live; suppressing bot");
          return res.sendStatus(200);
        }
      }

      // Use a per-request shallow copy: tenantSettings may be a shared/cached
      // object, and we stash request-scoped state (e.g. __lang) on `tenant`/`cfg`.
      const tenant = { ...tenantSettings };
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      if (businessNumber && message.from === businessNumber) {
        return res.sendStatus(200);
      }
      const cfg = { ...tenant, user_id: tenantUserId };
      let tenantPlan = null;
      try {
        tenantPlan = await getUserPlan(tenantUserId);
        if ((tenantPlan?.plan_name || 'free') === 'free') {
          cfg.conversation_mode = 'escalation';
          cfg.bookings_enabled = 0;
          cfg.reminders_enabled = 0;
        }
      } catch {
        tenantPlan = null;
      }
      const from = message.from;
      const fromDigits = digitsOnly(from);
      let text = message.text?.body || "";
      let mediaUrl = null;
      let normalizedType = message.type || 'text';
      if (normalizedType === 'image' && message.image) {
        mediaUrl = message.image.link || null;
        if (!mediaUrl && message.image.id) {
          mediaUrl = `/wa-media/${encodeURIComponent(String(tenantUserId))}/${encodeURIComponent(String(message.image.id))}`;
        }
      }
      try { businessMetrics.trackWhatsAppMessage('received', normalizedType || 'text'); } catch {}
      let humanActive = false;
      let humanLive = false;      try {
        let hsSql = null;
        let hsMongo = null;
        try {
          hsSql = db.prepare(`SELECT is_human, COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        } catch {}
        try {
          const doc = await Handoff.findOne({ user_id: tenantUserId, contact_id: from }).select('is_human human_expires_ts last_seen_ts').lean();
          if (doc) hsMongo = { is_human: !!doc.is_human, exp: Number(doc.human_expires_ts || 0), lastSeen: Number(doc.last_seen_ts || 0) };
        } catch {}

        const now = Math.floor(Date.now()/1000);
        const seenWindow = Number(process.env.LIVE_SEEN_WINDOW_SEC || 180);        const sqlLive = !!(hsSql?.is_human && (!hsSql.exp || hsSql.exp > now));
        const mongoLive = !!(hsMongo?.is_human && (!hsMongo.exp || hsMongo.exp > now));
        const lastSeenTs = Math.max(Number(hsSql?.lastSeen || 0), Number(hsMongo?.lastSeen || 0));

        humanLive = mongoLive || sqlLive;        humanActive = humanLive;
      } catch {}

      const inboundId = message.id;
      try {
        if (inboundId && tenantUserId && isRedisConnected()) {
          const redis = getRedisClient();
          const nonceKey = `wp:nonce:${tenantUserId}:${inboundId}`;
          const ttl = Number(process.env.WEBHOOK_NONCE_TTL || 600);
          const result = await redis.set(nonceKey, '1', 'EX', ttl, 'NX');
          if (result !== 'OK') {
            return res.sendStatus(200);
          }
        }
      } catch {}
      if (inboundId) {
        try {
          const inserted = await recordAndBroadcastInbound({ message, tenantUserId, metadata, normalizedType, text, mediaUrl });
          if (DEBUG_LOGS) console.log('[Webhook] Inbound record result:', { inserted, inboundId });
          // Meta often retries the same webhook delivery; don't answer twice.
          if (!inserted) {
            try {
              const exists = await getDB().collection('messages').findOne(
                { id: String(inboundId) },
                { projection: { _id: 1 } }
              );
              if (exists) return res.sendStatus(200);
            } catch {}
          }
        } catch (e) {
          console.warn('[Webhook] Failed to record inbound message, continuing to process reply anyway:', e?.message || e);
        }
      }
      try {
        if (tenantUserId && from) {
          const cust = await Customer.findOne({ user_id: tenantUserId, contact_id: from }).lean();
          const now = Math.floor(Date.now()/1000);
          if (cust?.opted_out) return res.sendStatus(200);
          if (cust?.blocked_until_ts && cust.blocked_until_ts > now) return res.sendStatus(200);
        }
      } catch {}
      let awaitingRating = false;
      try {
        const dbNative = getDB();
        const cs = await dbNative.collection('contact_state').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { await_rating: 1 } });
        awaitingRating = !!cs?.await_rating;
        if (awaitingRating) {
          const rawText = String(text || '');
          const emojiMatch = /[\u{1F600}-\u{1F64F}\u{1F920}-\u{1F9FF}\u{1F300}-\u{1F5FF}]/u.exec(rawText);
          const emoji = emojiMatch ? emojiMatch[0] : null;
          const emojiScores = { '😡':1, '😕':2, '🙂':3, '😀':4, '🤩':5, '😠':1, '😢':2, '😃':4, '😄':4, '😁':4, '😍':5 };
          const keywordScores = [
            { match: 'excellent', score: 5 },
            { match: 'amazing', score: 5 },
            { match: 'great', score: 5 },
            { match: 'good', score: 4 },
            { match: 'okay', score: 3 },
            { match: 'ok', score: 3 },
            { match: 'fine', score: 3 },
            { match: 'bad', score: 2 },
            { match: 'poor', score: 2 },
            { match: 'terrible', score: 1 },
            { match: 'awful', score: 1 },
            { match: 'very bad', score: 1 }
          ];
          let score = emoji ? (emojiScores[emoji] || null) : null;
          if (!score) {
            const normalized = rawText.trim().toLowerCase();
            if (normalized) {
              for (const { match, score: s } of keywordScores) {
                if (normalized.includes(match)) {
                  score = s;
                  break;
                }
              }
            }
          }
          if (score) {
            try { await saveCsatRating({ tenantUserId, contactId: from, score, emoji, messageText: rawText }); } catch {}
            return res.sendStatus(200);
          }
        }
      } catch {}
      if (humanActive) {
        return res.sendStatus(200);
      }
      try {
        const overLimit = await isUsageExceeded(tenantUserId);
        if (overLimit) {
          return res.sendStatus(200);
        }
      } catch {}

      if (cfg.conversation_mode === 'escalation') {
        const handledEscalation = await handleSimpleEscalationFlow({ tenantUserId, from, text, cfg });
        if (handledEscalation) return res.sendStatus(200);
      }
      if (message?.type === "interactive") {
        try { incrementCounter('whatsapp_interactive_received', 1, { kind: String(message?.interactive?.type||'unknown') }); } catch {}
        const data = message.interactive;
        try {
          const inboundId = message.id;
          let displayText = '';
          if (data?.type === 'button_reply') {
            displayText = data.button_reply?.title || '';
          } else if (data?.type === 'list_reply') {
            displayText = data.list_reply?.title || '';
          }
          const insertedInt = await recordInboundMessage({
            messageId: inboundId,
            userId: tenantUserId,
            from,
            businessPhone: metadata?.display_phone_number?.replace(/\D/g, ""),
            type: 'interactive',
            text: displayText || null,
            timestamp: message.timestamp ? Number(message.timestamp) : undefined,
            raw: message
          });
          if (insertedInt) {
            const messageData = {
              id: inboundId,
              direction: 'inbound',
              type: 'interactive',
              text_body: displayText || null,
              timestamp: message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000),
              from_digits: normalizePhone(from),
              to_digits: normalizePhone(metadata?.display_phone_number),
              contact_name: null,
              contact: from,
              formatted_time: new Date((message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000)) * 1000).toLocaleString(),
              media_url: null
            };
            try { broadcastNewMessage(tenantUserId, from, messageData); } catch {}
          }
        } catch {}
        if (data?.type === "button_reply") {
          const { id, title } = data.button_reply || {};
          await handleButtonReply({ id, title, tenantUserId, from, cfg });
          return res.sendStatus(200);
        }
        if (data?.type === "list_reply") {
          const { id, title } = data.list_reply || {};
          await handleListReply({ id, title, tenantUserId, from, cfg, req });
          return res.sendStatus(200);
        }
        return res.sendStatus(200);
      }
      try {
        text = await maybeJoinRecentFragments({ text, from, tenantUserId, timestampSec: Number(message.timestamp || Math.floor(Date.now()/1000)) });
      } catch {}
      // Detect the conversation language (Albanian vs English) and remember it,
      // so the assistant replies like a native speaker and stays consistent even
      // when later messages are short/ambiguous (e.g. "ok", a time, an emoji).
      let lang = 'en';
      try {
        const langMem = await getContactMemory(tenantUserId, from);
        let sessionLang = null;
        try {
          const dbNative = getDB();
          const activeSess = await dbNative.collection("booking_sessions").findOne(
            { user_id: String(tenantUserId), contact_id: String(from), step: { $in: ["awaiting_cancel_confirm", "awaiting_reschedule_dt"] } },
            { projection: { lang: 1 } }
          );
          sessionLang = activeSess?.lang;
        } catch {}
        const detected = detectLanguage(text);
        lang = resolveLanguage(text, langMem?.lang, sessionLang);
        if (detected && detected !== langMem?.lang) {
          try { await updateContactMemory(tenantUserId, from, { lang: detected }); } catch {}
        }
      } catch {}
      try { if (tenant) tenant.__lang = lang; } catch {}
      try { if (cfg) cfg.__lang = lang; } catch {}
      // NOTE: The greeting/menu, spam-suppression, and acknowledgement-reaction
      // short-circuits were intentionally removed so that EVERY inbound message
      // (greetings, acks, questions, etc.) flows through the bilingual AI for a
      // smooth, natural reply in the customer's own language (Albanian/English).
      if (/\btest\s+reminder\b/i.test(text || "")) {
        let appt = await findUpcomingConfirmedAppointment({ userId: tenantUserId, digits: fromDigits });
        if (!appt) {
          const staff = db.prepare(`SELECT id, slot_minutes FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
          if (staff?.id) {
            const startISO = new Date(Date.now() + 60*60000).toISOString();
            const endISO = new Date(Date.now() + (60 + (Number(staff.slot_minutes||30))) * 60000).toISOString();
            try {
              const r = await createBooking({ userId: tenantUserId, staffId: staff.id, startISO, endISO, contactPhone: from, notes: 'TEST REMINDER' });
              const createdArr = await getDB().collection('appointments')
                .find({ id: r.id })
                .project({ id: 1, start_ts: 1, staff_id: 1 })
                .limit(1)
                .toArray();
              appt = createdArr[0] || null;
            } catch {}
          }
        }
        if (!appt) { await sendWhatsAppText(from, "No staff is configured or booking could not be created for test.", cfg); return res.sendStatus(200); }
        const when = new Date((appt.start_ts||0)*1000).toLocaleString();
        await sendButtonTracked(from, `Reminder: your appointment is at ${when}. Is this still correct?`, [
          { id: `REM_OK_${appt.id}`, title: 'Correct' },
          { id: `REM_CANCEL_${appt.id}`, title: 'Cancel' },
          { id: `REM_RESCHED_${appt.id}`, title: 'Reschedule' }
        ], cfg);
        return res.sendStatus(200);
      }
      // NOTE: The canned "when is my booking" and "previous agent" lookups were
      // removed. The bilingual AI already receives the customer's profile
      // (upcoming/last appointment + last agent) as context and answers these
      // naturally in the customer's language.
      if (tenantUserId && message.type === 'text') {
        if (await handleStructuredBookingSession({ tenantUserId, from, text, cfg, fromDigits })) {
          return res.sendStatus(200);
        }
      }
      const sess = tenantUserId ? await (async () => {
        try {
          const dbNative = getDB();
          return await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) });
        } catch { return null; }
      })() : null;
      if (tenantUserId && sess && message.type === 'text' && String(sess.step || '') === 'pending') {
        try {
          await getDB().collection('booking_sessions').deleteOne({ _id: sess._id });
        } catch {}
      }
      const sqText = stripAccentsLower(text || "");
      const wantsReset = /\b(reset\s+booking|start\s*over|clear\s+(booking|appointment))\b/i.test(text || "")
        || /\b(fillo\s+nga\s+e\s+para|rifillo|pastro\s+(rezervimin|terminin))\b/.test(sqText);
      if (cfg?.bookings_enabled && wantsReset) {
        try { await getDB().collection('booking_sessions').deleteOne({ user_id: String(tenantUserId), contact_id: String(from) }); } catch {}
        const n = await generateAssistantNudge('reset_done', {}, aiOpts(tenant));
        await sendTextTracked(from, n, cfg);
        return res.sendStatus(200);
      }
      const wantsWaitlist = /\b(waitlist|notify\s+(me\s+)?(if\s+)?(earlier|sooner)|earlier\s+slot|sooner\s+(time|slot))\b/i.test(text || "")
        || /\b(njoftom|me\s+njofto|lajmerom|me\s+lajmero)\b.*\b(hapet|lirohet|orar\s+me\s+i\s+hershem|me\s+heret)\b/.test(sqText);
      if (cfg?.bookings_enabled && cfg?.waitlist_enabled && wantsWaitlist) {
        try {
          const dbNative = getDB();
          const appt = await findUpcomingConfirmedAppointment({
            userId: tenantUserId,
            digits: fromDigits,
            projection: { start_ts: 1, staff_id: 1 }
          });
          if (appt?.staff_id && appt?.start_ts) {
            const dateKey = formatYmdFromTs(appt.start_ts);
            await dbNative.collection('waitlist').updateOne(
              { user_id: String(tenantUserId), contact_id: String(from), staff_id: appt.staff_id, date: dateKey },
              { $set: { user_id: String(tenantUserId), contact_id: String(from), staff_id: appt.staff_id, date: dateKey, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
              { upsert: true }
            );
            await sendTextTracked(from, tr('waitlist_added', cfg?.__lang), cfg);
            return res.sendStatus(200);
          }
        } catch {}
      }

      let historyMessages = [];
      let conversationStarted = false;
      let lastInboundBeforeCurrentSec = null;
      try {
        const hist = await listMessagesForThread(tenantUserId, from);
        const trimmed = Array.isArray(hist) ? hist.slice(-12) : [];
        const priorInbounds = trimmed.filter(
          (m) => m.direction === "inbound" && String(m.text_body || "").trim() !== String(text || "").trim()
        );
        lastInboundBeforeCurrentSec = priorInbounds.length
          ? Number(priorInbounds[priorInbounds.length - 1].ts || 0) || null
          : null;
        historyMessages = trimmed
          .map(m => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: String(m.text_body || '') }))
          .filter(h => h.content && h.content.trim() && h.content.trim() !== String(text || '').trim());
        conversationStarted = trimmed.some(m => m.direction === 'outbound' && String(m.text_body || '').trim());
      } catch {}

      const shouldGreet = shouldPrefaceWithGreeting({ lastInboundBeforeCurrentSec });

      let knownCustomerName = '';
      try {
        const memEarly = await getContactMemory(tenantUserId, from);
        knownCustomerName = String(memEarly?.display_name || '').trim();
      } catch {}

      if (cfg?.bookings_enabled) {
        const intentDataEarly = {};
        const partyNow = parsePartySize(text);
        if (partyNow) intentDataEarly.partySize = partyNow;
        const sqMsg = stripAccentsLower(text || "");
        const shouldTryFinalize = !isPureBookingAcknowledgement(text) && (
          (partyNow && conversationHasBookableDetails(historyMessages, text, intentDataEarly)) ||
          (BOOKING_CLOSURE_RE.test(sqMsg) && conversationHasBookableDetails(historyMessages, text, intentDataEarly))
        );
        if (shouldTryFinalize) {
          try {
            const finalized = await tryFinalizeBookingFromContext({
              tenantUserId,
              from,
              fromDigits,
              text,
              historyMessages,
              intentData: intentDataEarly,
              cfg,
              tenant,
              req,
              knownCustomerName,
            });
            if (finalized?.handled) return res.sendStatus(200);
          } catch (bookErr) {
            console.error("[book-finalize-early]", bookErr?.message || bookErr);
          }
        }
      }

      const aiOptions = {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics,
        historyMessages,
        lang,
        conversationStarted,
        userMessageIsGreeting: isGreeting(text),
        shouldGreet,
        businessName: cfg?.business_name || '',
        businessType: cfg?.business_type || '',
        businessWebsite: cfg?.website_url || '',
        businessCategories: (() => { try { const arr = JSON.parse(cfg?.business_categories_json || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; } })(),
      };

      try {
        const mem = await getContactMemory(tenantUserId, from);
        if (!knownCustomerName) knownCustomerName = String(mem?.display_name || '').trim();
      } catch {}
      if (!humanActive) {
        console.log('[AI-path] enter', { from: String(from).slice(-6), tenantUserId: String(tenantUserId || ''), textLen: (text || '').length, mode: cfg?.conversation_mode || '' });
        try {
          await runAgentMessagePipeline({
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
            knownCustomerName,
            aiOptions,
            cachedRetrieveKbMatches,
            buildAiContextSnippets,
            findUpcomingConfirmedAppointment,
            sendTextTracked,
            executeAgentIntent,
            finalizeAssistantReply,
            tryReplyWithBusinessLocation,
            isGreeting,
          });
          return res.sendStatus(200);
        } catch (aiErr) {
          console.error('[AI-path] unhandled error:', { message: aiErr?.message || String(aiErr), stack: aiErr?.stack ? String(aiErr.stack).split('\n').slice(0, 3).join(' | ') : null });
          try {
            await sendTextTracked(from, tr('error_generic', cfg?.__lang), cfg);
          } catch (sendErr) {
            console.error('[AI-path] error-notice send failed:', sendErr?.message || sendErr);
          }
          return res.sendStatus(200);
        }
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
      
    } catch (e) {
      console.error("Webhook error:", e);
      return res.sendStatus(500);
    }
  });

}

export { parseDateRange, parseTimeOfDayFilter, parseDateOnly, normalizeTemporal, parseDayOfMonthFromText };

