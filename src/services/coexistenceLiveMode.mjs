import { getDB } from "../db-mongodb.mjs";
import { normalizePhone } from "../utils.mjs";
import { upsertHandoffForContact } from "./handoff.mjs";
import { updateConversationStatus, CONVERSATION_STATUSES } from "./conversationStatus.mjs";
import { recordOutboundMessage } from "./messages.mjs";
import { createReply, getReplyOriginalMeta } from "./replies.mjs";
import { broadcastNewMessage } from "../routes/realtime.mjs";

export function isCoexistenceAutoLiveEnabled() {
  const v = String(process.env.COEXISTENCE_AUTO_LIVE_MODE ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function staffLiveModeDurationSec() {
  const mins = Number(process.env.COEXISTENCE_STAFF_LIVE_MINUTES || 30);
  return Math.max(5, Math.min(240, Math.floor(mins))) * 60;
}

export function extractMessageEchoes(change = {}) {
  const buckets = ["message_echoes", "smb_message_echoes"];
  const out = [];
  for (const source of buckets) {
    const raw = change?.[source];
    const arr = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === "object" ? Object.values(raw) : []);
    for (const echo of arr) {
      if (echo && typeof echo === "object") {
        out.push({ echo, source });
      }
    }
  }
  return out;
}

export async function isKnownApiOutboundMessage(userId, messageId) {
  if (!userId || !messageId) return false;
  try {
    const doc = await getDB().collection("messages").findOne(
      {
        id: String(messageId),
        user_id: String(userId),
        direction: "outbound",
      },
      { projection: { _id: 1 } }
    );
    return !!doc;
  } catch {
    return false;
  }
}

function echoCustomerPhone(echo = {}) {
  const to = String(echo.to || echo.recipient_id || "").trim();
  return normalizePhone(to) || to.replace(/\D/g, "") || null;
}

function shouldAutoLiveForEcho({ echo, source }) {
  if (source === "smb_message_echoes") return true;
  return source === "message_echoes";
}

function echoMessageText(echo = {}) {
  const type = String(echo.type || "text");
  if (type === "text") return echo.text?.body || null;
  if (type === "image") return echo.image?.caption || "📷 Image";
  if (type === "document") return echo.document?.caption || echo.document?.filename || "📄 Document";
  if (type === "audio") return "🎵 Audio";
  if (type === "video") return echo.video?.caption || "🎬 Video";
  return `[${type}]`;
}

export async function recordAndBroadcastStaffEcho({ userId, echo, cfg, metadata }) {
  const messageId = String(echo?.id || "").trim();
  if (!userId || !messageId) return { recorded: false, reason: "missing_data" };

  if (await isKnownApiOutboundMessage(userId, messageId)) {
    return { recorded: false, reason: "api_outbound" };
  }

  const customerPhone = echoCustomerPhone(echo);
  if (!customerPhone) return { recorded: false, reason: "no_customer" };

  const type = String(echo.type || "text");
  const text = echoMessageText(echo);
  const settings = cfg || {
    business_phone: metadata?.display_phone_number?.replace(/\D/g, "") || null,
    user_id: userId
  };

  const recorded = await recordOutboundMessage({
    messageId,
    userId,
    cfg: { ...settings, user_id: userId },
    to: customerPhone,
    type,
    text,
    raw: echo
  });
  if (!recorded) return { recorded: false, reason: "duplicate" };

  const replyToId = echo.context?.message_id;
  let replyOriginal = null;
  if (replyToId) {
    try {
      await createReply(replyToId, messageId);
      replyOriginal = await getReplyOriginalMeta(userId, replyToId);
    } catch {}
  }

  const timestamp = echo.timestamp ? Number(echo.timestamp) : Math.floor(Date.now() / 1000);
  let imageUrl = null;
  if (type === "image" && echo.image) {
    imageUrl = echo.image.link || null;
    if (!imageUrl && echo.image.id) {
      imageUrl = `/wa-media/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(echo.image.id))}`;
    }
  }
  try {
    await broadcastNewMessage(userId, customerPhone, {
      id: messageId,
      direction: "outbound",
      type,
      text_body: text,
      timestamp,
      to_digits: customerPhone,
      contact: customerPhone,
      delivery_status: "sent",
      ...(imageUrl ? { imageUrl, media_url: imageUrl } : {}),
      ...(replyOriginal ? { replyOriginal } : {})
    });
  } catch {}

  return { recorded: true, customerPhone, messageId };
}

export async function activateStaffLiveModeFromEcho({
  userId,
  echo,
  source,
  webhookField = null,
}) {
  if (!isCoexistenceAutoLiveEnabled()) {
    return { activated: false, reason: "disabled" };
  }
  if (!userId || !echo) {
    return { activated: false, reason: "missing_data" };
  }
  if (String(echo.group_id || "").trim()) {
    return { activated: false, reason: "group_echo" };
  }

  const customerPhone = echoCustomerPhone(echo);
  if (!customerPhone) {
    return { activated: false, reason: "no_customer" };
  }

  const messageId = String(echo.id || "").trim();
  if (messageId && await isKnownApiOutboundMessage(userId, messageId)) {
    return { activated: false, reason: "api_outbound" };
  }

  if (!shouldAutoLiveForEcho({ echo, source })) {
    return { activated: false, reason: "unsupported_source" };
  }

  const now = Math.floor(Date.now() / 1000);
  const durationSec = staffLiveModeDurationSec();
  const expires = now + durationSec;

  await upsertHandoffForContact(userId, customerPhone, {
    is_human: true,
    human_expires_ts: expires,
  });

  try {
    await updateConversationStatus(
      userId,
      customerPhone,
      CONVERSATION_STATUSES.IN_PROGRESS,
      "staff_whatsapp_reply"
    );
  } catch {}

  return {
    activated: true,
    customerPhone,
    expires,
    source,
    messageId: messageId || null,
  };
}

export async function handleCoexistenceMessageEchoes({
  tenantUserId,
  change,
  webhookField = null,
  cfg = null,
  metadata = null,
}) {
  if (!tenantUserId || !change) return { handled: 0, results: [] };

  const echoes = extractMessageEchoes(change);
  if (!echoes.length) return { handled: 0, results: [] };

  const results = [];
  for (const { echo, source } of echoes) {
    try {
      try {
        await recordAndBroadcastStaffEcho({
          userId: tenantUserId,
          echo,
          cfg,
          metadata,
        });
      } catch (e) {
        console.error("[Coexistence] Echo record/broadcast failed:", e?.message || e);
      }
      const result = await activateStaffLiveModeFromEcho({
        userId: tenantUserId,
        echo,
        source,
        webhookField,
      });
      results.push(result);
    } catch (e) {
      results.push({
        activated: false,
        reason: "error",
        error: e?.message || String(e),
        source,
      });
    }
  }

  const activated = results.filter((r) => r.activated).length;
  if (activated > 0 && process.env.DEBUG_LOGS === "1") {
    console.log("[Coexistence] Auto Live mode activated from staff echo:", {
      tenantUserId,
      activated,
      results,
    });
  }

  return { handled: echoes.length, results };
}
