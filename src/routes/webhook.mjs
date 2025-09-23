/**
 * Webhook routes for Meta (WhatsApp) integration.
 * - GET /webhook: verification handshake
 * - POST /webhook: inbound messages and status updates
 */
import crypto from "node:crypto";
import { db } from "../db.mjs";
import { findSettingsByVerifyToken, findSettingsByPhoneNumberId, findSettingsByBusinessPhone } from "../services/settings.mjs";
import { retrieveKbMatches, buildKbSuggestions } from "../services/kb.mjs";
import { sendWhatsappButton, sendWhatsAppText } from "../services/whatsapp.mjs";
import { normalizePhone } from "../utils.mjs";
import { generateAiReply } from "../services/ai.mjs";

function isGreeting(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;

  if (/^(hi|hello|hey|yo|hiya|howdy|greetings)\b/.test(s)) return true;
  if (/^good\s+(morning|afternoon|evening)\b/.test(s)) return true;

  if(["hi", "hello", "hey", "yo", "hiya", "howdy", "greetings", "good morning", "good afternoon", "good evening"].includes(s)) return true;
  return false;
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
          if (id === "YES_GRAPH") {
            await sendWhatsAppText(from, "Great — sending the report graph now.", cfg);
          } else if (id === "NO_GRAPH") {
            await sendWhatsAppText(from, "Okay. If you need it later, just ask.", cfg);
          } else if (id?.startsWith("KB_TITLE_")) {
            const wanted = id.replace("KB_TITLE_", "");
            const row = db.prepare(`SELECT content FROM kb_items WHERE user_id = ? AND title = ?`).get(tenantUserId, wanted);
            await sendWhatsAppText(from, row?.content || "I couldn't find that info.", cfg);
          }
          return res.sendStatus(200);
        }
        if (data?.type === "list_reply") {
          const { id, title } = data.list_reply || {};
          console.log("[WEBHOOK][POST] interactive list_reply", { id, title });
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
        await sendWhatsAppText(from, cfg.entry_greeting || "Hello! How can I help you today?", cfg);
        const suggestions = buildKbSuggestions(tenantUserId, "hello", 3);
        if (suggestions.length) {
          await sendWhatsappButton(from, "You can tap one of these to begin:", suggestions, cfg);
        }
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

