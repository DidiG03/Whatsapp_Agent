/**
 * Webhook routes for Meta (WhatsApp) integration.
 * - GET /webhook: verification handshake
 * - POST /webhook: inbound messages and status updates
 */
import crypto from "node:crypto";
import { db } from "../db.mjs";
import { findSettingsByVerifyToken, findSettingsByPhoneNumberId, findSettingsByBusinessPhone } from "../services/settings.mjs";
import { retrieveKbMatches, buildKbSuggestions } from "../services/kb.mjs";
import { sendWhatsappButton, sendWhatsAppText, sendWhatsappList, sendWhatsappReaction, sendWhatsappDocument } from "../services/whatsapp.mjs";
import { normalizePhone } from "../utils.mjs";
import { generateAiReply } from "../services/ai.mjs";
import { listAvailability, createBooking, rescheduleBooking, cancelBooking, buildDayRows, buildTimeRows } from "../services/booking.mjs";
import { recordOutboundMessage } from "../services/messages.mjs";
import { sendEscalationNotification, sendBookingNotification } from "../services/email.mjs";
import { incrementUsage } from "../services/usage.mjs";

function isGreeting(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;

  if (/^(hi|hello|hey|yo|hiya|howdy|greetings)\b/.test(s)) return true;
  if (/^good\s+(morning|afternoon|evening)\b/.test(s)) return true;

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
  if (/^[\u{1F44D}\u{1F44C}\u{1F64F}\u{1F44F}\u{2764}\u{1F60A}\u{1F642}]+$/u.test(onlyEmoji)) return true;

  const ACKS = [
    'thanks','thank you','many thanks','appreciated','thx','tnx','thanx','ty','tks','thank u',
    'ok','okay','k','kk','roger','got it','gotcha','cool','nice','great','perfect','awesome','cheers','sounds good','noted','understood'
  ];

  // Exact phrase or token match
  if (ACKS.includes(text)) return true;

  // Fuzzy match with small typos on phrase and tokens
  const tokens = text.split(' ').filter(Boolean);
  const candidates = [text, ...tokens];
  for (const c of candidates) {
    for (const a of ACKS) {
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
    const row = db.prepare(`SELECT content, file_url, file_mime, title FROM kb_items WHERE user_id = ? AND title = ?`).get(tenantUserId, title);
    if (row?.file_url) {
      const isPdf = /pdf/i.test(String(row.file_mime||'')) || /\.pdf(\?|#|$)/i.test(String(row.file_url||''));
      if (isPdf) {
        try {
          const resp = await sendWhatsappDocument(to, row.file_url, ((row.title||'document') + '.pdf'), cfg);
          let outboundId = resp?.messages?.[0]?.id;
          if (!outboundId) outboundId = `local_${Date.now()}_${Math.floor(Math.random()*1e9)}`;
          recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to, type: 'document', text: null, raw: { to, reply: 'kb_pdf' } });
          return true;
        } catch {}
      }
    }
    const outText = row?.content || "I couldn't find that info.";
    const resp = await sendWhatsAppText(to, outText, cfg);
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

  // Time: "at 3pm", "14:30", "3:15 p.m.", "4 pm"
  const mt = /(at|for)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (mt) {
    let hh = Number(mt[2]);
    let mm = Number(mt[3] || 0);
    const ap = mt[4] ? mt[4].toLowerCase() : '';
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      out.hour = hh; out.minute = mm;
    }
  }

  if (!out.dateISO || out.hour == null) return null;
  return out;
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

export default function registerWebhookRoutes(app) {
  // Test endpoint for debugging (bypasses signature verification)
  app.post("/test-webhook", async (req, res) => {
    try {
      const payload = req.body;
      const entry = payload.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      
      if (!message) {
        return res.sendStatus(200);
      }

      const metadata = change?.metadata;
      const tenant = findSettingsByPhoneNumberId(metadata?.phone_number_id) || findSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, ""));
      const tenantUserId = tenant?.user_id || null;
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      
      if (businessNumber && message.from === businessNumber) {
        return res.sendStatus(200);
      }
      
      const cfg = { ...tenant, user_id: tenantUserId };
      const from = message.from;
      let text = message.text?.body || "";

      console.log("Test webhook received:", { from, text, tenantUserId, conversation_mode: cfg.conversation_mode });

      // Check conversation mode FIRST - if Simple Escalation Mode, handle differently
      if (cfg.conversation_mode === 'escalation') {
        console.log("Simple Escalation Mode active in test");
        
        // Check if this is the first message from this contact (show greeting first)
        const state = db.prepare(`SELECT escalation_step FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (!state) {
          // First message: show greeting and additional message
          const greetText = cfg.entry_greeting || "Hello! How can I help you today?";
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
          
          // Default questions if none configured
          if (escalationQuestions.length === 0) {
            escalationQuestions = ["What's your name?", "What's the reason for contacting support today?"];
          }
          
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
          
          if (escalationQuestions.length === 0) {
            escalationQuestions = ["What's your name?", "What's the reason for contacting support today?"];
          }
          
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
            return res.json({ success: true, response: "Got it. I'm connecting you with a human now. Please wait a moment.", type: "escalation_complete" });
          }
        }
        
        return res.json({ success: true, response: "What's your name?", type: "escalation_ask_name" });
      }

      // Test greeting response (only for full AI mode)
      if (isGreeting(text)) {
        const greetText = cfg.entry_greeting || "Hello! How can I help you today?";
        console.log("Sending greeting:", greetText);
        // In test mode, just return the response instead of sending
        return res.json({ success: true, response: greetText, type: "greeting" });
      }

      // Test KB response
      const kbMatches = retrieveKbMatches(text, 8, tenantUserId, '');
      console.log("KB Matches:", kbMatches);
      
      if (Array.isArray(kbMatches) && kbMatches.length > 0) {
        const aiReply = await generateAiReply(text, kbMatches, {
          tone: tenant?.ai_tone,
          style: tenant?.ai_style,
          blockedTopics: tenant?.ai_blocked_topics
        });
        console.log("AI Reply:", aiReply);
        return res.json({ success: true, response: aiReply, type: "kb_response", kbMatches: kbMatches.length });
      }

      return res.json({ success: false, error: "No KB matches found" });
      
    } catch (e) {
      console.error("Test webhook error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // Webhook verification (Meta)
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const s = findSettingsByVerifyToken(token);
    if (mode === "subscribe" && s) {
      console.log("[WEBHOOK][GET] verified", {
        mode,
        tokenPresent: !!token,
        challengePresent: !!challenge
      });
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Receive messages
  app.post("/webhook", async (req, res) => {
    try {
      const sig = req.header("X-Hub-Signature-256") || req.header("x-hub-signature-256");
      const prospective = (() => {
        try {
          const temp = JSON.parse((req.rawBody || Buffer.from("{}"))?.toString("utf8"));
          const pnid = temp?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
          return findSettingsByPhoneNumberId(pnid);
        } catch { return null; }
      })();
      const s = prospective || {};
      // Temporarily disable signature verification for testing
      // TODO: Re-enable signature verification in production
      if (false && s.app_secret && sig) {
        const [algo, their] = sig.split("=");
        if (algo !== "sha256") return res.sendStatus(403);
        const hmac = crypto.createHmac("sha256", s.app_secret);
        const raw = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        hmac.update(raw);
        const ours = hmac.digest("hex");
        if (ours !== their) {
          req.log?.warn({ theirs, ours }, "Invalid webhook signature");
          return res.sendStatus(403);
        }
      }

      const payload = req.body;
      const entry = payload.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const statuses = change?.statuses;
      
      console.log("Webhook received payload:", JSON.stringify(payload, null, 2));
      if (Array.isArray(statuses) && statuses.length > 0) {
        statuses.forEach((s) => {
          const status = s.status;
          const recipientId = s.recipient_id;
          const messageId = s.id || s.message_id;
          const timestamp = s.timestamp;
          const error = Array.isArray(s.errors) ? s.errors[0] : undefined;
          const insertStatus = db.prepare(
            `INSERT INTO message_statuses (message_id, status, recipient_id, timestamp, error_code, error_title, error_message, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          try {
            insertStatus.run(
              messageId || null,
              status || null,
              recipientId || null,
              timestamp ? Number(timestamp) : null,
              error?.code ?? null,
              error?.title ?? null,
              error?.message ?? null,
              (change?.metadata?.phone_number_id ? (findSettingsByPhoneNumberId(change.metadata.phone_number_id)?.user_id || null) : null)
            );
          } catch {}
        });
      }

      const message = change?.messages?.[0];
      if (!message) {
        console.log("No message found in webhook payload");
        return res.sendStatus(200);
      }
      
      console.log("Processing message:", message);

      const metadata = change?.metadata;
      const tenant = findSettingsByPhoneNumberId(metadata?.phone_number_id) || findSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, ""));
      const tenantUserId = tenant?.user_id || null;
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      if (businessNumber && message.from === businessNumber) {
        return res.sendStatus(200);
      }
      const cfg = { ...tenant, user_id: tenantUserId };

      // Define sender and text early so all branches (including interactive) can use them
      const from = message.from;
      let text = message.text?.body || "";

      // Check conversation mode - if Simple Escalation Mode, handle differently
      if (cfg.conversation_mode === 'escalation') {
        console.log("Simple Escalation Mode active");
        
        // Check if this is the first message from this contact (show greeting first)
        const state = db.prepare(`SELECT escalation_step FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (!state) {
          // First message: show greeting and additional message
          const greetText = cfg.entry_greeting || "Hello! How can I help you today?";
          await sendWhatsAppText(from, greetText, cfg);
          
          // Send additional message if configured
          if (cfg.escalation_additional_message) {
            await sendWhatsAppText(from, cfg.escalation_additional_message, cfg);
          }
          
          // Get custom escalation questions
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(cfg.escalation_questions_json || '[]');
          } catch {}
          
          // Default questions if none configured
          if (escalationQuestions.length === 0) {
            escalationQuestions = ["What's your name?", "What's the reason for contacting support today?"];
          }
          
          // Start escalation flow with first question
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, escalation_questions_json, escalation_question_index, updated_at)
              VALUES (?, ?, 'ask_question', ?, 0, strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, escalation_questions_json = excluded.escalation_questions_json, escalation_question_index = excluded.escalation_question_index, updated_at = excluded.updated_at`).run(from, tenantUserId, JSON.stringify(escalationQuestions));
          } catch {}
          
          await sendWhatsAppText(from, escalationQuestions[0], cfg);
          return res.sendStatus(200);
        }
        
        // Continue with dynamic escalation questions flow for subsequent messages
        const currentState = db.prepare(`SELECT escalation_step, escalation_questions_json, escalation_question_index FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        
        if (currentState?.escalation_step === 'ask_question') {
          let escalationQuestions = [];
          try {
            escalationQuestions = JSON.parse(currentState.escalation_questions_json || '[]');
          } catch {}
          
          if (escalationQuestions.length === 0) {
            escalationQuestions = ["What's your name?", "What's the reason for contacting support today?"];
          }
          
          const currentIndex = currentState.escalation_question_index || 0;
          const nextIndex = currentIndex + 1;
          
          // Store the user's answer
          const answerKey = `escalation_answer_${currentIndex}`;
          try {
            db.prepare(`UPDATE handoff SET ${answerKey} = ?, escalation_question_index = ?, updated_at = strftime('%s','now') WHERE contact_id = ? AND user_id = ?`).run(text, nextIndex, from, tenantUserId);
          } catch {}
          
          // Check if there are more questions
          if (nextIndex < escalationQuestions.length) {
            await sendWhatsAppText(from, escalationQuestions[nextIndex], cfg);
          } else {
            // All questions answered, escalate to human
            await sendWhatsAppText(from, "Got it. I'm connecting you with a human now. Please wait a moment.", cfg);
            
            // Mark as escalated
            try {
              db.prepare(`UPDATE handoff SET escalation_step = 'escalated', updated_at = strftime('%s','now') WHERE contact_id = ? AND user_id = ?`).run(from, tenantUserId);
            } catch {}
          }
          return res.sendStatus(200);
        }
      }

      const inboundId = message.id;
      let isFirstTimeInbound = true;
      if (inboundId) {
        const insertInbound = db.prepare(
          `INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
           VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        try {
          const info = insertInbound.run(
            inboundId,
            tenantUserId,
            from || null,
            metadata?.display_phone_number?.replace(/\D/g, "") || null,
            normalizePhone(from) || null,
            normalizePhone(metadata?.display_phone_number) || null,
            message.type || null,
            text || null,
            message.timestamp ? Number(message.timestamp) : null,
            JSON.stringify(message)
          );
          isFirstTimeInbound = info.changes > 0;
          
          // Track inbound message usage
          if (isFirstTimeInbound) {
            incrementUsage(tenantUserId, 'inbound_messages');
          }
        } catch {
          isFirstTimeInbound = false;
        }
      }

      if (!isFirstTimeInbound) {
        return res.sendStatus(200);
      }

      // If agent handoff is active for this contact and not expired, do not auto‑reply at all
      try {
        const hs = db.prepare(`SELECT is_human, COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
        const now = Math.floor(Date.now()/1000);
        if (hs?.is_human) {
          if (!hs.exp || hs.exp > now) {
            return res.sendStatus(200);
          } else {
            // Expired → flip back to AI
            try { db.prepare(`UPDATE handoff SET is_human = 0, updated_at = strftime('%s','now') WHERE contact_id = ? AND user_id = ?`).run(from, tenantUserId); } catch {}
          }
        }
      } catch {}

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
            await sendWhatsAppText(from, "Thanks, and what’s the reason for contacting a human today?", cfg);
            return res.sendStatus(200);
          } else {
            await sendWhatsAppText(from, "Could you please share your name so I can connect you to a human?", cfg);
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
            
            await sendWhatsAppText(from, "Got it. I'm connecting you with a human now. Please wait a moment.", cfg);
            return res.sendStatus(200);
          } else {
            await sendWhatsAppText(from, "Could you share a brief reason so I can route you to the right person?", cfg);
            return res.sendStatus(200);
          }
        }
      } catch {}
      } // End escalation mode check

      // Handle interactive replies (buttons/lists) BEFORE filtering to text
      if (message?.type === "interactive") {
        const data = message.interactive;
        if (data?.type === "button_reply") {
          const { id, title } = data.button_reply || {};
          if (id === "BOOKING_START") {
            // Begin booking: show date picker (today + next 6 days)
            const staff = db.prepare(`SELECT id, slot_minutes FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
            if (!staff) {
              await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg);
              return res.sendStatus(200);
            }
            const days = buildDayRows(staff.id);
            await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
            return res.sendStatus(200);
          }
          if (id === "YES_GRAPH") {
            await sendWhatsAppText(from, "Great — sending the report graph now.", cfg);
          } else if (id === "NO_GRAPH") {
            await sendWhatsAppText(from, "Okay. If you need it later, just ask.", cfg);
          } else if (id?.startsWith("RESCHED_CONFIRM_")) {
            try {
              const parts = id.split("_");
              // RESCHED_CONFIRM_<apptId>_<startISO>_<endISO>
              const apptId = Number(parts[2] || 0);
              const startISO = parts[3];
              const endISO = parts[4];
              if (apptId && startISO && endISO) {
                const now = Math.floor(Date.now()/1000);
                const row = db.prepare(`SELECT start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
                const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
                const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
                if (minsToStart < minLead) {
                  await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
                  return res.sendStatus(200);
                }
                await rescheduleBooking({ userId: tenantUserId, appointmentId: apptId, startISO, endISO });
                await sendWhatsAppText(from, `Rescheduled to ${new Date(startISO).toLocaleString()} (Ref #${apptId}).`, cfg);
              }
            } catch {}
            return res.sendStatus(200);
          } else if (id?.startsWith("RESCHED_CANCEL_")) {
            await sendWhatsAppText(from, "Okay, I didn't change anything.", cfg);
            return res.sendStatus(200);
          } else if (id?.startsWith("CANCEL_CONFIRM_")) {
            try {
              const apptId = Number(id.split("_")[2] || 0);
              if (apptId) {
                const now = Math.floor(Date.now()/1000);
                const row = db.prepare(`SELECT start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
                const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
                const minLead = Number(cfg.cancel_min_lead_minutes || 60);
                if (minsToStart < minLead) {
                  await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
                  return res.sendStatus(200);
                }
                await cancelBooking({ userId: tenantUserId, appointmentId: apptId });
                await sendWhatsAppText(from, `Canceled (Ref #${apptId}).`, cfg);
              }
            } catch {}
            return res.sendStatus(200);
          } else if (id?.startsWith("CANCEL_ABORT_")) {
            await sendWhatsAppText(from, "Okay, kept as is.", cfg);
            return res.sendStatus(200);
          } else if (id?.startsWith("REM_OK_")) {
            const apptId = Number(id.split("_")[2] || 0);
            if (apptId) {
              const row = db.prepare(`SELECT status, start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
              if (row && row.status === 'confirmed') {
                await sendWhatsAppText(from, "Great, see you then!", cfg);
              } else {
                await sendWhatsAppText(from, "It looks like that booking was already canceled or changed. If you need a new time, say 'book'.", cfg);
              }
            }
            return res.sendStatus(200);
          } else if (id?.startsWith("REM_CANCEL_")) {
            const apptId = Number(id.split("_")[2] || 0);
            if (apptId) {
              const now = Math.floor(Date.now()/1000);
              const row = db.prepare(`SELECT start_ts FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
              const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
              const minLead = Number(cfg.cancel_min_lead_minutes || 60);
              if (minsToStart < minLead) {
                await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
              } else {
                try { await cancelBooking({ userId: tenantUserId, appointmentId: apptId }); await sendWhatsAppText(from, `Canceled (Ref #${apptId}).`, cfg); } catch {}
              }
            }
            return res.sendStatus(200);
          } else if (id?.startsWith("REM_RESCHED_")) {
            const apptId = Number(id.split("_")[2] || 0);
            if (apptId) {
              const now = Math.floor(Date.now()/1000);
              const row = db.prepare(`SELECT start_ts, staff_id FROM appointments WHERE id = ? AND user_id = ?`).get(apptId, tenantUserId);
              const minsToStart = row ? Math.floor((row.start_ts - now)/60) : 99999;
              const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
              if (minsToStart < minLead) {
                await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
              } else if (row?.staff_id) {
            const days = buildDayRows(row.staff_id, apptId);
                await sendWhatsappList(from, "Pick a new day", "Choose a date:", "Select", days, cfg);
              }
            }
            return res.sendStatus(200);
          } else if (id?.startsWith("KB_TITLE_")) {
            const wanted = id.replace("KB_TITLE_", "");
            await sendKbItemByTitle({ tenantUserId, to: from, title: wanted, cfg });
          }
          return res.sendStatus(200);
        }
        if (data?.type === "list_reply") {
          const { id, title } = data.list_reply || {};
          // Greeting list actions
          if (id === 'GREET_BOOK') {
            const staff = db.prepare(`SELECT id FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
            if (!staff) { await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg); return res.sendStatus(200); }
        const days = buildDayRows(staff.id);
            await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
            return res.sendStatus(200);
          }
          if (id?.startsWith('GREET_KB_TITLE_')) {
            const titleDec = decodeURIComponent(id.replace('GREET_KB_TITLE_', ''));
            await sendKbItemByTitle({ tenantUserId, to: from, title: titleDec, cfg });
            return res.sendStatus(200);
          }

          // Reschedule day picked → times for that date
          if (id?.startsWith("RESCHED_PICK_DAY_")) {
            try {
              const parts = id.split("_");
              // Format: RESCHED_PICK_DAY_<YYYY-MM-DD>_<staffId>_<apptId>
              const dateStr = parts.slice(3, 4)[0];
              const staffId = Number(parts.slice(4, 5)[0] || 0);
              const apptId = Number(parts.slice(5, 6)[0] || 0);
              if (tenantUserId && staffId && dateStr && apptId) {
                // Use midday UTC to avoid date shifting across timezones
                const dateISO = new Date(`${dateStr}T12:00:00.000Z`).toISOString();
                const rows = await buildTimeRows({ userId: tenantUserId, staffId, dateISO, limit: 10, apptId });
                if (!rows.length) {
                  await sendWhatsAppText(from, "No available times on that date. Please pick another day.", cfg);
                  return res.sendStatus(200);
                }
                await sendWhatsappList(from, `${new Date(dateISO).toLocaleDateString()}`, "Choose a new time:", "Select", rows, cfg);
              }
            } catch {}
            return res.sendStatus(200);
          }
          // Reschedule time picked → ask for confirmation
          if (id?.startsWith("RESCHED_PICK_TIME_")) {
            try {
              const parts = id.split("_");
              // Format: RESCHED_PICK_TIME_<apptId>_<staffId>_<startISO>_<endISO>
              const apptId = Number(parts[3] || 0);
              const staffId = Number(parts[4] || 0);
              const startISO = parts[5];
              const endISO = parts[6];
              if (apptId && staffId && startISO && endISO) {
                await sendWhatsappButton(from, `Reschedule to ${new Date(startISO).toLocaleString()}?`, [
                  { id: `RESCHED_CONFIRM_${apptId}_${startISO}_${endISO}`, title: 'Yes' },
                  { id: `RESCHED_CANCEL_${apptId}`, title: 'No' }
                ], cfg);
              }
            } catch {}
            return res.sendStatus(200);
          }
          if (id?.startsWith("PICK_DAY_")) {
            try {
              const parts = id.split("_");
              // Format: PICK_DAY_<YYYY-MM-DD>_<staffId>
              let dateStr = parts.slice(2, 3)[0];
              let staffId = Number(parts.slice(3, 4)[0] || 0);
              if (!staffId) {
                const staff = db.prepare(`SELECT id FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
                staffId = staff?.id || 0;
              }
              // Fallback: if dateStr missing or malformed, try parsing title (add current year)
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
                // Use midday UTC to avoid TZ boundary issues
                const dateISO = new Date(`${dateStr}T12:00:00.000Z`).toISOString();
                const rows = await buildTimeRows({ userId: tenantUserId, staffId, dateISO, limit: 10, apptId: null });
                if (!rows.length) {
                  await sendWhatsAppText(from, "No available times on that date. Please pick another day.", cfg);
                  return res.sendStatus(200);
                }
                await sendWhatsappList(from, `${new Date(dateISO).toLocaleDateString()}`, "Choose a time:", "Select", rows, cfg);
              } else {
                await sendWhatsAppText(from, "I couldn't read that date. Please pick a day again.", cfg);
              }
            } catch (e) {
              await sendWhatsAppText(from, "Something went wrong loading times. Please pick a day again.", cfg);
            }
            return res.sendStatus(200);
          }
          if (id?.startsWith("BOOK_SLOT_")) {
            try {
              const parts = id.split("_");
              // Format: BOOK_SLOT_<startISO>_<endISO>_<staffId>
              const startISO = parts.slice(2, 3)[0];
              const endISO = parts.slice(3, 4)[0];
              const staffId = Number(parts.slice(4, 5)[0] || 0);
              if (tenantUserId && staffId && startISO && endISO) {
                // Start a booking session with dynamic questions
                const settings = tenant || {};
                let questions = [];
                try { questions = JSON.parse(settings.booking_questions_json || '[]'); } catch {}
                if (!Array.isArray(questions) || !questions.length) {
                  questions = ["What's your name?", "What's the reason for the booking?"];
                }
                try {
                  db.prepare(`INSERT INTO booking_sessions (user_id, contact_id, staff_id, start_iso, end_iso, step, question_index, answers_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', 0, '[]', strftime('%s','now'), strftime('%s','now'))
                    ON CONFLICT(user_id, contact_id) DO UPDATE SET staff_id=excluded.staff_id, start_iso=excluded.start_iso, end_iso=excluded.end_iso, step='pending', question_index=0, answers_json='[]', updated_at=strftime('%s','now')
                  `).run(tenantUserId, from, staffId, startISO, endISO);
                } catch {}
                // Ask first question
                await sendWhatsAppText(from, String(questions[0]).slice(0, 200), cfg);
              } else {
                await sendWhatsAppText(from, "Sorry, I couldn't book that slot.", cfg);
              }
            } catch (e) {
              await sendWhatsAppText(from, "Sorry, that slot is no longer available.", cfg);
            }
            return res.sendStatus(200);
          }
          if (id?.startsWith("CLINIC_")) {
            await sendWhatsAppText(from, `You chose ${title}.`, cfg);
            await sendWhatsappButton(
              from,
              "Would you like me to send the report graph so you can forward it to your doctor?",
              [{ id: "YES_GRAPH", title: "Yes" }, { id: "NO_GRAPH", title: "No" }],
              cfg
            );
          }
          return res.sendStatus(200);
        }
        return res.sendStatus(200);
      }

      // Combine recent short fragments: users may type one word per bubble (e.g., "I" "want" "to" "book").
      // Aggregate last few inbound text messages within a small time window to improve intent detection.
      try {
        const nowSec = Number(message.timestamp || Math.floor(Date.now()/1000));
        const digits = String(from || '').replace(/\D/g, '');
        const windowSec = 20; // consider last 20s of fragments
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
        if (joined && (isShort(text) || parts.length >= 3)) {
          text = joined;
        }
      } catch {}

      if(isGreeting(text)) {
        // Throttle greetings: respond at most once per 60 seconds per contact
        try {
          const st = db.prepare(`SELECT last_greet_ts FROM contact_state WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from);
          const now = Math.floor(Date.now()/1000);
          const last = st?.last_greet_ts || 0;
          const delta = now - last;
          const shouldRespond = delta > 60;
          if (shouldRespond) {
            db.prepare(`INSERT INTO contact_state (user_id, contact_id, last_greet_ts) VALUES (?, ?, ?)
              ON CONFLICT(user_id, contact_id) DO UPDATE SET last_greet_ts = excluded.last_greet_ts`).run(tenantUserId, from, now);
          } else {
            // Within throttle window: silently ack
            return res.sendStatus(200);
          }
        } catch {}

        const greetText = cfg.entry_greeting || "Hello! How can I help you today?";
        const greetResp = await sendWhatsAppText(from, greetText, cfg);
        try {
          const outboundId = greetResp?.messages?.[0]?.id;
          if (outboundId) {
            recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to: from, type: 'text', text: greetText, raw: { to: from, text: greetText } });
          }
        } catch {}
        // Only include this tenant's KB items explicitly flagged to show in menu
        const rows = [];
        if (cfg?.bookings_enabled) rows.push({ id: 'GREET_BOOK', title: 'Bookings', description: '' });
        try {
          const titles = db.prepare(`
            SELECT title FROM kb_items
            WHERE user_id = ? AND COALESCE(show_in_menu,0) = 1 AND title IS NOT NULL AND TRIM(title) <> ''
            ORDER BY created_at DESC, id DESC LIMIT 20
          `).all(tenantUserId).map(r => String(r.title||'').trim()).filter(Boolean);
          const seen = new Set();
          for (const t of titles) {
            if (rows.length >= 10) break; // WhatsApp list max per section
            if (seen.has(t)) continue; seen.add(t);
            rows.push({ id: `GREET_KB_TITLE_${encodeURIComponent(t)}`, title: t, description: '' });
          }
        } catch {}
          if (rows.length) {
          const header = 'You can tap one of these to begin:';
          const body = 'Select an option to get started.';
          const listResp = await sendWhatsappList(from, header, body, 'Select', rows, cfg);
          try {
            const outboundId = listResp?.messages?.[0]?.id;
              if (outboundId) {
                recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to: from, type: 'interactive', text: `${header}\n${body}`, raw: { to: from, interactive: 'list' } });
              }
          } catch {}
        }
        return res.sendStatus(200);
      }

      // Acknowledgements like "thanks", "ok" → react with 👍
      if (isAcknowledgement(text)) {
        try { await sendWhatsappReaction(from, inboundId, "👍", cfg); } catch {}
        return res.sendStatus(200);
      }

      // Dev/test: manual reminder preview
      if (/\btest\s+reminder\b/i.test(text || "")) {
        const digits = String(from || '').replace(/\D/g, '');
        let appt = db.prepare(`
          SELECT a.id, a.start_ts, a.staff_id
          FROM appointments a
          WHERE a.user_id = ? AND a.status = 'confirmed'
            AND (REPLACE(a.contact_phone,'+','') = ? OR a.contact_phone = ?)
            AND a.start_ts >= strftime('%s','now')
          ORDER BY a.start_ts ASC
          LIMIT 1
        `).get(tenantUserId, digits, digits);
        if (!appt) {
          // Create a lightweight test appointment 60 minutes from now if none exists
          const staff = db.prepare(`SELECT id, slot_minutes FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
          if (staff?.id) {
            const startISO = new Date(Date.now() + 60*60000).toISOString();
            const endISO = new Date(Date.now() + (60 + (Number(staff.slot_minutes||30))) * 60000).toISOString();
            try {
              const r = await createBooking({ userId: tenantUserId, staffId: staff.id, startISO, endISO, contactPhone: from, notes: 'TEST REMINDER' });
              const row = db.prepare(`SELECT id, start_ts, staff_id FROM appointments WHERE id = ?`).get(r.id);
              appt = row || null;
            } catch {}
          }
        }
        if (!appt) { await sendWhatsAppText(from, "No staff is configured or booking could not be created for test.", cfg); return res.sendStatus(200); }
        const when = new Date((appt.start_ts||0)*1000).toLocaleString();
        await sendWhatsappButton(from, `Reminder: your appointment is at ${when}. Is this still correct?`, [
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
        const upcoming = db.prepare(`
          SELECT a.id, a.start_ts, a.status, a.notes, s.name AS staff_name
          FROM appointments a
          LEFT JOIN staff s ON s.id = a.staff_id
          WHERE a.user_id = ? AND a.status = 'confirmed'
            AND (REPLACE(a.contact_phone, '+','') = ? OR a.contact_phone = ?)
            AND a.start_ts >= strftime('%s','now')
          ORDER BY a.start_ts ASC
          LIMIT 3
        `).all(tenantUserId, digits, digits);
        if (upcoming && upcoming.length) {
          const lines = upcoming.map((r) => {
            const when = new Date((r.start_ts||0)*1000).toLocaleString();
            const meta = `Ref #${r.id}${r.staff_name ? ' · ' + r.staff_name : ''}`;
            return `- ${when} (${meta})`;
          }).join('\n');
          await sendWhatsAppText(from, `Your upcoming ${upcoming.length>1?'bookings':'booking'}:\n${lines}`, cfg);
          return res.sendStatus(200);
        }
        const last = db.prepare(`
          SELECT a.id, a.start_ts, a.status, s.name AS staff_name
          FROM appointments a
          LEFT JOIN staff s ON s.id = a.staff_id
          WHERE a.user_id = ?
            AND (REPLACE(a.contact_phone, '+','') = ? OR a.contact_phone = ?)
            AND a.start_ts < strftime('%s','now')
          ORDER BY a.start_ts DESC
          LIMIT 1
        `).get(tenantUserId, digits, digits);
        if (last) {
          const when = new Date((last.start_ts||0)*1000).toLocaleString();
          const meta = `Ref #${last.id}${last.staff_name ? ' · ' + last.staff_name : ''}`;
          await sendWhatsAppText(from, `I don't see an upcoming booking. Your last booking was ${when} (${meta}).`, cfg);
        } else {
          await sendWhatsAppText(from, "I couldn't find a booking for your number.", cfg);
        }
        return res.sendStatus(200);
      }

      // If in booking session: collect answers based on configured questions
      const sess = tenantUserId ? db.prepare(`SELECT * FROM booking_sessions WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) : null;
      if (tenantUserId && sess && message.type === 'text') {
        const settings = tenant || {};
        let questions = [];
        try { questions = JSON.parse(settings.booking_questions_json || '[]'); } catch {}
        if (!Array.isArray(questions) || !questions.length) questions = ["What's your name?", "What's the reason for the booking?"];
        const content = text.trim();
        let answers = [];
        try { answers = JSON.parse(sess.answers_json || '[]'); } catch { answers = []; }
        const idx = Number(sess.question_index || 0);
        answers[idx] = content;
        const nextIdx = idx + 1;
        if (nextIdx < questions.length) {
          db.prepare(`UPDATE booking_sessions SET answers_json = ?, question_index = ?, step = 'pending', updated_at = strftime('%s','now') WHERE id = ?`).run(JSON.stringify(answers), nextIdx, sess.id);
          await sendWhatsAppText(from, String(questions[nextIdx]).slice(0,200), cfg);
          return res.sendStatus(200);
        }
        // All answered: create booking; notes join Q/A
        const pairs = questions.map((q, i) => `${q}: ${answers[i] || ''}`.trim());
        const notes = pairs.join(' | ').slice(0, 800);
        try {
          const r = await createBooking({ userId: tenantUserId, staffId: sess.staff_id, startISO: sess.start_iso, endISO: sess.end_iso, contactPhone: from, notes });
          const title = tenant?.business_name ? `Appointment with ${tenant.business_name}` : 'Appointment';
          const icsUrl = `${req.protocol}://${req.get('host')}/ics?title=${encodeURIComponent(title)}&start=${encodeURIComponent(sess.start_iso)}&end=${encodeURIComponent(sess.end_iso)}&desc=${encodeURIComponent('Ref #' + r.id)}`;
          await sendWhatsAppText(from, `Booked: ${new Date(sess.start_iso).toLocaleString()}. Ref #${r.id}\n\nAdd to your calendar: ${icsUrl}`, cfg);
          
          // Send email notification to account owner
          try {
            const staff = db.prepare(`SELECT name FROM staff WHERE id = ?`).get(sess.staff_id);
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
        } catch {
          await sendWhatsAppText(from, "Sorry, that slot could not be booked. Please try another time.", cfg);
        }
        try { db.prepare(`DELETE FROM booking_sessions WHERE id = ?`).run(sess.id); } catch {}
        return res.sendStatus(200);
      }

      // Reschedule / Cancel intents (gated by settings)
      const wantsReschedule = /\b(reschedule|change\s+(time|booking|appointment))\b/i.test(text || "");
      const wantsCancel = /\b(cancel|cancelation|cancellation)\b/i.test(text || "");
      if (cfg?.bookings_enabled && (wantsReschedule || wantsCancel)) {
        const now = Math.floor(Date.now()/1000);
        const digits = String(from || '').replace(/\D/g, '');
        const appt = db.prepare(`SELECT id, start_ts, staff_id FROM appointments WHERE user_id = ? AND status = 'confirmed' AND (REPLACE(contact_phone,'+','') = ? OR contact_phone = ?) AND start_ts >= strftime('%s','now') ORDER BY start_ts ASC LIMIT 1`).get(tenantUserId, digits, digits);
        if (!appt) {
          await sendWhatsAppText(from, "I couldn't find an upcoming booking for your number.", cfg);
          return res.sendStatus(200);
        }
        const minsToStart = Math.floor((appt.start_ts - now) / 60);
        if (wantsCancel) {
          const minLead = Number(cfg.cancel_min_lead_minutes || 60);
          if (minsToStart < minLead) {
            await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
            return res.sendStatus(200);
          }
          await sendWhatsappButton(from, `Are you sure you want to cancel Ref #${appt.id}?`, [
            { id: `CANCEL_CONFIRM_${appt.id}`, title: 'Yes' },
            { id: `CANCEL_ABORT_${appt.id}`, title: 'No' }
          ], cfg);
          return res.sendStatus(200);
        }
        if (wantsReschedule) {
          const minLead = Number(cfg.reschedule_min_lead_minutes || 60);
          if (minsToStart < minLead) {
            await sendWhatsAppText(from, `It's too close to your start time (less than ${minLead} min). Please contact us directly.`, cfg);
            return res.sendStatus(200);
          }
          // Show date list for reschedule (re-use booking date picker)
          const days = buildDayRows(appt.staff_id, appt.id);
          await sendWhatsappList(from, "Pick a new day", "Choose a date:", "Select", days, cfg);
          return res.sendStatus(200);
        }
      }

      // Booking intent (gated by settings flag) with full-sentence parsing for date/time + name
      const wantsBooking = /\b(book|booking|appointment|schedule)\b/i.test(text || "");
      if (cfg?.bookings_enabled && wantsBooking) {
        // Pick first staff for tenant
        const staff = db.prepare(`SELECT id, timezone, slot_minutes, working_hours_json FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
        if (!staff) {
          await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg);
          return res.sendStatus(200);
        }

        const parsed = parseRequestedDateTime(text);
        const providedName = parseNameFromMessage(text);
        if (parsed) {
          // Build requested slot in staff timezone (approximate using provided hour/minute)
          const base = new Date(`${parsed.dateISO}T00:00:00.000Z`);
          const start = new Date(base); start.setUTCHours(parsed.hour, parsed.minute || 0, 0, 0);
          const end = new Date(start.getTime() + (Number(staff.slot_minutes||30) * 60000));
          // Check availability for that date
          const avail = await listAvailability({ userId: tenantUserId, staffId: staff.id, dateISO: base.toISOString(), days: 1 });
          const slots = Array.isArray(avail) ? (avail[0]?.slots || []) : [];
          const match = slots.find(s => {
            const ss = new Date(s.start).getTime();
            return Math.abs(ss - start.getTime()) < 60*1000; // same minute
          });
          if (match) {
            // Create booking immediately and start Q&A from next question after name if present
            try {
              const notesParts = [];
              if (providedName) notesParts.push(`Name: ${providedName}`);
              const notes = notesParts.join(' ');
              const r = await createBooking({ userId: tenantUserId, staffId: staff.id, startISO: match.start, endISO: match.end, contactPhone: from, notes });
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
                  db.prepare(`INSERT INTO booking_sessions (user_id, contact_id, staff_id, start_iso, end_iso, step, question_index, answers_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', 1, json_set('[]', '$[0]', ?), strftime('%s','now'), strftime('%s','now'))
                    ON CONFLICT(user_id, contact_id) DO UPDATE SET staff_id=excluded.staff_id, start_iso=excluded.start_iso, end_iso=excluded.end_iso, step='pending', question_index=1, answers_json=json_set('[]', '$[0]', ?), updated_at=strftime('%s','now')
                  `).run(tenantUserId, from, staff.id, match.start, match.end, providedName, providedName);
                } catch {}
                startIndex = 1;
              } else {
                try {
                  db.prepare(`INSERT INTO booking_sessions (user_id, contact_id, staff_id, start_iso, end_iso, step, question_index, answers_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', 0, '[]', strftime('%s','now'), strftime('%s','now'))
                    ON CONFLICT(user_id, contact_id) DO UPDATE SET staff_id=excluded.staff_id, start_iso=excluded.start_iso, end_iso=excluded.end_iso, step='pending', question_index=0, answers_json='[]', updated_at=strftime('%s','now')
                  `).run(tenantUserId, from, staff.id, match.start, match.end);
                } catch {}
              }
              const when = new Date(match.start).toLocaleString();
              await sendWhatsAppText(from, `Great — I can book ${when}.`, cfg);
              const q = questions[startIndex];
              if (q) {
                await sendWhatsAppText(from, String(q).slice(0,200), cfg);
              } else {
                // No questions → finalize
                await sendWhatsAppText(from, `Booked: ${when}. Ref #${r.id}`, cfg);
              }
              return res.sendStatus(200);
            } catch {
              // Fall through to time picker if booking creation fails
            }
          }
          // If date exists but exact time unavailable → show available times for that day
          const rows = await buildTimeRows({ userId: tenantUserId, staffId: staff.id, dateISO: base.toISOString(), limit: 10, apptId: null });
          if (!rows.length) {
            await sendWhatsAppText(from, "That day unfortunately is not available. Please pick another day.", cfg);
            const days = buildDayRows(staff.id);
            await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
          } else {
            await sendWhatsAppText(from, "That specific time isn't available. Here are available times for that day:", cfg);
            await sendWhatsappList(from, new Date(base).toLocaleDateString(), "Choose a time:", "Select", rows, cfg);
          }
          return res.sendStatus(200);
        }

        // No parsed date/time → fallback to normal date picker
        const days = buildDayRows(staff.id);
        await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
        return res.sendStatus(200);
      }

      // (moved: early return above ensures no bot replies when handoff is enabled)

      const aiOptions = {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics
      }

      // Check for escalation requests BEFORE generating AI response
      if (wantsHuman(text)) {
        const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
        const hasName = !!customer.display_name;
        if (!hasName) {
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
              VALUES (?, ?, 'ask_name', strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_name', updated_at = excluded.updated_at`).run(from, tenantUserId);
          } catch {}
          await sendWhatsAppText(from, "Sure — before I connect you with a human, what's your name?", cfg);
          return res.sendStatus(200);
        } else {
          try {
            db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
              VALUES (?, ?, 'ask_reason', strftime('%s','now'))
              ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = 'ask_reason', updated_at = excluded.updated_at`).run(from, tenantUserId);
          } catch {}
          await sendWhatsAppText(from, "Thanks. What's the reason for escalating to our customer service team today?", cfg);
          return res.sendStatus(200);
        }
      }

      // Retrieve candidate KB matches (expand to 8 for broader context)
      const kbMatches = retrieveKbMatches(text, 8, tenantUserId, '');
      console.log("KB Matches:", kbMatches);
      
      const hasMatch = Array.isArray(kbMatches) && kbMatches.length > 0;
      const topScore = hasMatch ? (kbMatches[0].score || 0) : 0;
      // PRIORITIZE: if top KB hit has a PDF attached, send it instead of AI text
      if (hasMatch) {
        try {
          const kbTop = kbMatches[0];
          const row = db.prepare(`SELECT file_url, file_mime, title FROM kb_items WHERE id = ?`).get(kbTop.id);
          const isPdf = row?.file_url && (/(^|\/)\S+\.pdf(\?|#|$)/i.test(String(row.file_url)) || /pdf/i.test(String(row.file_mime||'')));
          if (isPdf) {
            await sendWhatsappDocument(from, row.file_url, ((row.title||'document') + '.pdf'), cfg);
            return res.sendStatus(200);
          }
        } catch {}
      }
      // Let AI decide using the KB. If it cannot answer from KB, it must return the exact OUT OF SCOPE phrase.
      if (hasMatch) {
        const aiReply = await generateAiReply(text, kbMatches, aiOptions);
        const normalized = String(aiReply || '').trim();
        const OUT_OF_SCOPE = 'That seems outside my scope. Try choosing one of these topics';

        if (normalized && normalized.toLowerCase().startsWith(OUT_OF_SCOPE.toLowerCase())) {
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

        const reply = normalized || kbMatches[0].content || "Sorry, I couldn’t find that.";
        const sendRespData = await sendWhatsAppText(from, reply, cfg);
        try {
          const outboundId = sendRespData?.messages?.[0]?.id;
          if (outboundId) {
            recordOutboundMessage({ messageId: outboundId, userId: tenantUserId, cfg, to: from, type: 'text', text: reply, raw: { to: from, reply } });
          }
        } catch {}
        return res.sendStatus(200);
      }

      // If top KB match has a PDF file, send it; else fallback to suggestions
      if (hasMatch && kbMatches[0]?.content && /\b(pdf)\b/i.test(String(kbMatches[0].title||'')) ) {
        const row = db.prepare(`SELECT file_url, file_mime FROM kb_items WHERE id = ?`).get(kbMatches[0].id);
        if (row?.file_url && (/pdf$/i.test(row.file_mime || '') || /\.pdf(\?|$)/i.test(row.file_url))) {
          try { await sendWhatsappDocument(from, row.file_url, (kbMatches[0].title || 'document') + '.pdf', cfg); return res.sendStatus(200); } catch {}
        }
      }
      // Low/no confidence → offer 3 smart options from KB
      const suggestions = buildKbSuggestions(tenantUserId, text, 3);
      console.log("Suggestions:", suggestions);
      const customer = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(tenantUserId, from) || {};
      const hasName = !!customer.display_name;
      try {
        db.prepare(`INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at)
          VALUES (?, ?, ?, strftime('%s','now'))
          ON CONFLICT(contact_id, user_id) DO UPDATE SET escalation_step = excluded.escalation_step, updated_at = excluded.updated_at`
        ).run(from, tenantUserId, hasName ? 'ask_reason' : 'ask_name');
      } catch {}
      if (suggestions.length > 0) {
        await sendWhatsappButton(
          from,
          "That seems outside my scope. I can connect you with a human. First, choose one of these topics if helpful:",
          suggestions,
          cfg
        );
      }
      if (!hasName) {
        await sendWhatsAppText(from, "Before I connect you, what’s your name?", cfg);
      } else {
        await sendWhatsAppText(from, "What’s the reason for contacting a human today?", cfg);
      }

      return res.sendStatus(200);
      
    } catch (e) {
      console.error("Webhook error:", e);
      return res.sendStatus(500);
    }
  });
}

