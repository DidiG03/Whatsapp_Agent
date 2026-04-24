import Ably from "ably";
import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { isUsageExceeded } from "../services/usage.mjs";
import { Handoff, Notification } from "../schemas/mongodb.mjs";

const ABLY_API_KEY = process.env.ABLY_API_KEY || "";
const ABLY_TOKEN_TTL_MS = Math.max(
  300000,
  Number(process.env.ABLY_TOKEN_TTL_MS || 3600000)
);

let ablyRest = null;

function getAblyClient() {
  if (!ABLY_API_KEY) return null;
  if (!ablyRest) {
    ablyRest = new Ably.Rest({ key: ABLY_API_KEY });
  }
  return ablyRest;
}

function isRealtimeEnabled() {
  return !!getAblyClient();
}

function sanitizePhone(phone) {
  return String(phone || "").replace(/[^0-9+]/g, "");
}

function chatChannel(userId, phone) {
  return `chat:${String(userId || "").trim()}:${sanitizePhone(phone)}`;
}

function userChannel(userId) {
  return `user:${String(userId || "").trim()}`;
}

function createTokenRequestCompat(ably, params) {
  if (!ably || !ably.auth || typeof ably.auth.createTokenRequest !== "function") {
    throw new Error("Ably client not initialized");
  }
  return new Promise((resolve, reject) => {
    try {
      ably.auth.createTokenRequest(params, (err, tokenRequest) => {
        if (err) {
          reject(err);
        } else {
          resolve(tokenRequest);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function publish(channel, eventName, payload) {
  const ably = getAblyClient();
  if (!ably) return;
  try {
    await ably.channels.get(channel).publish(eventName, payload);
  } catch (error) {
    console.error(
      "[Realtime][Ably] publish failed:",
      eventName,
      channel,
      error?.message || error
    );
  }
}

export async function broadcastNewMessage(userId, phone, messageData) {
  if (!userId || !phone) return;

  await publish(chatChannel(userId, phone), "new_message", messageData);
  await publish(userChannel(userId), "new_message", messageData);

  try {
    if (messageData && String(messageData.direction) === "inbound") {
      const title = `New message from ${phone}`;
      const preview = (messageData.text_body || "").toString().slice(0, 140);
      const link = `/inbox/${encodeURIComponent(phone)}`;
      const doc = await Notification.create({
        user_id: String(userId),
        type: "inbound_message",
        title,
        message: preview,
        link,
        is_read: false,
        metadata: { phone, message_id: messageData.id }
      });
      try {
        const unreadCount = await Notification.countDocuments({
          user_id: String(userId),
          is_read: false
        });
        await publish(userChannel(userId), "notification_created", {
          notification: doc.toObject ? doc.toObject() : doc,
          unreadCount
        });
      } catch {
        await publish(userChannel(userId), "notification_created", {
          notification: doc.toObject ? doc.toObject() : doc
        });
      }
    }
  } catch (error) {
    console.error("[Realtime] notification broadcast failed:", error);
  }

  try {
    if (messageData && messageData.direction === "inbound") {
      await publish(chatChannel(userId, phone), "conversation_status_changed", {
        userId,
        phone,
        status: "new",
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error("[Realtime] conversation status broadcast failed:", error);
  }
}

export async function broadcastReaction(
  userId,
  phone,
  messageId,
  emoji,
  action,
  reactionData
) {
  if (!userId || !phone) return;
  await publish(chatChannel(userId, phone), "message_reaction", {
    userId,
    phone,
    messageId,
    emoji,
    action,
    reaction: reactionData,
    timestamp: Date.now()
  });
}

export async function broadcastMessageStatus(
  userId,
  phone,
  messageId,
  status,
  statusData
) {
  if (!userId || !phone) return;
  await publish(chatChannel(userId, phone), "message_status_update", {
    userId,
    phone,
    messageId,
    status,
    statusData,
    timestamp: Date.now()
  });
}

export async function broadcastLiveModeChange(userId, phone, isLive) {
  if (!userId || !phone) return;
  const payload = {
    userId,
    phone,
    isLive: !!isLive,
    timestamp: Date.now()
  };
  await publish(chatChannel(userId, phone), "live_mode_changed", payload);
  await publish(userChannel(userId), "live_mode_changed", payload);
}

export async function broadcastMetricsUpdate(userId, metricsData) {
  if (!userId) return;
  await publish(userChannel(userId), "metrics_update", {
    userId,
    data: metricsData,
    timestamp: Date.now()
  });
}

export default function registerRealtimeRoutes(app) {
  app.get("/api/realtime/status", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const enabled = isRealtimeEnabled();
    res.json({
      userId,
      transport: enabled ? "ably" : "disabled",
      ablyAvailable: enabled
    });
  });

  app.get("/api/realtime/ably/token", ensureAuthed, async (req, res) => {
    if (!isRealtimeEnabled()) {
      return res.status(503).json({ error: "Realtime not configured" });
    }
    const userId = getCurrentUserId(req);
    const ably = getAblyClient();
    try {
      const capability = {};
      capability[userChannel(userId)] = ["subscribe", "presence"];
      capability[`chat:${String(userId)}:*`] = [
        "publish",
        "subscribe",
        "presence"
      ];
      const tokenRequest = await createTokenRequestCompat(ably, {
        clientId: `user:${userId}`,
        capability: JSON.stringify(capability),
        ttl: ABLY_TOKEN_TTL_MS
      });
      res.json(tokenRequest);
    } catch (error) {
      console.error("[Realtime][Ably] token request failed:", error);
      res.status(500).json({ error: "Failed to issue realtime token" });
    }
  });

  app.post("/api/realtime/live-mode", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, isLive } = req.body || {};

    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }

    try {
      const overLimit = await isUsageExceeded(userId);
      if (overLimit && isLive) {
        return res.status(403).json({ error: "You have exceeded your monthly message limit. Please upgrade your plan." });
      }

      await Handoff.findOneAndUpdate(
        { user_id: userId, contact_id: phone },
        { $set: { is_human: !!isLive, updatedAt: new Date() } },
        { upsert: true }
      );

      await broadcastLiveModeChange(userId, phone, !!isLive);

      res.json({
        success: true,
        message: `Live mode ${isLive ? "enabled" : "disabled"}`,
        phone,
        isLive: !!isLive
      });
    } catch (error) {
      console.error("Error toggling live mode:", error);
      res.status(500).json({ error: "Failed to toggle live mode" });
    }
  });

  app.get("/realtime", (req, res) => {
    const enabled = isRealtimeEnabled();
    res.json({
      message: "Realtime service ready",
      transport: enabled ? "ably" : "disabled",
      ablyAvailable: enabled,
      endpoints: [
        "GET /api/realtime/status",
        "GET /api/realtime/ably/token",
        "POST /api/realtime/live-mode"
      ]
    });
  });
}
