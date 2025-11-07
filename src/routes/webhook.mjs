/**
 * Webhook routes for Meta (WhatsApp) integration.
 * - GET /webhook: verification handshake
 * - POST /webhook: inbound messages and status updates
 */
import crypto from "node:crypto";
import { getRedisClient, isRedisConnected, rateLimiter } from "../scalability/redis.mjs";
import { db, getDB } from "../db-mongodb.mjs";
import { findSettingsByVerifyToken, findSettingsByPhoneNumberId, findSettingsByBusinessPhone } from "../services/settings.mjs";
import { retrieveKbMatches, buildKbSuggestions } from "../services/kb.mjs";
import { Customer, Handoff, KBItem, Staff } from "../schemas/mongodb.mjs";
import { sendWhatsappButton, sendWhatsAppText, sendWhatsappList, sendWhatsappReaction, sendWhatsappDocument } from "../services/whatsapp.mjs";
import { normalizePhone, buildUtcFromLocalWallTime } from "../utils.mjs";
import { generateAiReply, generateAssistantNudge, generateAgentDecision } from "../services/ai.mjs";
import { buildCustomerProfileSnippet, rememberService, rememberAgent, rememberAppointment, rememberName, updateContactMemory, getContactMemory } from "../services/memory.mjs";
import { listMessagesForThread } from "../services/conversations.mjs";
import { listAvailability, createBooking, rescheduleBooking, cancelBooking, buildDayRows, buildTimeRows } from "../services/booking.mjs";
import { recordOutboundMessage, recordInboundMessage } from "../services/messages.mjs";
import { sendEscalationNotification, sendBookingNotification } from "../services/email.mjs";
import { incrementUsage, getUserPlan } from "../services/usage.mjs";
import { addReaction, removeReaction } from "../services/reactions.mjs";
import { broadcastNewMessage, broadcastReaction, broadcastMessageStatus } from "./realtime.mjs";
import { updateMessageDeliveryStatus, updateMessageReadStatus, READ_STATUS, MESSAGE_STATUS } from "../services/messageStatus.mjs";
import { getConversationStatus, updateConversationStatus, CONVERSATION_STATUSES } from "../services/conversationStatus.mjs";
import { businessMetrics, incrementCounter } from "../monitoring/metrics.mjs";
import { enqueueOutboundMessage, isQueueEnabled } from "../jobs/outboundQueue.mjs";

// Precompiled patterns and caches
const RE_GREETING_SIMPLE = /^(hi|hello|hey|yo|hiya|howdy|greetings)\b/;
const RE_GREETING_GOOD = /^good\s+(morning|afternoon|evening)\b/;
const RE_ACK_ONLY_EMOJI = /^[\u{1F44D}\u{1F44C}\u{1F64F}\u{1F44F}\u{2764}\u{1F60A}\u{1F642}]+$/u;
const ACK_TOKENS = [
  'thanks','thank you','many thanks','appreciated','thx','tnx','thanx','ty','tks','thank u',
  'ok','okay','k','kk','roger','got it','gotcha','cool','nice','great','perfect','awesome','cheers','sounds good','noted','understood'
];
const ACK_TOKENS_SET = new Set(ACK_TOKENS);
const SUBSTANTIVE_INTENT_RE = /(book|booking|reserve|reservation|appointment|order|buy|purchase|price|cost|quote|hours|open|closing|when\s*open|location|address|where|near|deliver|delivery|ship|shipping|pickup|refund|return|exchange|warranty|support|help|issue|problem|complaint|agent|human|connect|cancel|resched|change|modify|update|subscribe|signup|register|payment|pay|invoice|billing|menu|service|services|product|products|availability|slot|table|contact|phone|email)/i;

// In-memory cache for KB matches (per tenant+contact+query) with short TTL
const memKb = new Map();
const KB_CACHE_TTL_MS = Number(process.env.KB_CACHE_TTL_MS || 5000);
function kbCacheKey(userId, contact, text) {
  return `${String(userId||'')}:${String(contact||'')}:${String(text||'').toLowerCase().trim().slice(0,200)}`;
}
async function cachedRetrieveKbMatches(text, limit, userId, scope, contact) {
  try {
    if (!KB_CACHE_TTL_MS || KB_CACHE_TTL_MS <= 0) {
      return await retrieveKbMatches(text, limit, userId, scope);
    }
    const key = kbCacheKey(userId, contact, text);
    const now = Date.now();
    const hit = memKb.get(key);
    if (hit && hit.expires > now) return hit.val;
    const val = await retrieveKbMatches(text, limit, userId, scope);
    memKb.set(key, { val, expires: now + KB_CACHE_TTL_MS });
    return val;
  } catch {
    return await retrieveKbMatches(text, limit, userId, scope);
  }
}

function isGreeting(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;

  if (RE_GREETING_SIMPLE.test(s)) return true;
  if (RE_GREETING_GOOD.test(s)) return true;

  if(["hi", "hello", "hey", "yo", "hiya", "howdy", "greetings", "good morning", "good afternoon", "good evening"].includes(s)) return true;
  return false;
}

