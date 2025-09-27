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
import { listAvailability, createBooking, rescheduleBooking, cancelBooking } from "../services/booking.mjs";

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

export default function registerWebhookRoutes(app) {
  // Webhook verification (Meta)
  app.get("/webhook", (req, res) => {
    console.log("[WEBHOOK][GET] hit", {
      query: req.query,
      ip: req.ip,
      ua: req.header("user-agent")
    });
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
    console.warn("[WEBHOOK][GET] verification failed", {
      mode,
      tokenPresent: !!token,
      hasSettings: !!s
    });
    return res.sendStatus(403);
  });

  // Receive messages
  app.post("/webhook", async (req, res) => {
    try {
      console.log("[WEBHOOK][POST] hit", {
        ip: req.ip,
        ua: req.header("user-agent"),
        contentType: req.header("content-type"),
        rawBodyLen: (req.rawBody && req.rawBody.length) || 0,
        hasBody: !!req.body
      });
      const sig = req.header("X-Hub-Signature-256") || req.header("x-hub-signature-256");
      const prospective = (() => {
        try {
          const temp = JSON.parse((req.rawBody || Buffer.from("{}"))?.toString("utf8"));
          const pnid = temp?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
          return findSettingsByPhoneNumberId(pnid);
        } catch { return null; }
      })();
      const s = prospective || {};
      console.log("[WEBHOOK][POST] tenant lookup", { hasSig: !!sig, tenantFound: !!prospective });
      if (s.app_secret && sig) {
        const [algo, their] = sig.split("=");
        if (algo !== "sha256") return res.sendStatus(403);
        const hmac = crypto.createHmac("sha256", s.app_secret);
        const raw = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        hmac.update(raw);
        const ours = hmac.digest("hex");
        if (ours !== their) {
          req.log?.warn({ theirs, ours }, "Invalid webhook signature");
          console.warn("[WEBHOOK][POST] invalid signature", { hasSig: !!sig });
          return res.sendStatus(403);
        }
      }

      const payload = req.body;
      const entry = payload.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const statuses = change?.statuses;
      if (Array.isArray(statuses) && statuses.length > 0) {
        console.log("[WEBHOOK][POST] statuses received", { count: statuses.length });
        statuses.forEach((s) => {
          const status = s.status;
          const recipientId = s.recipient_id;
          const messageId = s.id || s.message_id;
          const timestamp = s.timestamp;
          const error = Array.isArray(s.errors) ? s.errors[0] : undefined;
          const insertStatus = db.prepare(
            `INSERT INTO message_statuses (message_id, status, recipient_id, timestamp, error_code, error_title, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          try {
            insertStatus.run(
              messageId || null,
              status || null,
              recipientId || null,
              timestamp ? Number(timestamp) : null,
              error?.code ?? null,
              error?.title ?? null,
              error?.message ?? null
            );
          } catch {}
        });
      }

      const message = change?.messages?.[0];
      if (!message) {
        console.log("[WEBHOOK][POST] no message present in change", { keys: Object.keys(change || {}) });
        return res.sendStatus(200);
      }

      const metadata = change?.metadata;
      const tenant = findSettingsByPhoneNumberId(metadata?.phone_number_id) || findSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, ""));
      const tenantUserId = tenant?.user_id || null;
      const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
      if (businessNumber && message.from === businessNumber) {
        console.log("[WEBHOOK][POST] ignoring message from business number (echo)");
        return res.sendStatus(200);
      }
      const cfg = tenant || {};

      // Define sender and text early so all branches (including interactive) can use them
      const from = message.from;
      const text = message.text?.body || "";

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
        } catch {
          isFirstTimeInbound = false;
        }
      }

      if (!isFirstTimeInbound) {
        console.log("[WEBHOOK][POST] duplicate inbound ignored", { inboundId });
        return res.sendStatus(200);
      }

      // Handle interactive replies (buttons/lists) BEFORE filtering to text
      if (message?.type === "interactive") {
        const data = message.interactive;
        if (data?.type === "button_reply") {
          const { id, title } = data.button_reply || {};
          console.log("[WEBHOOK][POST] interactive button_reply", { id, title });
          if (id === "BOOKING_START") {
            // Begin booking: show date picker (today + next 6 days)
            const staff = db.prepare(`SELECT id, slot_minutes FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
            if (!staff) {
              await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg);
              return res.sendStatus(200);
            }
            const base = new Date();
            const days = Array.from({ length: 7 }).map((_, i) => {
              const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
              const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
              return { id: `PICK_DAY_${iso}_${staff.id}`, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
            });
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
                const base = new Date();
                const days = Array.from({ length: 7 }).map((_, i) => {
                  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
                  const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
                  return { id: `RESCHED_PICK_DAY_${iso}_${row.staff_id}_${apptId}`, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
                });
                await sendWhatsappList(from, "Pick a new day", "Choose a date:", "Select", days, cfg);
              }
            }
            return res.sendStatus(200);
          } else if (id?.startsWith("KB_TITLE_")) {
            const wanted = id.replace("KB_TITLE_", "");
            const row = db.prepare(`SELECT content, file_url, file_mime, title FROM kb_items WHERE user_id = ? AND title = ?`).get(tenantUserId, wanted);
            if (row?.file_url) {
              const isPdf = /pdf/i.test(String(row.file_mime||'')) || /\.pdf(\?|#|$)/i.test(String(row.file_url||''));
              if (isPdf) {
                try { await sendWhatsappDocument(from, row.file_url, ((row.title||'document') + '.pdf'), cfg); return res.sendStatus(200); } catch {}
              }
            }
            await sendWhatsAppText(from, row?.content || "I couldn't find that info.", cfg);
          }
          return res.sendStatus(200);
        }
        if (data?.type === "list_reply") {
          const { id, title } = data.list_reply || {};
          console.log("[WEBHOOK][POST] interactive list_reply", { id, title });
          // Greeting list actions
          if (id === 'GREET_BOOK') {
            const staff = db.prepare(`SELECT id FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
            if (!staff) { await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg); return res.sendStatus(200); }
            const base = new Date();
            const days = Array.from({ length: 7 }).map((_, i) => {
              const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
              const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
              return { id: `PICK_DAY_${iso}_${staff.id}`, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
            });
            await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
            return res.sendStatus(200);
          }
          if (id?.startsWith('GREET_KB_TITLE_')) {
            const titleDec = decodeURIComponent(id.replace('GREET_KB_TITLE_', ''));
            const row = db.prepare(`SELECT content, file_url, file_mime, title FROM kb_items WHERE user_id = ? AND title = ?`).get(tenantUserId, titleDec);
            if (row?.file_url) {
              const isPdf = /pdf/i.test(String(row.file_mime||'')) || /\.pdf(\?|#|$)/i.test(String(row.file_url||''));
              if (isPdf) { try { await sendWhatsappDocument(from, row.file_url, ((row.title||'document') + '.pdf'), cfg); return res.sendStatus(200); } catch {} }
            }
            await sendWhatsAppText(from, row?.content || "I couldn't find that info.", cfg);
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
                const dateISO = new Date(`${dateStr}T00:00:00.000Z`).toISOString();
                const avail = await listAvailability({ userId: tenantUserId, staffId, dateISO, days: 1 });
                const slots = Array.isArray(avail) ? (avail[0]?.slots || []) : [];
                const upcoming = slots.filter(s => new Date(s.start).getTime() > Date.now()).slice(0, 10);
                if (!upcoming.length) {
                  await sendWhatsAppText(from, "No available times on that date. Please pick another day.", cfg);
                  return res.sendStatus(200);
                }
                const rows = upcoming.map(s => ({
                  id: `RESCHED_PICK_TIME_${apptId}_${staffId}_${s.start}_${s.end}`,
                  title: new Date(s.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
                  description: "Tap to confirm"
                }));
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
                const dateISO = new Date(`${dateStr}T00:00:00.000Z`).toISOString();
                const avail = await listAvailability({ userId: tenantUserId, staffId, dateISO, days: 1 });
                const slots = Array.isArray(avail) ? (avail[0]?.slots || []) : [];
                const upcoming = slots.filter(s => new Date(s.start).getTime() > Date.now()).slice(0, 10);
                if (!upcoming.length) {
                  await sendWhatsAppText(from, "No available times on that date. Please pick another day.", cfg);
                  return res.sendStatus(200);
                }
                const rows = upcoming.map(s => ({
                  id: `BOOK_SLOT_${s.start}_${s.end}_${staffId}`,
                  title: new Date(s.start).toLocaleString(),
                  description: "Tap to book"
                }));
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

      console.log("greet-debug", {
        type: message.type,
        from,
        pnid: metadata?.phone_number_id,
        display: metadata?.display_phone_number,
        tenantUserId,
        cfgOk: !!(cfg.phone_number_id && cfg.whatsapp_token)
      });

      if(isGreeting(text)) {
        console.log("[WEBHOOK][POST] greeting detected", { from });
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

        await sendWhatsAppText(from, cfg.entry_greeting || "Hello! How can I help you today?", cfg);
        // Only include this tenant's own KB items (no defaults)
        const rows = [];
        if (cfg?.bookings_enabled) rows.push({ id: 'GREET_BOOK', title: 'Book', description: '' });
        try {
          const titles = db.prepare(`
            SELECT title FROM kb_items
            WHERE user_id = ? AND title IS NOT NULL AND TRIM(title) <> ''
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
          await sendWhatsappList(from, 'You can tap one of these to begin:', 'Select an option to get started.', 'Select', rows, cfg);
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
          await sendWhatsAppText(from, `Booked: ${new Date(sess.start_iso).toLocaleString()}. Ref #${r.id}`, cfg);
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
          const base = new Date();
          const days = Array.from({ length: 7 }).map((_, i) => {
            const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
            const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
            return { id: `RESCHED_PICK_DAY_${iso}_${appt.staff_id}_${appt.id}`, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
          });
          await sendWhatsappList(from, "Pick a new day", "Choose a date:", "Select", days, cfg);
          return res.sendStatus(200);
        }
      }

      // Booking intent (gated by settings flag)
      const wantsBooking = /\b(book|booking|appointment|schedule)\b/i.test(text || "");
      if (cfg?.bookings_enabled && wantsBooking) {
        // Pick first staff for tenant
        const staff = db.prepare(`SELECT id, timezone, slot_minutes, working_hours_json FROM staff WHERE user_id = ? ORDER BY id LIMIT 1`).get(tenantUserId);
        if (!staff) {
          await sendWhatsAppText(from, "Bookings are enabled, but no staff is configured yet.", cfg);
          return res.sendStatus(200);
        }
        // Let user pick a day (today + next 6 days)
        const base = new Date();
        const days = Array.from({ length: 7 }).map((_, i) => {
          const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
          const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
          return { id: `PICK_DAY_${iso}_${staff.id}`, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
        });
        await sendWhatsappList(from, "Pick a day", "Choose a date:", "Select", days, cfg);
        return res.sendStatus(200);
      }

      const handoffState = db.prepare(`SELECT is_human FROM handoff WHERE contact_id = ? AND user_id = ?`).get(from, tenantUserId);
      if (handoffState?.is_human) return res.sendStatus(200);

      const aiOptions = {
        tone: tenant?.ai_tone,
        style: tenant?.ai_style,
        blockedTopics: tenant?.ai_blocked_topics
      }

      // Retrieve candidate KB matches
      const kbMatches = retrieveKbMatches(text, 3, tenantUserId, '');
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

      // High confidence → AI answer (fallback to top KB snippet)
      if (hasMatch && topScore >= 1) {
        const aiReply = await generateAiReply(text, kbMatches, aiOptions);
        const reply = (aiReply && aiReply.trim()) || kbMatches[0].content || "Sorry, I couldn’t find that.";
        const sendRespData = await sendWhatsAppText(from, reply, cfg);
        try {
          const outboundId = sendRespData?.messages?.[0]?.id;
          if (outboundId) {
            const insertOutbound = db.prepare(
              `INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
                  VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, strftime('%s','now'), ?)`
            );          
            insertOutbound.run(
              outboundId,
              tenantUserId,
              (cfg.business_phone || "").replace(/\D/g, "") || null,
              from || null,
              normalizePhone(cfg.business_phone) || null,
              normalizePhone(from) || null,
              reply || null,
              JSON.stringify({ to: from, reply })
            );
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
      if (suggestions.length > 0) {
        await sendWhatsappButton(
          from,
          "That seems outside my scope. Try choosing one of these topics:",
          suggestions,
          cfg
        );
      } else {
        await sendWhatsAppText(from, "I couldn’t find that. Try asking about Hours, Locations, or Payments.", cfg);
      }

      return res.sendStatus(200);
      
    } catch (e) {
      console.error("Webhook error:", e);
      return res.sendStatus(500);
    }
  });
}