function isAcknowledgement(raw) {
  const text = String(raw || '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  if (!text) return false;
  // explicit exclusion for dev/testing commands
  if (/\btest\b/.test(text)) return false;

  // Quick emoji thumbs-up or similar
  const onlyEmoji = text.replace(/[\p{L}\p{N}\s]/gu, '').trim();
  if (RE_ACK_ONLY_EMOJI.test(onlyEmoji)) return true;

  // Exact phrase or token match
  if (ACK_TOKENS_SET.has(text)) return true;

  // Fuzzy match with small typos on phrase and tokens
  const tokens = text.split(' ').filter(Boolean);
  const candidates = [text, ...tokens];
  for (const c of candidates) {
    for (const a of ACK_TOKENS) {
      const lenOk = c.length >= 4 && a.length >= 4;
      if (!lenOk) continue; // avoid false positives like "ok" vs random tokens
      const dist = levenshtein(c, a);
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
  return /\b(human|agent|representative|real person|support|customer service|talk to (a )?human|speak to (a )?human|live chat)\b/.test(s);
}

// Helper: send KB item by title (prefers PDF if present), and record outbound message
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

// Parse full-sentence booking requests: extract desired date and time if present
function parseRequestedDateTime(raw) {
  const text = String(raw || '').toLowerCase();
  const now = new Date();
  const out = { dateISO: null, hour: null, minute: null };

  // Relative dates
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (/\b(today)\b/.test(text)) {
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
    }
  }

  // Month names: "Sep 30", "September 30, 2025"
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

  // Numeric dates: YYYY-MM-DD or DD/MM or MM/DD
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
        // Heuristic: if a > 12 then DD/MM, else if b > 12 then MM/DD, else assume MM/DD
        const mm = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? b : a;
        const dd = (a > 12 || (a <= 31 && b <= 12 && a > b)) ? a : b;
        const yr = c < 100 ? (2000 + c) : c;
        out.dateISO = `${yr}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      }
    }
  }

  // Time: prioritize token after 'at'/'for'.
  // Fallback only if the token is explicit (has ":mm" or am/pm). Avoid picking stray numbers like date ranges (e.g., "Nov 3-10").
  let mt = /(?:\bat|\bfor)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  let matchedByKeyword = !!mt;
  if (!mt) {
    const explicit = Array.from(text.matchAll(/(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*(am|pm)\b/gi));
    if (explicit.length) {
      mt = explicit[explicit.length - 1];
      matchedByKeyword = false;
    }
  }
  if (mt) {
    // Normalize capture groups for both patterns
    const h = mt[1] || mt[3];
    const m = mt[2] || null;
    const ap = (mt[4] || mt[3] || '').toLowerCase();
    let hh = Number(h);
    let mm = Number(m || 0);
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      out.hour = hh; out.minute = mm;
    }
  }

  if (!out.dateISO || out.hour == null) return null;
  return out;
}

// Build a UTC Date that represents a wall-clock time (hour:minute) on dateISO in a given IANA time zone
function buildUtcFromLocalTz(dateISO, hour, minute, tz) {
  return buildUtcFromLocalWallTime(dateISO, hour, minute, tz);
}

// Parse date-only or simple ranges from free text
function parseDateOnly(raw) {
  const text = String(raw || '').toLowerCase();
  const now = new Date();
  // today / tomorrow
  if (/\btoday\b/.test(text)) {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) {
    const d = new Date(Date.now()+86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  // Month name
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
  // Numeric
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
  return null;
}

function parseDateRange(raw) {
  const s = String(raw || '').toLowerCase();
  const todayISO = (()=>{ const d=new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; })();
  // "next X days"
  let m = /next\s+(\d{1,2})\s+day(s)?/.exec(s);
  if (m) { const n = Math.max(1, Number(m[1]||1)); return { startISO: todayISO, days: Math.min(30, n) }; }
  // "this week" (remaining days)
  if (/\bthis\s+week\b/.test(s)) {
    const now = new Date();
    const wd = now.getUTCDay(); // 0=Sun
    const remain = 7 - wd;
    return { startISO: todayISO, days: Math.max(1, remain) };
  }
  // "next week" (next Monday..Sunday)
  if (/\bnext\s+week\b/.test(s)) {
    const d = new Date();
    const delta = ((8 - d.getUTCDay()) % 7) || 7; // days until next Monday
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()+delta));
    return { startISO: `${start.getUTCFullYear()}-${String(start.getUTCMonth()+1).padStart(2,'0')}-${String(start.getUTCDate()).padStart(2,'0')}`, days: 7 };
  }
  // "between X and Y" or "X - Y"
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
  // Single date
  const single = parseDateOnly(s);
  if (single) return { startISO: single, days: 1 };
  return null;
}

function parseTimeOfDayFilter(raw) {
  const s = String(raw || '').toLowerCase();
  if (/\bmorning\b/.test(s)) return { startHour: 6, endHour: 12 };
  if (/\bafternoon\b/.test(s)) return { startHour: 12, endHour: 17 };
  if (/\bevening|night\b/.test(s)) return { startHour: 17, endHour: 21 };
  return null;
}

function parseNameFromMessage(raw) {
  try {
    const s = String(raw || '').trim();
    const m = /(my\s+name\s+is|i\s*am|i'm|im)\s+([a-zA-Z][a-zA-Z'\-]+(?:\s+[a-zA-Z][a-zA-Z'\-]+){0,2})/i.exec(s);
    if (m) {
      const name = m[2].replace(/\s+/g,' ').trim();
      // Title-case
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

    // Ignore pure greetings (short and only greeting tokens)
    const pureGreeting = isGreeting(s) && /^(hi|hello|hey|yo|hiya|howdy|greetings|good\s+(morning|afternoon|evening))\b/.test(s) && s.split(/\s+/).length <= 3;
    if (pureGreeting) return false;

    // Any explicit question is substantive
    if (s.includes('?')) return true;

    // Broad set of common intents across domains (pricing, hours, locations, delivery, support, etc.)
    if (SUBSTANTIVE_INTENT_RE.test(s)) return true;

    // Dates/times/numbers often indicate a request (e.g., "tomorrow 3pm", "2 people")
    if (/(\d{1,2}[:.][0-5]\d\s*(am|pm)?|\b\d{1,2}\s*(am|pm)\b|today|tomorrow|next\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\b\d+\b)/i.test(s)) return true;

    // Otherwise, consider non-trivial free text as substantive
    const wc = s.split(/\s+/).filter(Boolean).length;
    return wc >= 3 || s.length >= 15;
  } catch { return false; }
}

// Escalation session storage: prefer Redis with TTL; fallback to in-memory Map
const memEscalation = new Map();
// Tenant settings cache (PNID/BusinessPhone) with TTL
const memTenant = new Map();
// Status idempotency fallback (when Redis not connected)
const memStatus = new Map();
  // Lightweight spam suppression memory (per tenant+contact)
  const memSpam = new Map(); // key -> { hits: number[] (timestamps ms) }
function memKey(userId, contact) {
  return `${String(userId || '')}:${String(contact || '')}`;
}
// In‑progress holding/throttle memory
const memProgress = new Map(); // key -> { lastHoldingAtMs: number, hits: number[] (timestamps ms) }
async function getMemSession(userId, contact) {
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
  const OUT_OF_SCOPE_PHRASE = 'That seems outside my scope. Try choosing one of these topics';
  function maskPhone(p) {
    try {
      const d = String(p||'').replace(/\D/g,'');
      if (d.length <= 4) return '***';
      return d.slice(0,2) + '******' + d.slice(-2);
    } catch { return '***'; }
  }
  // IP-based rate limiter: Redis if available, fallback to in-memory map
  const rateWindowMs = Number(process.env.WEBHOOK_RATE_WINDOW_MS || 15_000);
  const maxHits = Number(process.env.WEBHOOK_RATE_MAX || 60);
  const hits = new Map(); // fallback: key -> { count, ts }
  const rateLimit = async (req, res, next) => {
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
  
  // Helpers to eliminate duplicated logic
  async function getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg) {
    try {
      // Primary: Mongo native driver (for performance)
      const s = await getDB().collection('staff')
        .find({ user_id: String(tenantUserId) })
        .project({ _id: 1, slot_minutes: 1, timezone: 1, working_hours_json: 1 })
        .sort({ createdAt: 1 })
        .limit(1)
        .toArray();
      let staff = s[0] || null;
      // Fallback: Mongoose model (handles potential typing quirks)
      if (!staff) {
        try {
          const row = await Staff.findOne({ user_id: String(tenantUserId) }).select('_id slot_minutes timezone working_hours_json').lean();
          if (row) staff = { _id: row._id, slot_minutes: row.slot_minutes, timezone: row.timezone, working_hours_json: row.working_hours_json };
        } catch {}
      }
      if (!staff) {
        const n = await generateAssistantNudge('no_staff', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
        await sendTextTracked(from, n || "Bookings are enabled, but no staff is configured yet.", cfg);
        return null;
      }
      return staff;
    } catch {
      const n = await generateAssistantNudge('no_staff', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
      await sendTextTracked(from, n || "Bookings are enabled, but no staff is configured yet.", cfg);
      return null;
    }
  }

  async function sendDayPicker(from, staffId, apptId, cfg, header = 'Pick a day', body = 'Choose a date:') {
    const days = buildDayRows(staffId, apptId);
    await sendListTracked(from, header, body, 'Select', days, cfg);
  }

  async function notifyTooClose(from, minLead, cfg) {
    const n = await generateAssistantNudge('too_close', { minLead }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
    await sendTextTracked(from, n || `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
  }

  // Unified availability presenter: single-day → interactive list; multi-day → text summary
  async function sendAvailabilityRange({ from, tenantUserId, staffId, startISODate, days, tod, cfg, bodyLabel = 'Choose a time:' }) {
    try {
      const effectiveDays = Math.min(14, Math.max(1, Number(days || 1)));
      if (effectiveDays === 1) {
        const rows = await buildTimeRows({ userId: tenantUserId, staffId: String(staffId), dateISO: startISODate, limit: 50, apptId: null });
        if (!Array.isArray(rows) || rows.length === 0) {
          const n = await generateAssistantNudge('no_times', {}, { tone: cfg?.ai_tone, style: cfg?.ai_style });
          await sendTextTracked(from, n, cfg);
          return;
        }
        await sendListTracked(from, `${new Date(startISODate).toLocaleDateString()}`, bodyLabel, 'Select', rows, cfg);
        return;
      }
      const avail = await listAvailability({ userId: tenantUserId, staffId: String(staffId), dateISO: startISODate, days: effectiveDays });
      const lines = [];
      const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
      const cutoff = Date.now() + minLeadMs;
      for (const day of (avail || [])) {
        let slots = day.slots || [];
        slots = slots.filter(s => new Date(s.start).getTime() >= cutoff);
        if (tod) {
          slots = slots.filter(s => { const h = new Date(s.start).getUTCHours(); return h >= tod.startHour && h < tod.endHour; });
        }
        const times = slots.map(s => new Date(s.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
        if (times.length) lines.push(`${new Date(`${day.date}T00:00:00.000Z`).toLocaleDateString()}: ${times.join(', ')}`);
      }
      if (lines.length) {
        await sendTextTracked(from, `Here are available times:\n${lines.join('\n')}`.slice(0, 900), cfg);
      } else {
        const n = await generateAssistantNudge('no_times', {}, { tone: cfg?.ai_tone, style: cfg?.ai_style });
        await sendTextTracked(from, n, cfg);
      }
    } catch {}
  }

  // Service tiers helpers
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
    await sendListTracked(to, 'Choose a service', 'Select a service type:', 'Select', rows, cfg);
    return true;
  }

  // Waitlist helpers
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
          const rows = await buildTimeRows({ userId: tenantUserId, staffId: String(staffId), dateISO, limit: 10, apptId: null });
          if (rows.length) {
            await sendListTracked(w.contact_id, new Date(dateISO).toLocaleDateString(), 'An earlier slot is available. Choose a time:', 'Select', rows, cfg);
          }
        } catch {}
      }
      try { await dbNative.collection('waitlist').deleteMany({ user_id: String(tenantUserId), staff_id: staffId, date: dateKey }); } catch {}
    } catch {}
  }

  // Unified outbound send helpers that also record outbound messages
  async function sendTextTracked(to, text, cfg) {
    if (isQueueEnabled()) {
      try {
        const jobId = await enqueueOutboundMessage({ userId: cfg?.user_id || null, cfg, to, message: text });
        if (jobId) {
          return { messages: [{ id: `queued:${jobId}` }] };
        }
      } catch {}
    }
    const resp = await sendWhatsAppText(to, text, cfg);
    try {
      const outboundId = resp?.messages?.[0]?.id;
      if (outboundId) {
        recordOutboundMessage({ messageId: outboundId, userId: cfg?.user_id || null, cfg, to, type: 'text', text, raw: { to, text } });
        businessMetrics.trackWhatsAppMessage('sent', 'text', true);
      }
    } catch {}
    return resp;
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
          // Provide interactive body so UI can render header instead of [interactive]
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

  // ---------- Refactor helpers (deduplication and flow control) ----------
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
            // Only reopen when the message is substantive (not just 'thanks', emoji, or pure greeting)
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
                // Interactive replies typically mean intent; but CSAT is handled elsewhere and returns early
                shouldReopen = true;
              } else {
                // Media without caption should not reopen by itself
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
        try { const n = await generateAssistantNudge('holding', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); } catch {}
        rec.lastHoldingAtMs = nowMs;
      }
      memProgress.set(key, rec);
      return true;
    } catch {
      return false;
    }
  }

  // Suppress non-substantive spam (e.g., repeated greetings/short messages)
  function maybeSuppressNonSubstantiveSpam(tenantUserId, from, text) {
    try {
      const key = memKey(tenantUserId, from);
      const nowMs = Date.now();
      const windowMs = Number(process.env.SPAM_WINDOW_MS || 20000);
      const threshold = Number(process.env.SPAM_THRESHOLD || 3);
      const rec = memSpam.get(key) || { hits: [] };
      // Drop old hits
      rec.hits = (rec.hits || []).filter(ts => (nowMs - ts) <= windowMs);
      // Always record this hit
      rec.hits.push(nowMs);
      memSpam.set(key, rec);
      // If message is substantive, do not suppress
      if (hasSubstantiveRequest(text)) return false;
      // For non-substantive messages (greetings, acknowledgements, very short), suppress when above threshold
      if (rec.hits.length >= threshold) return true;
    } catch {}
    return false;
  }

  async function handleOutOfHoursGuard(tenantUserId, from, cfg) {
    try {
      if (!tenantUserId) return false;
      const within = await isWithinStaffWorkingHours(tenantUserId, cfg);
      if (!within) {
        const ok = await shouldSendOutOfHours(tenantUserId, from);
        if (ok) {
          const oohMsg = cfg.escalation_out_of_hours_message || await generateAssistantNudge('out_of_hours', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, oohMsg, cfg);
        }
        return true;
      }
    } catch {}
    return false;
  }

  async function maybeJoinRecentFragments({ text, from, tenantUserId, timestampSec }) {
    try {
      const nowSec = Number(timestampSec || Math.floor(Date.now()/1000));
      const digits = String(from || '').replace(/\D/g, '');
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

  async function sendBrandingIfFree({ tenantUserId, to, cfg }) {
    try {
      const plan = await getUserPlan(tenantUserId);
      if ((plan?.plan_name || 'free') === 'free') {
        try { await sendTextTracked(to, 'This chat is powered by Code Orbit.', cfg); } catch {}
      }
    } catch {}
  }

  async function maybeHandleGreeting({ text, tenantUserId, from, cfg }) {
    if (!isGreeting(text)) return false;
    try { incrementCounter('greeting_detected', 1, { userId: String(tenantUserId||'') }); } catch {}
    try {
      const dbNative = getDB();
      const now = Math.floor(Date.now()/1000);
      const st = await dbNative.collection('contact_state').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { last_greet_ts: 1 } });
      const last = st?.last_greet_ts || 0;
      const cooldown = Number(process.env.GREETING_COOLDOWN_SEC || 180);
      if ((now - last) <= cooldown) return true;
      await dbNative.collection('contact_state').updateOne(
        { user_id: String(tenantUserId), contact_id: String(from) },
        { $set: { last_greet_ts: now, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    } catch {}

    const greetText = cfg.entry_greeting || await generateAssistantNudge('greeting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
    if (DEBUG_LOGS) console.log('[Webhook] Sending greeting to customer:', { to: from, greetText });
    const greetResp = await sendTextTracked(from, greetText, cfg);
    await sendBrandingIfFree({ tenantUserId, to: from, cfg });
    if (DEBUG_LOGS) console.log('[Webhook] Greeting send result:', { id: greetResp?.messages?.[0]?.id || null });
    // In Simple Escalation Mode, do not show KB menu on greeting
    if (cfg?.conversation_mode !== 'escalation') {
      const rows = [];
      if (cfg?.bookings_enabled) rows.push({ id: 'GREET_BOOK', title: 'Bookings', description: '' });
      try {
        const docs = await KBItem.find({
          user_id: tenantUserId,
          title: { $exists: true, $ne: '' },
          $or: [ { show_in_menu: 1 }, { show_in_menu: true } ]
        }).select('title').sort({ createdAt: -1, _id: -1 }).limit(20).lean();
        const titles = docs.map(r => String(r.title||'').trim()).filter(Boolean);
        const seen = new Set();
        for (const t of titles) {
          if (rows.length >= 10) break;
          if (seen.has(t)) continue; seen.add(t);
          rows.push({ id: `GREET_KB_TITLE_${encodeURIComponent(t)}`, title: t, description: '' });
        }
      } catch {}
      if (rows.length) {
        const header = 'You can tap one of these to begin:';
        const body = 'Select an option to get started.';
        await sendListTracked(from, header, body, 'Select', rows, cfg);
      }
    }
    return true;
  }

  // Holiday cache
  const memHolidays = new Map(); // key=userId -> { dates:Set<string>, expires:number }
  async function getHolidayDatesForTenant(cfg) {
    const userId = cfg?.user_id || cfg?.userId || null;
    const now = Date.now();
    const ttlMs = Number(process.env.HOLIDAYS_TTL_MS || 12*60*60*1000);
    const key = String(userId||'null');
    const hit = memHolidays.get(key);
    if (hit && hit.expires > now) return hit.dates;
    let dates = new Set();
    try {
      // Closed dates from settings
      try {
        const arr = JSON.parse(cfg?.closed_dates_json || '[]');
        if (Array.isArray(arr)) arr.forEach(d => { if (typeof d === 'string') dates.add(d); });
      } catch {}
      // Optional URL
      if (cfg?.holidays_json_url) {
        const url = String(cfg.holidays_json_url);
        try {
          // Try Redis-backed cache first
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
            // Memory-only fetch
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
      // Date-only closures
      // Note: getHolidayDatesForTenant is async; but in this hot path we only use mem cache if available
      // For simplicity, we will check sync sources first, then fallback to cached async elsewhere.
      try {
        const arr = JSON.parse(cfg?.closed_dates_json || '[]');
        if (Array.isArray(arr) && arr.includes(dateKey)) return true;
      } catch {}

      // Structured rules with time windows
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

  // Throttle helper for Out-of-Hours messages per contact
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

  // Determine if now is within any working-hours slot for the first staff member, considering holidays/closures
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
      if (!s) return true; // no staff configured → do not block
      const working = (() => { try { return JSON.parse(s.working_hours_json || '{}'); } catch { return {}; } })();
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
      // Holiday/closure hard stop (full-day and time-windowed)
      try {
        if (isClosedByHolidayForMoment(cfg||{}, tz, dateKey, hh*60+mm)) return false;
        const hol = await getHolidayDatesForTenant(cfg||{});
        if (hol && hol.has(dateKey)) return false;
      } catch {}
      if (!slots.length) return false; // day has no hours → out of hours
      const nowMin = hh * 60 + mm;
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

  // Encapsulated interactive handlers
  async function handleButtonReply({ id, title, tenantUserId, from, cfg }) {
    if (!id) return;
    if (id === 'BOOKING_START') {
      const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
      if (!staff) return;
      await sendDayPicker(from, staff._id, null, cfg, 'Pick a day', 'Choose a date:');
      return;
    }
    if (id === 'YES_GRAPH') {
      const n = await generateAssistantNudge('generic_ack', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
      await sendTextTracked(from, n || 'Great — sending the report graph now.', cfg);
      return;
    }
    if (id === 'NO_GRAPH') {
      const n = await generateAssistantNudge('generic_ack', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
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
          await sendTextTracked(from, `Rescheduled to ${new Date(startISO).toLocaleString()} (Ref #${apptId}).`, cfg);
        }
      } catch {}
      return;
    }
    if (id.startsWith('RESCHED_CANCEL_')) {
      const n = await generateAssistantNudge('cancel_aborted', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
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
          await sendTextTracked(from, `Canceled (Ref #${apptId}).`, cfg);
          if (rowDetail?.staff_id && rowDetail?.start_ts) {
            await notifyWaitlistForNewAvailability({ tenantUserId, staffId: rowDetail.staff_id, startTs: rowDetail.start_ts, cfg });
          }
        }
      } catch {}
      return;
    }
    if (id.startsWith('CANCEL_ABORT_')) {
      const n = await generateAssistantNudge('cancel_aborted', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
      await sendTextTracked(from, n, cfg);
      return;
    }
    if (id.startsWith('REM_OK_')) {
      const apptId = Number(id.split('_')[2] || 0);
      if (apptId) {
        const dbNative = getDB();
        const row = await dbNative.collection('appointments').findOne({ id: apptId, user_id: String(tenantUserId) }, { projection: { status: 1, start_ts: 1 } });
        if (row && row.status === 'confirmed') {
          const n = await generateAssistantNudge('reminder_ok', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n, cfg);
        } else {
          const n = await generateAssistantNudge('reminder_missing', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
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
        else { try { await cancelBooking({ userId: tenantUserId, appointmentId: apptId }); await sendTextTracked(from, `Canceled (Ref #${apptId}).`, cfg); } catch {} }
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
        else if (row?.staff_id) { await sendDayPicker(from, row.staff_id, apptId, cfg, 'Pick a new day', 'Choose a date:'); }
      }
      return;
    }
    if (id.startsWith('KB_TITLE_')) {
      const wanted = id.replace('KB_TITLE_', '');
      await sendKbItemByTitle({ tenantUserId, to: from, title: wanted, cfg });
      return;
    }
    if (id.startsWith('CLINIC_')) {
      await sendTextTracked(from, `You chose ${title}.`, cfg);
      await sendButtonTracked(
        from,
        'Would you like me to send the report graph so you can forward it to your doctor?',
        [{ id: 'YES_GRAPH', title: 'Yes' }, { id: 'NO_GRAPH', title: 'No' }],
        cfg
      );
      return;
    }
  }

  async function handleListReply({ id, title, tenantUserId, from, cfg }) {
    if (!id) return;
    if (/^CSAT_[1-5]$/.test(id)) {
      try {
        const dbNative = getDB();
        const score = Number(id.split('_')[1]);
        const emojiMap = { 1: '😡', 2: '😕', 3: '🙂', 4: '😀', 5: '🤩' };
        const emoji = emojiMap[score] || null;
        // Upsert per-resolution cycle (only keep the last review until a new ticket starts)
        let cycleTs = null;
        try {
          const st = await dbNative.collection('contact_state')
            .findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { await_rating_ts: 1 } });
          cycleTs = Number(st?.await_rating_ts || 0) || null;
        } catch {}
        await dbNative.collection('csat_ratings').updateOne(
          { user_id: String(tenantUserId), contact_id: String(from), cycle_ts: cycleTs },
          { $set: { score, emoji, message_text: `[List] ${title || ''}`, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), cycle_ts: cycleTs } },
          { upsert: true }
        );
        await dbNative.collection('contact_state').updateOne(
          { user_id: String(tenantUserId), contact_id: String(from) },
          { $set: { await_rating: 0, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch {}
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
        { const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
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
          // Remember last chosen service for future “same as last time” intents
          try { await rememberService(tenantUserId, from, { name: svc.name, minutes: Number(svc.minutes||0) }); } catch {}
          const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
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
          const rows = await buildTimeRows({ userId: tenantUserId, staffId, dateISO, limit: 10, apptId });
          if (!rows.length) { const n = await generateAssistantNudge('no_times', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); return; }
          await sendListTracked(from, `${new Date(dateISO).toLocaleDateString()}`, 'Choose a new time:', 'Select', rows, cfg);
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
          // Try to honor selected service duration from session
          let slotOverride = undefined;
          try {
            const dbNative = getDB();
            const sess = await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { service_minutes: 1 } });
            if (sess?.service_minutes) slotOverride = Number(sess.service_minutes);
          } catch {}
          const rows = await buildTimeRows({ userId: tenantUserId, staffId: String(staffId), dateISO, limit: 10, apptId: null, slotMinutes: slotOverride });
          if (!rows.length) { const n = await generateAssistantNudge('no_times', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); return; }
          await sendListTracked(from, `${new Date(dateISO).toLocaleDateString()}`, 'Choose a time:', 'Select', rows, cfg);
        } else {
          { const n = await generateAssistantNudge('ask_range', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
        }
      } catch {
        await sendTextTracked(from, 'Something went wrong loading times. Please pick a day again.', cfg);
      }
      return;
    }
    if (id.startsWith('BOOK_SLOT_')) {
      try {
        const parts = id.split('_');
        const startISO = parts.slice(2, 3)[0];
        const endISO = parts.slice(3, 4)[0];
        const staffId = Number(parts.slice(4, 5)[0] || 0);
        if (tenantUserId && staffId && startISO && endISO) {
          const settings = cfg || {};
          let questions = [];
          try { questions = JSON.parse(settings.booking_questions_json || '[]'); } catch {}
          if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
          try {
            db.prepare(`INSERT INTO booking_sessions (user_id, contact_id, staff_id, start_iso, end_iso, step, question_index, answers_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'pending', 0, '[]', strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(user_id, contact_id) DO UPDATE SET staff_id=excluded.staff_id, start_iso=excluded.start_iso, end_iso=excluded.end_iso, step='pending', question_index=0, answers_json='[]', updated_at=strftime('%s','now')
            `).run(tenantUserId, from, staffId, startISO, endISO);
          } catch {}
          await sendTextTracked(from, String(questions[0]).slice(0, 200), cfg);
        } else {
          { const n = await generateAssistantNudge('slot_book_failed', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
        }
      } catch {
        { const n = await generateAssistantNudge('slot_book_failed', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n || 'Sorry, that slot is no longer available.', cfg); }
      }
      return;
    }
  }
  // Lightweight payload shape validator
  function isValidWebhookPayload(p) {
    try {
      // Tolerant: accept when change value exists and has messages[] or statuses[]
      const changeNode = (() => {
        const entryNode = Array.isArray(p?.entry) ? p.entry[0] : (p?.entry && typeof p.entry === 'object' ? Object.values(p.entry)[0] : undefined);
        const ch = Array.isArray(entryNode?.changes) ? entryNode.changes[0] : (entryNode?.changes && typeof entryNode.changes === 'object' ? Object.values(entryNode.changes)[0] : undefined);
        return ch;
      })();
      const val = changeNode?.value || changeNode || {};
      const hasMsgs = Array.isArray(val?.messages) || (val?.messages && typeof val.messages === 'object' && Object.values(val.messages).length > 0);
      const hasStatuses = Array.isArray(val?.statuses) || (val?.statuses && typeof val.statuses === 'object' && Object.values(val.statuses).length > 0);
      return hasMsgs || hasStatuses;
    } catch { return false; }
  }

  // Test endpoint for debugging (bypasses signature verification)
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
      try {
        const plan = await getUserPlan(tenantUserId);
        if ((plan?.plan_name || 'free') === 'free') {
          cfg.conversation_mode = 'escalation';
          cfg.bookings_enabled = 0;
          cfg.reminders_enabled = 0;
        }
      } catch {}
      const from = message.from;
      let text = message.text?.body || "";

      if (DEBUG_LOGS) console.log("Test webhook received:", { from, text, tenantUserId, conversation_mode: cfg.conversation_mode });

      // Check conversation mode FIRST - if Simple Escalation Mode, handle differently
      if (cfg.conversation_mode === 'escalation') {
        if (DEBUG_LOGS) console.log("Simple Escalation Mode active in test");
        
        // Check if this is the first message from this contact (show greeting first)
        const state = db.prepare(`SELECT escalation_step FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (!state) {
          // First message: show greeting and additional message
          const greetText = cfg.entry_greeting || await generateAssistantNudge('greeting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          const additionalMessage = cfg.escalation_additional_message || "";
          
          let response = greetText;
          if (additionalMessage) {
            response += "\n\n" + additionalMessage;
          }
          
          // Get custom escalation questions
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(cfg.escalation_questions_json || '[]');
          } catch {}
          
          response += "\n\n" + escalationQuestions[0];
          
          // Save the state for testing
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, escalation_questions_json, escalation_question_index, updated_at)
              VALUES (?, ?, 'ask_question', ?, 0, strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, escalation_questions_json = excluded.escalation_questions_json, escalation_question_index = excluded.escalation_question_index, updated_at = excluded.updated_at`).run(from, tenantUserId, JSON.stringify(escalationQuestions));
          } catch {}
          
          return res.json({ success: true, response: response, type: "escalation_first_message" });
        }
        
        // Continue with dynamic escalation questions flow for subsequent messages
        const currentState = db.prepare(`SELECT escalation_step, escalation_questions_json, escalation_question_index FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (currentState?.escalation_step === 'ask_question') {
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(currentState.escalation_questions_json || '[]');
          } catch {}
        
          
          const currentIndex = currentState.escalation_question_index || 0;
          const nextIndex = currentIndex + 1;
          
          // Store the user's answer for testing
          const answerKey = `escalation_answer_${currentIndex}`;
          try {
            db.prepare(`UPDATE handoff SET ${answerKey} = ?, escalation_question_index = ?, updated_at = strftime('%s','now') WHERE contact_id = ? AND user_id = ?`).run(text, nextIndex, from, tenantUserId);
          } catch {}
          
          // Check if there are more questions
          if (nextIndex < escalationQuestions.length) {
            return res.json({ success: true, response: escalationQuestions[nextIndex], type: "escalation_ask_question" });
          } else {
            return res.json({ success: true, response: await generateAssistantNudge('handoff_connecting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }), type: "escalation_complete" });
          }
        }
        
        return res.json({ success: true, response: "What's your name?", type: "escalation_ask_name" });
      }

      // In full AI mode, do not short-circuit greetings; let the AI handle tone and replies

      // Test KB response
      const kbMatchesBase = await cachedRetrieveKbMatches(text, 8, tenantUserId, '', from);
      const prof = await buildCustomerProfileSnippet(tenantUserId, from);
      const kbMatches = prof ? [prof, ...(Array.isArray(kbMatchesBase) ? kbMatchesBase : [])] : kbMatchesBase;
      if (DEBUG_LOGS) console.log("KB Matches:", Array.isArray(kbMatches) ? kbMatches : []);
      
      const aiStart = Date.now();
      const aiReply = await generateAiReply(text, kbMatches, {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics
      });
      try { businessMetrics.trackAIRequest(true, Date.now() - aiStart); } catch {}
      if (DEBUG_LOGS) console.log("AI Reply:", aiReply);
      return res.json({ success: true, response: aiReply, type: "kb_response", kbMatches: Array.isArray(kbMatches) ? kbMatches.length : 0 });
      
    } catch (e) {
      console.error("Test webhook error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // Webhook verification (Meta)
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

  // Receive messages
  app.post("/webhook", rateLimit, async (req, res) => {
    try {
      // Guard: enforce small payload size for webhook
      const maxBytes = Number(process.env.WEBHOOK_MAX_BYTES || 1048576); // 1MB default
      const contentLen = Number(req.headers['content-length'] || 0);
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
      const prospective = (() => {
        try {
          const obj = JSON.parse((req.rawBody || Buffer.from("{}"))?.toString("utf8"));
          const firstOf = (x) => Array.isArray(x) ? x[0] : (x && typeof x === 'object' ? Object.values(x)[0] : undefined);
          const entry = firstOf(obj.entry);
          const changeNode = firstOf(entry?.changes);
          const change = changeNode?.value || changeNode;
          const pnid = change?.metadata?.phone_number_id || null;
          if (!pnid) return null;
          return findSettingsByPhoneNumberId(pnid);
        } catch { return null; }
      })();
      const s = prospective || {};
      // Verify webhook signature for security
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
        // No-op ACK instead of 400 to avoid blocking/extra retries from Meta
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

      // Per-tenant rate limit using Redis (if available)
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

            // Idempotency guard for statuses
            try {
              const ttl = Number(process.env.STATUS_NONCE_TTL || 600);
              if (isRedisConnected()) {
                const redis = getRedisClient();
                const skey = `wp:status:${tenantUserId || 'null'}:${messageId}:${status}:${tsNum || 0}`;
                const r = await redis.set(skey, '1', 'EX', ttl, 'NX');
                if (r !== 'OK') continue; // duplicate status
              } else {
                const nkey = `status:${tenantUserId || 'null'}:${messageId}:${status}:${tsNum || 0}`;
                const now = Date.now();
                const rec = memStatus.get(nkey);
                if (rec && rec > now) continue;
                memStatus.set(nkey, now + ttl*1000);
              }
            } catch {}

            // Persist raw status event idempotently
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

            // Update messages collection delivery/read status with monotonic rules
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

            // Broadcast message status update in real-time
            try {
              if (tenantUserId) {
                const messageDoc = await dbNative.collection('messages').findOne({ id: messageId, user_id: String(tenantUserId) }, { projection: { from_digits: 1, to_digits: 1 } });
                const phone = messageDoc?.from_digits || messageDoc?.to_digits;
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

      // Handle reaction messages - don't process them as regular messages
      if (message.type === 'reaction') {
        if (DEBUG_LOGS) console.log("Received reaction message, skipping bot processing");
        
        // Store the reaction in our database for the agent to see
        try {
          
          if (tenantUserId && message.reaction && message.reaction.message_id) {
            const customerUserId = `customer_${message.from}`;
            const phone = normalizePhone(message.from);
            
            // Check if this is a reaction removal (empty emoji) or addition
            if (message.reaction.emoji && message.reaction.emoji.trim() !== '') {
              // This is a reaction addition
              const result = addReaction(message.reaction.message_id, customerUserId, message.reaction.emoji);
              if (DEBUG_LOGS) console.log("Stored customer reaction:", result);
              
              // Broadcast the reaction in real-time to agents
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
              // This is a reaction removal (empty emoji)
              if (DEBUG_LOGS) console.log("Received reaction removal from customer");
              
              // We need to find which emoji was removed
              // WhatsApp doesn't tell us which emoji was removed, so we need to check the database
              // Use Mongo to find the latest reaction for this customer on the message
              const dbNative = getDB();
              const latestReaction = await dbNative.collection('message_reactions')
                .find({ message_id: message.reaction.message_id, user_id: customerUserId })
                .sort({ createdAt: -1 })
                .limit(1)
                .toArray();
              const existingReactions = latestReaction[0] || null;
              if (existingReactions) {
                const emojiToRemove = existingReactions.emoji;
                
                // Remove the reaction from database
                const result = removeReaction(message.reaction.message_id, customerUserId, emojiToRemove);
                if (DEBUG_LOGS) console.log("Removed customer reaction:", result);
                
                // Broadcast the reaction removal in real-time to agents
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

      // Handle reply messages: store and create linkage; only suppress bot when human is explicitly live
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

            // Create reply relationship
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

        // Determine if a human is explicitly live; only then suppress bot
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
        // else: fall through to normal AI handling
      }

      const tenant = tenantSettings;
      // tenantUserId already computed
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      if (businessNumber && message.from === businessNumber) {
        return res.sendStatus(200);
      }
      const cfg = { ...tenant, user_id: tenantUserId };
      try {
        const plan = await getUserPlan(tenantUserId);
        if ((plan?.plan_name || 'free') === 'free') {
          cfg.conversation_mode = 'escalation';
          cfg.bookings_enabled = 0;
          cfg.reminders_enabled = 0;
        }
      } catch {}

      // Define sender and extract content by type
      const from = message.from;
      let text = message.text?.body || "";
      let mediaUrl = null;
      let normalizedType = message.type || 'text';
      if (normalizedType === 'image' && message.image) {
        // Prefer direct link. If missing, construct proxy URL so browser can download with our credentials
        mediaUrl = message.image.link || null;
        if (!mediaUrl && message.image.id) {
          mediaUrl = `/wa-media/${encodeURIComponent(String(tenantUserId))}/${encodeURIComponent(String(message.image.id))}`;
        }
      }
      try { businessMetrics.trackWhatsAppMessage('received', normalizedType || 'text'); } catch {}

      // Precompute live-mode status to avoid sending any bot messages when human is explicitly active
      let humanActive = false;
      let humanLive = false; // true only when an agent explicitly toggled live mode (is_human)
      let recentlySeen = false; // true when an agent recently viewed the chat
      try {
        // Read both legacy (SQLite) and current (Mongo) sources and consider human live if either indicates active
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
        const seenWindow = Number(process.env.LIVE_SEEN_WINDOW_SEC || 180); // 3 min default
        const sqlLive = !!(hsSql?.is_human && (!hsSql.exp || hsSql.exp > now));
        const mongoLive = !!(hsMongo?.is_human && (!hsMongo.exp || hsMongo.exp > now));
        const lastSeenTs = Math.max(Number(hsSql?.lastSeen || 0), Number(hsMongo?.lastSeen || 0));

        humanLive = mongoLive || sqlLive; // prefer live if either source says so
        recentlySeen = !!(lastSeenTs && (now - lastSeenTs) <= seenWindow);
        // Only suppress bot when an agent explicitly enabled live mode.
        // Viewing the chat recently should not block AI replies after resolution.
        humanActive = humanLive;
      } catch {}

      // Check conversation mode - if Simple Escalation Mode, handle differently (but never while human is explicitly live)
      // Uses in-memory session so this mode does not require the database at all
      if (cfg.conversation_mode === 'escalation' && !humanLive) {
        if (DEBUG_LOGS) console.log("Simple Escalation Mode active");
        // Out-of-hours check applies in escalation too: show OOH text instead of starting questions
        try {
          const within = await isWithinStaffWorkingHours(tenantUserId, cfg);
          if (!within) {
            const ok = await shouldSendOutOfHours(tenantUserId, from);
            if (ok) {
            const oohMsg = cfg.escalation_out_of_hours_message || await generateAssistantNudge('out_of_hours', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
            await sendTextTracked(from, oohMsg, cfg);
            }
            return res.sendStatus(200);
          }
        } catch {}
        // Ensure inbound gets recorded and shown even in escalation flow (which returns early)
        try {
          const inboundIdEsc = message.id;
          if (inboundIdEsc) {
            const insertedEsc = await recordInboundMessage({
              messageId: inboundIdEsc,
              userId: tenantUserId,
              from,
              businessPhone: metadata?.display_phone_number?.replace(/\D/g, ""),
              type: normalizedType,
              text: normalizedType === 'image' ? null : text,
              timestamp: message.timestamp ? Number(message.timestamp) : undefined,
              raw: message
            });
            if (insertedEsc) {
              try { incrementUsage(tenantUserId, 'inbound_messages'); } catch {}
              const messageDataEsc = {
                id: inboundIdEsc,
                direction: 'inbound',
                type: normalizedType || 'text',
                text_body: normalizedType === 'image' ? null : text,
                timestamp: message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000),
                from_digits: normalizePhone(from),
                to_digits: normalizePhone(metadata?.display_phone_number),
                contact_name: null,
                contact: from,
                formatted_time: new Date((message.timestamp ? Number(message.timestamp) : Math.floor(Date.now() / 1000)) * 1000).toLocaleString(),
                media_url: mediaUrl
              };
              broadcastNewMessage(tenantUserId, from, messageDataEsc);
              try {
                await Handoff.findOneAndUpdate(
                  { user_id: tenantUserId, contact_id: from },
                  { $set: { is_archived: false, deleted_at: null, updatedAt: new Date() }, $setOnInsert: { user_id: tenantUserId, contact_id: from } },
                  { upsert: true }
                );
              } catch {}
            }
          }
        } catch {}
        
        // Build questions from settings (fallback defaults)
        let escalationQuestions = [];
        try { escalationQuestions = JSON.parse(cfg.escalation_questions_json || '[]'); } catch {}
        if (!Array.isArray(escalationQuestions) || escalationQuestions.length === 0) {
          escalationQuestions = ["What's your name?"];
        }

        // Fetch/create a memory session
        const { key, rec } = await getMemSession(tenantUserId, from);
        if (!rec) {
          // First message for this contact in the current process lifetime
          const greetText = cfg.entry_greeting || await generateAssistantNudge('greeting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          const greetingOnly = isGreeting(text) && !hasSubstantiveRequest(text);

          // Always greet
          await sendTextTracked(from, greetText, cfg);
          await sendBrandingIfFree({ tenantUserId, to: from, cfg });

          if (greetingOnly) {
            // Wait for a substantive request before escalating (no KB menu in escalation mode)
            await setMemSession(tenantUserId, from, { step: 'greeted', qIndex: 0, answers: [], questions: escalationQuestions, buffer: '', bufferTs: Date.now() });
            return res.sendStatus(200);
          }

          // Greeting + request in one message OR first message is a request → escalate now
          const additional = cfg.escalation_additional_message;
          const outOfHours = cfg.escalation_out_of_hours_message;
          if (additional) {
            await sendTextTracked(from, additional, cfg);
          } else if (outOfHours) {
            await sendTextTracked(from, outOfHours, cfg);
          }
          await setMemSession(tenantUserId, from, { step: 'ask_question', qIndex: 0, answers: [], questions: escalationQuestions });
          await sendTextTracked(from, String(escalationQuestions[0]).slice(0,200), cfg);
          return res.sendStatus(200);
        }
        
        // Continue with dynamic escalation questions flow for subsequent messages (memory only)
        if (rec.step === 'greeted') {
          // Accumulate short fragments, escalate once message is substantive
          const now = Date.now();
          const within = (now - (rec.bufferTs || 0)) <= Number(process.env.ESCALATION_BUFFER_WINDOW_MS || 180_000); // default 3 min
          const prior = within ? (rec.buffer || '') : '';
          const joined = [prior, String(text || '')].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
          // If buffer expired and the user sends a fresh greeting, respond with greeting again
          if (!within && isGreeting(text) && !hasSubstantiveRequest(text)) {
            const greetText = cfg.entry_greeting || await generateAssistantNudge('greeting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
            await sendTextTracked(from, greetText, cfg);
            await sendBrandingIfFree({ tenantUserId, to: from, cfg });
            await setMemSession(tenantUserId, from, { step: 'greeted', qIndex: 0, answers: [], questions: Array.isArray(rec.questions)?rec.questions:[], buffer: '', bufferTs: now });
            return res.sendStatus(200);
          }
          if (hasSubstantiveRequest(joined)) {
            const additional = cfg.escalation_additional_message;
            const outOfHours = cfg.escalation_out_of_hours_message;
            if (additional) {
            await sendTextTracked(from, additional, cfg);
            } else if (outOfHours) {
              await sendTextTracked(from, outOfHours, cfg);
            }
            await setMemSession(tenantUserId, from, { step: 'ask_question', qIndex: 0, answers: [], questions: Array.isArray(rec.questions)?rec.questions:escalationQuestions });
            await sendTextTracked(from, String((Array.isArray(rec.questions)?rec.questions:escalationQuestions)[0]).slice(0,200), cfg);
            return res.sendStatus(200);
          }
          // Not substantive yet → keep buffering, no extra messages to avoid spam
          await setMemSession(tenantUserId, from, { step: 'greeted', qIndex: 0, answers: [], questions: rec.questions, buffer: joined.slice(0, 400), bufferTs: now });
          return res.sendStatus(200);
        }
        if (rec.step === 'ask_question') {
          const currentIndex = Number(rec.qIndex || 0);
          const nextIndex = currentIndex + 1;
          const ans = String(text || '').trim().slice(0, 300);
          const answers = Array.isArray(rec.answers) ? rec.answers.slice() : [];
          answers[currentIndex] = ans;
          const questions = Array.isArray(rec.questions) ? rec.questions : escalationQuestions;

          if (nextIndex < questions.length) {
            await setMemSession(tenantUserId, from, { step: 'ask_question', qIndex: nextIndex, answers, questions });
            await sendTextTracked(from, String(questions[nextIndex]).slice(0,200), cfg);
          } else {
            await setMemSession(tenantUserId, from, { step: 'done', qIndex: nextIndex, answers, questions }, 5*60*1000);
            await sendTextTracked(from, "Got it. I'm connecting you with a human now. Please wait a moment.", cfg);
          }
          return res.sendStatus(200);
        }
      }

      const inboundId = message.id;
      // Replay protection: dedupe message.id per-tenant for short TTL
      try {
        if (inboundId && tenantUserId && isRedisConnected()) {
          const redis = getRedisClient();
          const nonceKey = `wp:nonce:${tenantUserId}:${inboundId}`;
          const ttl = Number(process.env.WEBHOOK_NONCE_TTL || 600);
          const result = await redis.set(nonceKey, '1', 'EX', ttl, 'NX');
          if (result !== 'OK') {
            // Duplicate delivery; acknowledge without reprocessing
            return res.sendStatus(200);
          }
        }
      } catch {}
      let isFirstTimeInbound = true;
      if (inboundId) {
        try {
          const inserted = await recordAndBroadcastInbound({ message, tenantUserId, metadata, normalizedType, text, mediaUrl });
          if (DEBUG_LOGS) console.log('[Webhook] Inbound record result:', { inserted, inboundId });
          isFirstTimeInbound = !!inserted;
        } catch (e) {
          console.warn('[Webhook] Failed to record inbound message, continuing to process reply anyway:', e?.message || e);
          isFirstTimeInbound = true;
        }
      }

      // Opt-out and temporary block checks per contact
      try {
        if (tenantUserId && from) {
          const cust = await Customer.findOne({ user_id: tenantUserId, contact_id: from }).lean();
          const now = Math.floor(Date.now()/1000);
          if (cust?.opted_out) return res.sendStatus(200);
          if (cust?.blocked_until_ts && cust.blocked_until_ts > now) return res.sendStatus(200);
        }
      } catch {}

      // Working hours guard: In full AI mode, do NOT block replies purely due to hours.
      // Only apply OOH messaging during explicit escalation moments elsewhere.
      try {
        if (tenantUserId && cfg?.conversation_mode === 'escalation') {
          const handled = await handleOutOfHoursGuard(tenantUserId, from, cfg);
          if (handled) return res.sendStatus(200);
        }
      } catch {}

      // If conversation is In Progress, maybe send a holding message (dedup + throttle)
      try {
        if (humanActive && cfg?.conversation_mode !== 'escalation' && tenantUserId) {
          const handled = await maybeSendHoldingMessage(tenantUserId, from, cfg);
          if (handled) return res.sendStatus(200);
        }
      } catch {}

      // Proceed with bot logic even if message was seen before; prevents missed replies when duplicate detection is inconclusive

      // CSAT rating capture: if awaiting rating for this contact, capture first emoji and store
      try {
        const dbNative = getDB();
        const cs = await dbNative.collection('contact_state').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { await_rating: 1 } });
        const awaiting = !!cs?.await_rating;
        const emojiMatch = /[\u{1F620}-\u{1F64F}\u{1F600}-\u{1F64F}\u{1F601}\u{1F603}\u{1F604}\u{1F606}\u{1F60A}\u{1F60D}\u{1F62D}\u{1F621}\u{1F620}\u{1F641}\u{1F642}\u{1F622}\u{1F610}\u{1F600}\u{1F929}]/u.exec(String(text||''));
        if (awaiting && emojiMatch) {
          const emoji = emojiMatch[0];
          const scoreMap = { '😡':1, '😕':2, '🙂':3, '😀':4, '🤩':5 };
          const score = scoreMap[emoji] || null;
          try {
            // Use cycle timestamp to upsert one rating per resolution
            let cycleTs = null;
            try {
              const st = await dbNative.collection('contact_state')
                .findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { await_rating_ts: 1 } });
              cycleTs = Number(st?.await_rating_ts || 0) || null;
            } catch {}
            await dbNative.collection('csat_ratings').updateOne(
              { user_id: String(tenantUserId), contact_id: String(from), cycle_ts: cycleTs },
              { $set: { score, emoji, message_text: String(text||''), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), cycle_ts: cycleTs } },
              { upsert: true }
            );
            await dbNative.collection('contact_state').updateOne(
              { user_id: String(tenantUserId), contact_id: String(from) },
              { $set: { await_rating: 0, updatedAt: new Date() } }
            );
          } catch {}
          // Acknowledge without triggering further bot logic
          return res.sendStatus(200);
        }
      } catch {}

      // If human is active for this contact, do not auto‑reply at all
      if (humanActive) {
        return res.sendStatus(200);
      }

      // Escalation state machine: collect name and reason before human handoff
      // Only run escalation state machine if in escalation mode
      if (cfg.conversation_mode === 'escalation') {
        try {
          const state = db.prepare(`SELECT escalation_step, escalation_reason FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId) || {};
          const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};

        // If we are waiting for the user's name
        if (state.escalation_step === 'ask_name') {
          const parsed = parseNameFromMessage(text) || String(text || '').trim().slice(0, 80);
          if (parsed) {
            try {
              db.prepare(`INSERT INTO customers (user_id, contact_id, display_name, created_at, updated_at)
                VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))
                ON CONFLICT(user_id, contact_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`).run(tenantUserId, from, parsed);
            } catch {}
            try {
              db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
                VALUES (?, ?, 'ask_reason', strftime('%s','now'))
                ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
            } catch {}
            await sendTextTracked(from, "Thanks, and what’s the reason for contacting a human today?", cfg);
            return res.sendStatus(200);
          } else {
            await sendTextTracked(from, "Could you please share your name so I can connect you to a human?", cfg);
            return res.sendStatus(200);
          }
        }

        // If we are waiting for the reason
        if (state.escalation_step === 'ask_reason') {
          const reason = String(text || '').trim().slice(0, 300);
          if (reason) {
            try {
              const exp = Math.floor(Date.now()/1000) + 5*60;
              db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, escalation_reason, is_human, human_expires_ts, updated_at)
                VALUES (?, ?, NULL, ?, 1, ?, strftime('%s','now'))
                ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = NULL, escalation_reason = excluded.escalation_reason, is_human = 1, human_expires_ts = excluded.human_expires_ts, updated_at = excluded.updated_at`).run(from, tenantUserId, reason, exp);
            } catch {}
            
            // Send email notification to account owner
            try {
              const customerName = customer.display_name || null;
              await sendEscalationNotification(tenantUserId, {
                customerName,
                customerPhone: from,
                reason,
                timestamp: new Date().toISOString(),
              });
            } catch (e) {
              console.error('[Webhook] Failed to send escalation email:', e.message);
            }
            
            // Create web notification
            try {
              const customerName = customer.display_name || from;
              db.prepare(`INSERT INTO notifications (user_id, type, title, message, link, metadata) 
                VALUES (?, ?, ?, ?, ?, ?)`).run(
                tenantUserId,
                'escalation',
                'New Support Escalation',
                `${customerName} requested to speak with a human: "${reason}"`,
                `/inbox/${encodeURIComponent(from)}`,
                JSON.stringify({ contact_id: from, reason, customer_name: customerName })
              );
            } catch (e) {
              console.error('[Webhook] Failed to create notification:', e.message);
            }
            
            { const n = await generateAssistantNudge('handoff_connecting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
            { const n = await generateAssistantNudge('handoff_connecting', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
            return res.sendStatus(200);
          } else {
            await sendTextTracked(from, "Could you share a brief reason so I can route you to the right person?", cfg);
            return res.sendStatus(200);
          }
        }
      } catch {}
      } // End escalation mode check

      // Handle interactive replies (buttons/lists) BEFORE filtering to text
      if (message?.type === "interactive") {
        try { incrementCounter('whatsapp_interactive_received', 1, { kind: String(message?.interactive?.type||'unknown') }); } catch {}
        const data = message.interactive;
        // Record the interactive inbound for visibility in the thread
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
          await handleListReply({ id, title, tenantUserId, from, cfg });
          return res.sendStatus(200);
        }
        return res.sendStatus(200);
      }

      // Combine recent short fragments to improve intent detection
      try {
        text = await maybeJoinRecentFragments({ text, from, tenantUserId, timestampSec: Number(message.timestamp || Math.floor(Date.now()/1000)) });
      } catch {}

      // Second guard: re-check status before greeting to prevent greetings while In Progress
      try {
        if (humanActive && cfg?.conversation_mode !== 'escalation' && tenantUserId) {
          const handled = await maybeSendHoldingMessage(tenantUserId, from, cfg);
          if (handled) return res.sendStatus(200);
        }
      } catch {}

      // Before greetings/AI: suppress non-substantive spam bursts (no replies)
      if (!humanActive) {
        try {
          if (maybeSuppressNonSubstantiveSpam(tenantUserId, from, text)) {
            return res.sendStatus(200);
          }
        } catch {}
      }

      // Show greeting + KB menu on pure greetings regardless of conversation mode
      if (!humanActive) {
        const greeted = await maybeHandleGreeting({ text, tenantUserId, from, cfg });
        if (greeted) return res.sendStatus(200);
      }

      // In full AI mode, let the model respond to acknowledgements and small talk; keep reaction only in escalation mode
      if (!humanActive && cfg?.conversation_mode === 'escalation' && isAcknowledgement(text)) {
        try { incrementCounter('acknowledgement_detected', 1, { userId: String(tenantUserId||'') }); } catch {}
        try { await sendWhatsappReaction(from, inboundId, "👍", cfg); } catch {}
        return res.sendStatus(200);
      }

      // Dev/test: manual reminder preview
      if (/\btest\s+reminder\b/i.test(text || "")) {
        const digits = String(from || '').replace(/\D/g, '');
        let apptArr = await getDB().collection('appointments')
          .find({ user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } })
          .project({ id: 1, start_ts: 1, staff_id: 1 })
          .sort({ start_ts: 1 })
          .limit(1)
          .toArray();
        let appt = apptArr[0] || null;
        if (!appt) {
          // Create a lightweight test appointment 60 minutes from now if none exists
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

      // Appointment lookup intent ("When is my booking?")
      const bookingLookup = /(when|what\s*time|time|date|when\s*is)\b[\s\S]*\b(booking|appointment|reservation)s?/i.test(text || "");
      if (cfg?.bookings_enabled && bookingLookup) {
        const digits = String(from || '').replace(/\D/g, '');
        const dbNative = getDB();
        const upcoming = await dbNative.collection('appointments')
          .aggregate([
            { $match: { user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } } },
            { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
            { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
            { $sort: { start_ts: 1 } },
            { $limit: 3 },
            { $project: { id: 1, start_ts: 1, status: 1, notes: 1, staff_name: 1 } }
          ]).toArray();
        if (upcoming && upcoming.length) {
          const lines = upcoming.map((r) => {
            const when = new Date((r.start_ts||0)*1000).toLocaleString();
            const meta = `Ref #${r.id}${r.staff_name ? ' · ' + r.staff_name : ''}`;
            return `- ${when} (${meta})`;
          }).join('\n');
          await sendTextTracked(from, `Your upcoming ${upcoming.length>1?'bookings':'booking'}:\n${lines}`, cfg);
          return res.sendStatus(200);
        }
        const lastArr = await dbNative.collection('appointments')
          .aggregate([
            { $match: { user_id: String(tenantUserId), $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $lt: Math.floor(Date.now()/1000) } } },
            { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
            { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
            { $sort: { start_ts: -1 } },
            { $limit: 1 },
            { $project: { id: 1, start_ts: 1, status: 1, staff_name: 1 } }
          ]).toArray();
        const last = lastArr[0] || null;
        if (last) {
          const when = new Date((last.start_ts||0)*1000).toLocaleString();
          const meta = `Ref #${last.id}${last.staff_name ? ' · ' + last.staff_name : ''}`;
          await sendTextTracked(from, `I don't see an upcoming booking. Your last booking was ${when} (${meta}).`, cfg);
        } else {
          const n = await generateAssistantNudge('no_booking_found', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n, cfg);
        }
        return res.sendStatus(200);
      }

      // "Who was my previous agent?" → look up last appointment's staff
      const prevAgentLookup = /\b(previous|last)\s+(agent|staff|person|rep|representative)\b/i.test(text || "");
      if (cfg?.bookings_enabled && prevAgentLookup) {
        try {
          const digits = String(from || '').replace(/\D/g, '');
          const dbNative = getDB();
          const lastArr = await dbNative.collection('appointments')
            .aggregate([
              { $match: { user_id: String(tenantUserId), $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $lt: Math.floor(Date.now()/1000) } } },
              { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
              { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
              { $sort: { start_ts: -1 } },
              { $limit: 1 },
              { $project: { staff_name: 1 } }
            ]).toArray();
          const last = lastArr[0] || null;
          if (last?.staff_name) {
            try { await rememberAgent(tenantUserId, from, last.staff_name); } catch {}
            await sendTextTracked(from, `Your previous agent was ${last.staff_name}.`, cfg);
          } else {
            await sendTextTracked(from, "I couldn't find a previous agent on record.", cfg);
          }
        } catch {
          await sendTextTracked(from, "I couldn't access your previous agent info right now.", cfg);
        }
        return res.sendStatus(200);
      }

      // If awaiting booking date/time, parse the user's free-text and move to Q&A (no pickers)
      if (tenantUserId && message.type === 'text') {
        try {
          const dbNative = getDB();
          const sessAwait = await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from), step: { $in: ['awaiting_datetime','awaiting_reschedule_dt','awaiting_cancel_confirm'] } });
          if (sessAwait) {
            // If user asks for availability while we're awaiting a date/time, show availability by range
            const wantsAvailWhileAwaiting = /\b(available|availability|free\s*slots?|open\s*times?|show\s+(me\s+)?(times|slots)|what\s+times\b)/i.test(text || "");
            if (sessAwait.step === 'awaiting_datetime') {
              // First, try to parse a specific date+time directly
              const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
              if (!staff) return res.sendStatus(200);
              const parsedReqDirect = parseRequestedDateTime(text);
              if (parsedReqDirect && parsedReqDirect.dateISO && parsedReqDirect.hour != null) {
                const base = new Date(`${parsedReqDirect.dateISO}T00:00:00.000Z`);
                const start = buildUtcFromLocalTz(parsedReqDirect.dateISO, parsedReqDirect.hour, parsedReqDirect.minute || 0, staff.timezone || 'UTC');
                const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
                if (start.getTime() < Date.now() + minLeadMs) {
                  const msg = await generateAssistantNudge('past_time_warning', { examples: ["today 4pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                  await sendTextTracked(from, msg, cfg);
                  return res.sendStatus(200);
                }
                const avail = await listAvailability({ userId: tenantUserId, staffId: String(staff._id), dateISO: base.toISOString(), days: 1 });
                const nowCutoff = Date.now() + minLeadMs;
                const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(s => new Date(s.start).getTime() >= nowCutoff);
                const toleranceMs = Math.max(120000, Math.floor(Number(staff.slot_minutes||30) * 60000 / 2));
                const scored = slots.map(s => ({ slot: s, diff: Math.abs(new Date(s.start).getTime() - start.getTime()) }));
                scored.sort((a,b) => a.diff - b.diff);
                const match = scored.find(x => x.diff <= toleranceMs)?.slot || null;
                if (match) {
                  try {
                    const notesParts = [];
                    // Name captured later in Q&A
                    const r = await createBooking({ userId: tenantUserId, staffId: String(staff._id), startISO: match.start, endISO: match.end, contactPhone: from, notes: '' });
                    let questions = [];
                    try { questions = JSON.parse((tenant || {}).booking_questions_json || '[]'); } catch {}
                    if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
                    await getDB().collection('booking_sessions').updateOne(
                      { user_id: String(tenantUserId), contact_id: String(from) },
                      { $set: { staff_id: staff._id, start_iso: match.start, end_iso: match.end, step: 'pending', question_index: 0, answers_json: JSON.stringify([]) }, $currentDate: { updatedAt: true } },
                      { upsert: true }
                    );
                    const confirmMsg = await generateAssistantNudge('confirm_booking', { when: new Date(match.start).toLocaleString() }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                    await sendTextTracked(from, confirmMsg || `Great — I can book ${new Date(match.start).toLocaleString()}.`, cfg);
                    if (questions[0]) await sendTextTracked(from, String(questions[0]).slice(0,200), cfg);
                    return res.sendStatus(200);
                  } catch {}
                }
                const suggestions = scored.slice(0, 3).map(x => new Date(x.slot.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
                const n = await generateAssistantNudge('closest_times', { suggestions }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                await sendTextTracked(from, n || `Closest times: ${suggestions.join(', ')}`, cfg);
                return res.sendStatus(200);
              }

              const range = parseDateRange(text);
              const tod = parseTimeOfDayFilter(text);
              if (!range && !wantsAvailWhileAwaiting) {
                // No explicit range and no availability keyword: continue below to parse exact datetime
              } else {
                if (!range) {
                  const msg = await generateAssistantNudge('ask_range', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                  await sendTextTracked(from, msg, cfg);
                  return res.sendStatus(200);
                }
              const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
              if (!staff) { return res.sendStatus(200); }
              const days = Math.min(14, Math.max(1, range.days||1));
              const startISODate = `${range.startISO}T00:00:00.000Z`;
              if (process.env.DEBUG_BOOKINGS === '1') console.log('[bot-awaiting] availability request', { from, startISODate, days, tz: staff.timezone });
              await sendAvailabilityRange({ from, tenantUserId, staffId: String(staff._id), startISODate, days, tod, cfg, bodyLabel: 'Choose a time:' });
              return res.sendStatus(200);
              }
            }
            // Cancel flow confirmation
            if (sessAwait.step === 'awaiting_cancel_confirm' && sessAwait.appt_id) {
              const ok = /\b(yes|confirm|y|cancel)\b/i.test(String(text||''));
              if (!ok) {
          { const n = await generateAssistantNudge('cancel_aborted', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
                try { await dbNative.collection('booking_sessions').deleteOne({ _id: sessAwait._id }); } catch {}
                return res.sendStatus(200);
              }
              try {
                const minLead = Number(cfg.cancel_min_lead_minutes || 60);
                const row = await dbNative.collection('appointments').findOne({ id: Number(sessAwait.appt_id), user_id: String(tenantUserId) }, { projection: { start_ts: 1, staff_id: 1 } });
                const minsToStart = row ? Math.floor(((row.start_ts||0) - Math.floor(Date.now()/1000))/60) : 99999;
                if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return res.sendStatus(200); }
                await cancelBooking({ userId: tenantUserId, appointmentId: Number(sessAwait.appt_id) });
                await sendTextTracked(from, `Canceled (Ref #${sessAwait.appt_id}).`, cfg);
                if (row?.staff_id && row?.start_ts) {
                  await notifyWaitlistForNewAvailability({ tenantUserId, staffId: row.staff_id, startTs: row.start_ts, cfg });
                }
              } catch {}
              try { await dbNative.collection('booking_sessions').deleteOne({ _id: sessAwait._id }); } catch {}
              return res.sendStatus(200);
            }

            // Reschedule and initial booking datetime parsing
            const parsedReq = parseRequestedDateTime(text);
            if (!parsedReq) { const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); return res.sendStatus(200); }
            const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
            if (!staff) { return res.sendStatus(200); }
            const base = new Date(`${parsedReq.dateISO}T00:00:00.000Z`);
            const start = buildUtcFromLocalTz(parsedReq.dateISO, parsedReq.hour, parsedReq.minute || 0, staff.timezone || 'UTC');
            const durationMin = Number((sessAwait?.service_minutes)||0) > 0 ? Number(sessAwait.service_minutes) : Number(staff.slot_minutes||30);
            const end = new Date(start.getTime() + (durationMin * 60000));
            // Guard: prevent past bookings (small lead time allowed)
            const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
            if (start.getTime() < Date.now() + minLeadMs) {
              try {
                const msg = await generateAssistantNudge('past_time_warning', { examples: ["today 4pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                await sendTextTracked(from, msg || "That time has already passed. Please share a future date/time.", cfg);
              } catch { await sendTextTracked(from, "That time has already passed. Please share a future date/time.", cfg); }
              return res.sendStatus(200);
            }
            if (process.env.DEBUG_BOOKINGS === '1') console.log('[bot-awaiting] parsed request', { from, parsedReq, staff_tz: staff.timezone, match_window: { start: start.toISOString(), end: end.toISOString() } });
            const avail = await listAvailability({ userId: tenantUserId, staffId: String(staff._id), dateISO: base.toISOString(), days: 1, slotMinutes: durationMin });
            const nowCutoff = Date.now() + minLeadMs;
            const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(s => new Date(s.start).getTime() >= nowCutoff);
            // Find exact/near match (allow small drift and round to nearest slot). If not found, propose nearest options.
            const toleranceMs = Math.max(120000, Math.floor(durationMin * 60000 / 2));
            const scored = slots.map(s => ({ slot: s, diff: Math.abs(new Date(s.start).getTime() - start.getTime()) }));
            scored.sort((a,b) => a.diff - b.diff);
            const match = scored.find(x => x.diff <= toleranceMs)?.slot || null;
            if (process.env.DEBUG_BOOKINGS === '1') console.log('[bot-awaiting] slots', { count: slots.length, first5: slots.slice(0,5), matched: !!match });
            if (!match) {
              const suggestions = scored.slice(0, 3).map(x => new Date(x.slot.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
              const n = await generateAssistantNudge('closest_times', { suggestions }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
              await sendTextTracked(from, n || `Closest times: ${suggestions.join(', ')}`, cfg);
              return res.sendStatus(200);
            }

            if (sessAwait.step === 'awaiting_reschedule_dt' && sessAwait.appt_id) {
              // Reschedule appointment
              try {
                const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
                const row = await dbNative.collection('appointments').findOne({ id: Number(sessAwait.appt_id), user_id: String(tenantUserId) }, { projection: { start_ts: 1 } });
                const minsToStart = row ? Math.floor(((row.start_ts||0) - Math.floor(Date.now()/1000))/60) : 99999;
                if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return res.sendStatus(200); }
                await rescheduleBooking({ userId: tenantUserId, appointmentId: Number(sessAwait.appt_id), startISO: match.start, endISO: match.end });
                await sendTextTracked(from, `Rescheduled to ${new Date(match.start).toLocaleString()} (Ref #${sessAwait.appt_id}).`, cfg);
              } catch {}
              try { await dbNative.collection('booking_sessions').deleteOne({ _id: sessAwait._id }); } catch {}
              return res.sendStatus(200);
            }

            // New booking path
            let questions = [];
            try { questions = JSON.parse((tenant || {}).booking_questions_json || '[]'); } catch {}
            if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
            const providedName = parseNameFromMessage(text);
            let startIndex = 0;
            const answers = [];
            if (providedName) { answers[0] = providedName; startIndex = 1; }
            await dbNative.collection('booking_sessions').updateOne(
              { user_id: String(tenantUserId), contact_id: String(from) },
              { $set: { staff_id: staff._id, start_iso: match.start, end_iso: match.end, step: 'pending', question_index: startIndex, answers_json: JSON.stringify(answers) }, $currentDate: { updatedAt: true } },
              { upsert: true }
            );
            const when = new Date(match.start).toLocaleString();
            await sendTextTracked(from, `Great — I can book ${when}.`, cfg);
            if (questions[startIndex]) await sendTextTracked(from, String(questions[startIndex]).slice(0,200), cfg);
            return res.sendStatus(200);
          }
        } catch {}
      }

      // If in booking session: collect answers based on configured questions
      const sess = tenantUserId ? await (async () => {
        try {
          const dbNative = getDB();
          return await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) });
        } catch { return null; }
      })() : null;
      if (tenantUserId && sess && message.type === 'text') {
        // Only collect Q&A answers after a time has been selected and session is pending
        if (String(sess.step || '') !== 'pending') {
          // Not in Q&A phase yet → skip answer collection
          // awaiting_datetime/awaiting_reschedule_dt/awaiting_cancel_confirm handled above
          // fall through to rest of pipeline
        } else {
        const settings = tenant || {};
        let questions = [];
        try { questions = JSON.parse(settings.booking_questions_json || '[]'); } catch {}
        if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
        const content = text.trim();
        let answers = [];
        try { answers = JSON.parse(sess.answers_json || '[]'); } catch { answers = []; }
        const idx = Number(sess.question_index || 0);
        // If user says "continue", resend the current question without recording as an answer
        const wantsContinue = /\b(continue|resume|carry\s*on|pick\s*up|where\s+we\s+left\s+off)\b/i.test(content);
        if (wantsContinue) {
          await sendTextTracked(from, String(questions[idx] || questions[0] || "Let's continue.").slice(0,200), cfg);
          return res.sendStatus(200);
        }
        answers[idx] = content;
        const nextIdx = idx + 1;
        if (nextIdx < questions.length) {
          try {
            const dbNative = getDB();
            await dbNative.collection('booking_sessions').updateOne(
              { _id: sess._id },
              { $set: { answers_json: JSON.stringify(answers), question_index: nextIdx, step: 'pending' }, $currentDate: { updatedAt: true } }
            );
          } catch {}
          await sendTextTracked(from, String(questions[nextIdx]).slice(0,200), cfg);
          return res.sendStatus(200);
        }
        // All answered: create booking; notes join Q/A
        const pairs = questions.map((q, i) => `${q}: ${answers[i] || ''}`.trim());
        const notes = pairs.join(' | ').slice(0, 800);
        try {
          const r = await createBooking({ userId: tenantUserId, staffId: sess.staff_id, startISO: sess.start_iso, endISO: sess.end_iso, contactPhone: from, notes });
          const title = tenant?.business_name ? `Appointment with ${tenant.business_name}` : 'Appointment';
          const icsUrl = `${req.protocol}://${req.get('host')}/ics?title=${encodeURIComponent(title)}&start=${encodeURIComponent(sess.start_iso)}&end=${encodeURIComponent(sess.end_iso)}&desc=${encodeURIComponent('Ref #' + r.id)}`;
          { const n = await generateAssistantNudge('confirm_booking', { when: new Date(sess.start_iso).toLocaleString() }, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, `${n || 'Great — I can book that.'} Ref #${r.id}\n\nAdd to your calendar: ${icsUrl}`.trim(), cfg); }
          
          // Send email notification to account owner
          try {
          const staff = await (async () => { try { return await getDB().collection('staff').findOne({ _id: sess.staff_id }, { projection: { name: 1 } }); } catch { return null; } })();
          const customerName = answers[0] || from; // First answer is usually the name
            await sendBookingNotification(tenantUserId, {
              customerName,
              customerPhone: from,
              startTime: sess.start_iso,
              endTime: sess.end_iso,
              notes,
              appointmentId: r.id,
              staffName: staff?.name || null
            });
          } catch (e) {
            console.error('[Webhook] Failed to send booking email:', e.message);
          }
          
          // Create web notification
          try {
            const customerName = answers[0] || from;
            const formattedTime = new Date(sess.start_iso).toLocaleString();
            db.prepare(`INSERT INTO notifications (user_id, type, title, message, link, metadata) 
              VALUES (?, ?, ?, ?, ?, ?)`).run(
              tenantUserId,
              'booking',
              'New Booking Confirmed',
              `${customerName} booked an appointment for ${formattedTime} (Ref #${r.id})`,
              `/dashboard`,
              JSON.stringify({ 
                contact_phone: from, 
                appointment_id: r.id,
                start_time: sess.start_iso,
                customer_name: customerName
              })
            );
          } catch (e) {
            console.error('[Webhook] Failed to create booking notification:', e.message);
          }

          // Persist memory: name, service, agent, appointment time, last answers
          try { if (answers[0]) await rememberName(tenantUserId, from, answers[0]); } catch {}
          try {
            if (sess.service_minutes || sess.service_name) {
              await rememberService(tenantUserId, from, { name: sess.service_name, minutes: Number(sess.service_minutes || 0) });
            }
          } catch {}
          try {
            const staff = await (async () => { try { return await getDB().collection('staff').findOne({ _id: sess.staff_id }, { projection: { name: 1 } }); } catch { return null; } })();
            if (staff?.name) await rememberAgent(tenantUserId, from, staff.name);
          } catch {}
          try { await rememberAppointment(tenantUserId, from, { startISO: sess.start_iso }); } catch {}
          try {
            const structured = questions.map((q, i) => ({ q: String(q).slice(0, 120), a: String(answers[i] || '').slice(0, 240) })).slice(0, 10);
            await updateContactMemory(tenantUserId, from, { last_answers: structured });
          } catch {}
        } catch {
          await sendTextTracked(from, "Sorry, that slot could not be booked. Please try another time.", cfg);
        }
        try {
          const dbNative = getDB();
          await dbNative.collection('booking_sessions').deleteOne({ _id: sess._id });
        } catch {}
        return res.sendStatus(200);
        }
      }

      // Availability / Reschedule / Cancel intents (gated by settings)
      const wantsAvailability = /\b(available|availability|free\s*slots?|open\s*times?|show\s+(me\s+)?(times|slots)|what\s+times\s+do\s+you\s+have)\b/i.test(text || "");
      const wantsReschedule = /\b(reschedule|change\s+(time|booking|appointment))\b/i.test(text || "");
      const wantsCancel = /\b(cancel|cancelation|cancellation)\b/i.test(text || "");
      if (cfg?.bookings_enabled && wantsAvailability) {
        const range = parseDateRange(text);
        const tod = parseTimeOfDayFilter(text);
        if (!range) {
          const msg = await generateAssistantNudge('ask_range', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, msg, cfg);
          return res.sendStatus(200);
        }
        const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
        if (!staff) return res.sendStatus(200);
        const days = Math.min(14, Math.max(1, range.days||1));
        const startISODate = `${range.startISO}T00:00:00.000Z`;
        await sendAvailabilityRange({ from, tenantUserId, staffId: String(staff._id), startISODate, days, tod, cfg, bodyLabel: 'Choose a time:' });
        return res.sendStatus(200);
      }
      const wantsReset = /\b(reset\s+booking|start\s*over|clear\s+(booking|appointment))\b/i.test(text || "");
      if (cfg?.bookings_enabled && wantsReset) {
        try { await getDB().collection('booking_sessions').deleteOne({ user_id: String(tenantUserId), contact_id: String(from) }); } catch {}
        const n = await generateAssistantNudge('reset_done', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
        await sendTextTracked(from, n, cfg);
        return res.sendStatus(200);
      }

      // Waitlist opt-in: "waitlist", "notify earlier", "earlier slot"
      const wantsWaitlist = /\b(waitlist|notify\s+(me\s+)?(if\s+)?(earlier|sooner)|earlier\s+slot|sooner\s+(time|slot))\b/i.test(text || "");
      if (cfg?.bookings_enabled && cfg?.waitlist_enabled && wantsWaitlist) {
        try {
          const digits = String(from || '').replace(/\D/g, '');
          const dbNative = getDB();
          const appt = await dbNative.collection('appointments')
            .find({ user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } })
            .project({ start_ts: 1, staff_id: 1 })
            .sort({ start_ts: 1 })
            .limit(1)
            .toArray()
            .then(arr => arr[0] || null);
          if (appt?.staff_id && appt?.start_ts) {
            const dateKey = formatYmdFromTs(appt.start_ts);
            await dbNative.collection('waitlist').updateOne(
              { user_id: String(tenantUserId), contact_id: String(from), staff_id: appt.staff_id, date: dateKey },
              { $set: { user_id: String(tenantUserId), contact_id: String(from), staff_id: appt.staff_id, date: dateKey, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
              { upsert: true }
            );
            await sendTextTracked(from, "Got it — I’ll message you if an earlier slot opens up.", cfg);
            return res.sendStatus(200);
          }
        } catch {}
      }

      if (cfg?.bookings_enabled && (wantsReschedule || wantsCancel)) {
        const now = Math.floor(Date.now()/1000);
        const digits = String(from || '').replace(/\D/g, '');
        const dbNative = getDB();
        const appt = await dbNative.collection('appointments')
          .find({ user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } })
          .project({ id: 1, start_ts: 1, staff_id: 1 })
          .sort({ start_ts: 1 })
          .limit(1)
          .toArray()
          .then(arr => arr[0] || null);
        if (!appt) {
          const n = await generateAssistantNudge('no_booking_found', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n, cfg);
          return res.sendStatus(200);
        }
        const minsToStart = Math.floor((appt.start_ts - now) / 60);
        if (wantsCancel) {
          const minLead = Number(cfg.cancel_min_lead_minutes || 60);
          if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return res.sendStatus(200); }
          try { await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_cancel_confirm', appt_id: appt.id }, $currentDate: { updatedAt: true } },
            { upsert: true }
          ); } catch {}
          const n = await generateAssistantNudge('cancel_confirm_instructions', { ref: appt.id }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n || `Type 'confirm' to cancel your booking (Ref #${appt.id}), or 'keep' to keep it.`, cfg);
          return res.sendStatus(200);
        }
        if (wantsReschedule) {
          const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
          if (minsToStart < minLead) { await notifyTooClose(from, minLead, cfg); return res.sendStatus(200); }
          try { await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_reschedule_dt', appt_id: appt.id, staff_id: appt.staff_id }, $currentDate: { updatedAt: true } },
            { upsert: true }
          ); } catch {}
          const nRes = await generateAssistantNudge('reschedule_request', { ref: appt.id }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, nRes, cfg);
          return res.sendStatus(200);
        }
      }

      // Booking intent (gated by settings flag) with full-sentence parsing for date/time + name
      const wantsBooking = /\b(book|booking|appointment|schedule)\b/i.test(text || "");
      if (cfg?.bookings_enabled && wantsBooking) {
        // Pick first staff for tenant
        const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
        if (!staff) return res.sendStatus(200);

        const parsed = parseRequestedDateTime(text);
        // If services are configured and no service chosen in session, prompt for service first
        try {
          const services = getServicesFromSettings(cfg);
          // Shortcut: "same service as last time"
          const wantsSameService = /\b(same\s+(service|as\s+last\s+time)|what\s+i\s+had\s+last\s+time|repeat\s+last\s+service)\b/i.test(text || "");
          if (services.length && wantsSameService) {
            try {
              const mem = await getContactMemory(tenantUserId, from);
              const minutes = Number(mem?.last_service_minutes || 0);
              const name = mem?.last_service_name || null;
              if (minutes > 0) {
                const dbNative = getDB();
                await dbNative.collection('booking_sessions').updateOne(
                  { user_id: String(tenantUserId), contact_id: String(from) },
                  { $set: { step: 'awaiting_datetime', staff_id: staff._id, service_name: name || undefined, service_minutes: minutes }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
                  { upsert: true }
                );
                const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                await sendTextTracked(from, n, cfg);
                return res.sendStatus(200);
              }
            } catch {}
          }
          if (services.length) {
            const dbNative = getDB();
            const sessSvc = await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { service_minutes: 1 } });
            if (!sessSvc?.service_minutes) {
              await dbNative.collection('booking_sessions').updateOne(
                { user_id: String(tenantUserId), contact_id: String(from) },
                { $set: { step: 'awaiting_service', staff_id: staff._id }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
                { upsert: true }
              );
              await sendServicePicker(from, cfg);
              return res.sendStatus(200);
            }
          }
        } catch {}
        const providedName = parseNameFromMessage(text);
        if (parsed) {
          // Build requested slot in staff timezone (approximate using provided hour/minute)
          const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
          const start = buildUtcFromLocalTz(parsed.dateISO, parsed.hour, parsed.minute || 0, staff.timezone || 'UTC');
          // Use service-specific duration if chosen in session
          let durationMin = Number(staff.slot_minutes||30);
          try {
            const dbNative = getDB();
            const sessSvc = await dbNative.collection('booking_sessions').findOne({ user_id: String(tenantUserId), contact_id: String(from) }, { projection: { service_minutes: 1 } });
            if (sessSvc?.service_minutes) durationMin = Number(sessSvc.service_minutes);
          } catch {}
          const end = new Date(start.getTime() + (durationMin * 60000));
          // Guard: prevent past bookings (small lead time allowed)
          const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
          if (start.getTime() < Date.now() + minLeadMs) {
            const n = await generateAssistantNudge('past_time_warning', { examples: ["today 4pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
            await sendTextTracked(from, n, cfg);
            return res.sendStatus(200);
          }
          // Check availability for that date
          if (process.env.DEBUG_BOOKINGS === '1') console.log('[bot-book] parsed request', { from, parsed, staff_tz: staff.timezone, match_window: { start: start.toISOString(), end: end.toISOString() } });
          const avail = await listAvailability({ userId: tenantUserId, staffId: String(staff._id), dateISO: base.toISOString(), days: 1, slotMinutes: durationMin });
          const nowCutoff = Date.now() + minLeadMs;
          const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(s => new Date(s.start).getTime() >= nowCutoff);
          // Allow small drift; pick nearest slot if within tolerance, else propose suggestions later
          const toleranceMs = Math.max(120000, Math.floor(durationMin * 60000 / 2));
          const scored = slots.map(s => ({ slot: s, diff: Math.abs(new Date(s.start).getTime() - start.getTime()) }));
          scored.sort((a,b) => a.diff - b.diff);
          const match = scored.find(x => x.diff <= toleranceMs)?.slot || null;
          if (process.env.DEBUG_BOOKINGS === '1') console.log('[bot-book] slots', { count: slots.length, first5: slots.slice(0,5), matched: !!match });
          if (match) {
            // Create booking immediately and start Q&A from next question after name if present
            try {
              const notesParts = [];
              if (providedName) notesParts.push(`Name: ${providedName}`);
              const notes = notesParts.join(' ');
              const r = await createBooking({ userId: tenantUserId, staffId: String(staff._id), startISO: match.start, endISO: match.end, contactPhone: from, notes });
              // Start dynamic questions if configured, skipping name if already provided
              let questions = [];
              try { questions = JSON.parse((tenant || {}).booking_questions_json || '[]'); } catch {}
              if (!Array.isArray(questions) || !questions.length) {
                questions = ["What's your name?", "What's the reason for the booking?"];
              }
              let startIndex = 0;
              if (providedName) {
                // Auto-fill name answer and move to next question
              try {
                const dbNative = getDB();
                await dbNative.collection('booking_sessions').updateOne(
                  { user_id: String(tenantUserId), contact_id: String(from) },
                  { $set: { staff_id: staff._id, start_iso: match.start, end_iso: match.end, step: 'pending', question_index: 1, answers_json: JSON.stringify([providedName]) }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
                  { upsert: true }
                );
              } catch {}
                startIndex = 1;
              } else {
                try {
                  const dbNative = getDB();
                  await dbNative.collection('booking_sessions').updateOne(
                    { user_id: String(tenantUserId), contact_id: String(from) },
                    { $set: { staff_id: staff._id, start_iso: match.start, end_iso: match.end, step: 'pending', question_index: 0, answers_json: JSON.stringify([]) }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
                    { upsert: true }
                  );
                } catch {}
              }
              const when = new Date(match.start).toLocaleString();
              await sendTextTracked(from, `Great — I can book ${when}.`, cfg);
              const q = questions[startIndex];
              if (q) {
                await sendTextTracked(from, String(q).slice(0,200), cfg);
              } else {
                // No questions → finalize
              { const nn = await generateAssistantNudge('confirm_booking', { when }, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, `${nn || 'Great — I can book that.'} Ref #${r.id}`, cfg); }
              }
              return res.sendStatus(200);
            } catch {
              // Fall through to time picker if booking creation fails
            }
          }
          // If date exists but no near time available → suggest closest a few options
          const suggestions = scored.slice(0, 3).map(x => new Date(x.slot.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
          if (suggestions.length) {
            const n = await generateAssistantNudge('closest_times', { suggestions }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
            await sendTextTracked(from, n || `Closest times: ${suggestions.join(', ')}`, cfg);
            return res.sendStatus(200);
          }
          const n2 = await generateAssistantNudge('no_times', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n2 || "That time isn't available.", cfg);
          return res.sendStatus(200);
        }

        // If a single date is present (no time), show a full time selector for that day
        const onlyDate = parseDateOnly(text);
        if (onlyDate) {
          const dateISO = `${onlyDate}T00:00:00.000Z`;
          const rows = await buildTimeRows({ userId: tenantUserId, staffId: String(staff._id), dateISO, limit: 10, apptId: null });
          if (rows.length) {
            await sendListTracked(from, `${new Date(dateISO).toLocaleDateString()}`, 'Choose a time:', 'Select', rows, cfg);
            try {
              const dbNative = getDB();
              await dbNative.collection('booking_sessions').updateOne(
                { user_id: String(tenantUserId), contact_id: String(from) },
                { $set: { step: 'awaiting_datetime', staff_id: staff._id }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
                { upsert: true }
              );
            } catch {}
            return res.sendStatus(200);
          }
        }
        // Otherwise ask for a combined date+time
        try {
          const dbNative = getDB();
          await dbNative.collection('booking_sessions').updateOne(
            { user_id: String(tenantUserId), contact_id: String(from) },
            { $set: { step: 'awaiting_datetime', staff_id: staff._id }, $setOnInsert: { createdAt: new Date() }, $currentDate: { updatedAt: true } },
            { upsert: true }
          );
        } catch {}
        {
          const n = await generateAssistantNudge('ask_datetime', { examples: ["Nov 3 at 3pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
          await sendTextTracked(from, n, cfg);
        }
        return res.sendStatus(200);
      }

      // (moved: early return above ensures no bot replies when handoff is enabled)

      // Build short conversation history for better context
      let historyMessages = [];
      try {
        const hist = await listMessagesForThread(tenantUserId, from);
        const trimmed = Array.isArray(hist) ? hist.slice(-8) : [];
        historyMessages = trimmed
          .map(m => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: String(m.text_body || '') }))
          .filter(h => h.content && h.content.trim() && h.content.trim() !== String(text || '').trim());
      } catch {}

      const aiOptions = {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics,
        historyMessages
      }

      // Check for escalation requests BEFORE generating AI response
      if (wantsHuman(text)) {
        // In full AI mode, if the user requests a human, respect out-of-hours rules here
        try {
          if (await handleOutOfHoursGuard(tenantUserId, from, cfg)) {
            return res.sendStatus(200);
          }
        } catch {}
        const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
        const hasName = !!customer.display_name;
        if (!hasName) {
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
              VALUES (?, ?, 'ask_name', strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_name', updated_at = excluded.updated_at`).run(from, tenantUserId);
          } catch {}
          { const n = await generateAssistantNudge('handoff_ask_name', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
          return res.sendStatus(200);
        } else {
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
              VALUES (?, ?, 'ask_reason', strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
          } catch {}
          { const n = await generateAssistantNudge('handoff_ask_reason', {}, { tone: tenant?.ai_tone, style: tenant?.ai_style }); await sendTextTracked(from, n, cfg); }
          return res.sendStatus(200);
        }
      }

      // AI-first decision mode: let the model craft replies and propose one optional intent to execute
      // Honor conversation mode explicitly: 'full' → use decision planner; 'escalation' handled earlier
      const preferFullAI = (cfg?.conversation_mode !== 'escalation');
      if (!humanActive && preferFullAI) {
        try {
          const kbMatchesAIBase = await cachedRetrieveKbMatches(text, 8, tenantUserId, '', from);
          const profileSnippet = await buildCustomerProfileSnippet(tenantUserId, from);
          const kbMatchesAI = profileSnippet ? [profileSnippet, ...(Array.isArray(kbMatchesAIBase) ? kbMatchesAIBase : [])] : kbMatchesAIBase;
          const decision = await generateAgentDecision(text, kbMatchesAI, {
            tone: tenant?.ai_tone,
            style: tenant?.ai_style,
            blockedTopics: tenant?.ai_blocked_topics,
            historyMessages,
            features: {
              bookings_enabled: !!cfg?.bookings_enabled,
              reminders_enabled: !!cfg?.reminders_enabled,
              services: (() => { try { const s = JSON.parse(cfg?.services_json || '[]'); return Array.isArray(s) ? s : []; } catch { return []; } })()
            }
          });
          if (decision?.text) {
            await sendTextTracked(from, String(decision.text).slice(0, 1000), cfg);
          }
          const intentType = String(decision?.intent?.type || 'none').toLowerCase();
          const intentData = decision?.intent?.data || {};
          if (intentType && intentType !== 'none') {
            // Execute lightweight intents if we have enough info
            if (intentType === 'availability' && cfg?.bookings_enabled) {
              try {
                const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
                if (staff) {
                  let range = null;
                  if (intentData.startDate) {
                    const d = String(intentData.startDate);
                    const days = Math.min(30, Math.max(1, Number(intentData.days || 1)));
                    range = { startISO: d, days };
                  } else {
                    range = parseDateRange(String(intentData.range || text));
                  }
                  const tod = (() => {
                    const t = String(intentData.timeOfDay || '');
                    if (/morning/i.test(t)) return { startHour: 6, endHour: 12 };
                    if (/afternoon/i.test(t)) return { startHour: 12, endHour: 17 };
                    if (/evening|night/i.test(t)) return { startHour: 17, endHour: 21 };
                    return parseTimeOfDayFilter(text);
                  })();
                  if (range) {
                    const days = Math.min(14, Math.max(1, range.days || 1));
                    const startISODate = `${range.startISO}T00:00:00.000Z`;
                    await sendAvailabilityRange({ from, tenantUserId, staffId: String(staff._id), startISODate, days, tod, cfg, bodyLabel: 'Choose a time:' });
                  }
                }
              } catch {}
            }
            if (intentType === 'book' && cfg?.bookings_enabled) {
              try {
                const staff = await getFirstStaffOrNotifyNoStaff(tenantUserId, from, cfg);
                if (staff) {
                  const phrase = String(intentData.datetime || text);
                  const parsed = parseRequestedDateTime(phrase);
                  if (parsed && parsed.dateISO && parsed.hour != null) {
                    const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
                    const start = buildUtcFromLocalTz(parsed.dateISO, parsed.hour, parsed.minute || 0, staff.timezone || 'UTC');
                    const minLeadMs = Math.max(1, Number(process.env.BOOKING_MIN_LEAD_MINUTES || 5)) * 60000;
                    if (start.getTime() >= Date.now() + minLeadMs) {
                      const avail = await listAvailability({ userId: tenantUserId, staffId: String(staff._id), dateISO: base.toISOString(), days: 1 });
                      const nowCutoff = Date.now() + minLeadMs;
                      const slots = (Array.isArray(avail) ? (avail[0]?.slots || []) : []).filter(s => new Date(s.start).getTime() >= nowCutoff);
                      const toleranceMs = Math.max(120000, Math.floor(Number(staff.slot_minutes||30) * 60000 / 2));
                      const scored = slots.map(s => ({ slot: s, diff: Math.abs(new Date(s.start).getTime() - start.getTime()) }));
                      scored.sort((a,b) => a.diff - b.diff);
                      const match = scored.find(x => x.diff <= toleranceMs)?.slot || null;
                      if (match) {
                        try {
                          const r = await createBooking({ userId: tenantUserId, staffId: String(staff._id), startISO: match.start, endISO: match.end, contactPhone: from, notes: '' });
                          let questions = [];
                          try { questions = JSON.parse((tenant || {}).booking_questions_json || '[]'); } catch {}
                          if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
                          const providedName = intentData.name ? String(intentData.name).slice(0,80) : null;
                          let startIndex = 0; const answers = [];
                          if (providedName) { answers[0] = providedName; startIndex = 1; }
                          await getDB().collection('booking_sessions').updateOne(
                            { user_id: String(tenantUserId), contact_id: String(from) },
                            { $set: { staff_id: staff._id, start_iso: match.start, end_iso: match.end, step: 'pending', question_index: startIndex, answers_json: JSON.stringify(answers) }, $currentDate: { updatedAt: true } },
                            { upsert: true }
                          );
                          const when = new Date(match.start).toLocaleString();
                          const n = await generateAssistantNudge('confirm_booking', { when }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                          await sendTextTracked(from, n || `Great — I can book that. Ref #${r.id}`, cfg);
                          if (questions[startIndex]) await sendTextTracked(from, String(questions[startIndex]).slice(0,200), cfg);
                        } catch {}
                      } else {
                        const suggestions = scored.slice(0, 3).map(x => new Date(x.slot.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
                        const n = await generateAssistantNudge('closest_times', { suggestions }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                        await sendTextTracked(from, n || `Closest times: ${suggestions.join(', ')}`, cfg);
                      }
                    } else {
                      const n = await generateAssistantNudge('past_time_warning', { examples: ["today 4pm", "tomorrow 14:30"] }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                      await sendTextTracked(from, n, cfg);
                    }
                  }
                }
              } catch {}
            }
            if (intentType === 'cancel' && cfg?.bookings_enabled) {
              try {
                const now = Math.floor(Date.now()/1000);
                const digits = String(from || '').replace(/\D/g, '');
                const dbNative = getDB();
                const appt = await dbNative.collection('appointments')
                  .find({ user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } })
                  .project({ id: 1, start_ts: 1, staff_id: 1 })
                  .sort({ start_ts: 1 })
                  .limit(1)
                  .toArray()
                  .then(arr => arr[0] || null);
                if (appt) {
                  const minLead = Number(cfg.cancel_min_lead_minutes || 60);
                  const minsToStart = Math.floor((appt.start_ts - now)/60);
                  if (minsToStart >= minLead) {
                    await cancelBooking({ userId: tenantUserId, appointmentId: appt.id });
                    await sendTextTracked(from, `Canceled (Ref #${appt.id}).`, cfg);
                    if (appt.staff_id && appt.start_ts) {
                      await notifyWaitlistForNewAvailability({ tenantUserId, staffId: appt.staff_id, startTs: appt.start_ts, cfg });
                    }
                  }
                }
              } catch {}
            }
            if (intentType === 'reschedule' && cfg?.bookings_enabled) {
              try {
                const now = Math.floor(Date.now()/1000);
                const digits = String(from || '').replace(/\D/g, '');
                const dbNative = getDB();
                const appt = await dbNative.collection('appointments')
                  .find({ user_id: String(tenantUserId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: Math.floor(Date.now()/1000) } })
                  .project({ id: 1, start_ts: 1, staff_id: 1 })
                  .sort({ start_ts: 1 })
                  .limit(1)
                  .toArray()
                  .then(arr => arr[0] || null);
                if (appt) {
                  const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
                  const minsToStart = Math.floor((appt.start_ts - now)/60);
                  if (minsToStart >= minLead) {
                    await dbNative.collection('booking_sessions').updateOne(
                      { user_id: String(tenantUserId), contact_id: String(from) },
                      { $set: { step: 'awaiting_reschedule_dt', appt_id: appt.id, staff_id: appt.staff_id }, $currentDate: { updatedAt: true } },
                      { upsert: true }
                    );
                    const nRes = await generateAssistantNudge('reschedule_request', { ref: appt.id }, { tone: tenant?.ai_tone, style: tenant?.ai_style });
                    await sendTextTracked(from, nRes, cfg);
                  }
                }
              } catch {}
            }
            if (intentType === 'handoff') {
              try {
                const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
                const hasName = !!customer.display_name;
                if (!hasName) {
                  db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
                    VALUES (?, ?, 'ask_name', strftime('%s','now'))
                    ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_name', updated_at = excluded.updated_at`).run(from, tenantUserId);
                } else {
                  db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
                    VALUES (?, ?, 'ask_reason', strftime('%s','now'))
                    ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
                }
              } catch {}
            }
          }
          return res.sendStatus(200);
        } catch {}
      }

      // Retrieve candidate KB matches (expand to 8 for broader context)
      const kbMatches = await cachedRetrieveKbMatches(text, 8, tenantUserId, '', from);
      if (DEBUG_LOGS) console.log("KB Matches:", Array.isArray(kbMatches) ? kbMatches : []);
      
      const hasMatch = Array.isArray(kbMatches) && kbMatches.length > 0;
      const topScore = hasMatch ? (kbMatches[0].score || 0) : 0;
      // PRIORITIZE: if top KB hit has a PDF attached, send it instead of AI text
      if (!humanActive && hasMatch) {
        try {
          const kbTop = kbMatches[0];
          const row = await KBItem.findById(kbTop.id).select('file_url file_mime title').lean();
          const isPdf = row?.file_url && (/(^|\/)\S+\.pdf(\?|#|$)/i.test(String(row.file_url)) || /pdf/i.test(String(row.file_mime||'')));
          if (isPdf) {
            await sendDocumentTracked(from, row.file_url, ((row.title||'document') + '.pdf'), cfg);
            return res.sendStatus(200);
          }
        } catch {}
      }
      // Let AI decide using the KB. If it cannot answer from KB (or no KB), it must return the exact OUT OF SCOPE phrase.
      if (!humanActive) {
        const aiStart = Date.now();
        const aiReply = await generateAiReply(text, kbMatches, aiOptions);
        try { businessMetrics.trackAIRequest(true, Date.now() - aiStart); } catch {}
        const normalized = String(aiReply || '').trim();
        if (normalized && normalized.toLowerCase().startsWith(OUT_OF_SCOPE_PHRASE.toLowerCase())) {
          // Before initiating escalation in full AI mode, apply OOH guard
          try {
            if (await handleOutOfHoursGuard(tenantUserId, from, cfg)) {
              return res.sendStatus(200);
            }
          } catch {}
          // Out of scope → begin human escalation flow (collect name → reason)
          const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
          const hasName = !!customer.display_name;
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
              VALUES (?, ?, ?, strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, updated_at = excluded.updated_at`
            ).run(from, tenantUserId, hasName ? 'ask_reason' : 'ask_name');
          } catch {}
          if (!hasName) {
            await sendWhatsAppText(from, "I might not have enough info for that. I can connect you with a human — what’s your name?", cfg);
          } else {
            await sendWhatsAppText(from, "I can connect you with a human. What’s the reason for your request?", cfg);
          }
          return res.sendStatus(200);
        }

        const reply = normalized || (hasMatch ? (kbMatches[0].content || '') : '') || "Sorry, I couldn’t find that.";
        await sendTextTracked(from, reply, cfg);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
      
    } catch (e) {
      console.error("Webhook error:", e);
      return res.sendStatus(500);
    }
  });
}

