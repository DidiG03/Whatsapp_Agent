import { getDB } from "../db-mongodb.mjs";
import { normalizePhone } from "../utils.mjs";

const pending = new Map();

function coalesceKey(tenantUserId, contactId) {
  const digits = normalizePhone(contactId) || String(contactId || "");
  return `${String(tenantUserId || "")}:${digits}`;
}

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** True when the message looks like part of a longer thought (single word, very short). */
export function isLikelyMessageFragment(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  const sq = stripAccentsLower(t);

  // Mid-sentence cut-offs: "dua te bej nje", "want to make a"
  if (/\b(nje|te|a|an|to)\s*$/i.test(sq)) return true;
  if (/\b(dua|deshir|bej|make|want|would like)\b/i.test(sq) && words.length <= 6) return true;

  if (words.length >= 6 && t.length > 48) return false;
  if (words.length >= 4 && t.length > 42) return false;
  if (words.length >= 3 && t.length > 28) return false;
  return true;
}

export function coalesceDelayMs(text) {
  if (String(process.env.INBOUND_COALESCE || "1") === "0") return 0;
  const fast = Number(process.env.INBOUND_COALESCE_FAST_MS || 600);
  const slow = Number(process.env.INBOUND_COALESCE_MS || 2500);
  if (!isLikelyMessageFragment(text)) return fast;
  return slow;
}

export function shouldUseInboundCoalescer({ text, messageType, humanActive, awaitingRating } = {}) {
  if (String(process.env.INBOUND_COALESCE || "1") === "0") return false;
  if (process.env.NODE_ENV === "test") return false;
  if (humanActive || awaitingRating) return false;
  if (messageType === "interactive" || messageType === "audio") return false;
  return !!String(text || "").trim();
}

/**
 * Load inbound texts sent since the last bot reply (or within a short burst window),
 * joined into one line — e.g. "doja" + "nje" + "rezervim" + "per neser".
 */
export async function loadInboundBurstText(tenantUserId, contactId, {
  burstWindowSec = Number(process.env.INBOUND_COALESCE_BURST_SEC || 30),
  maxParts = 12,
} = {}) {
  if (!tenantUserId || !contactId) return "";
  const digits = normalizePhone(contactId) || String(contactId);
  const nowSec = Math.floor(Date.now() / 1000);
  const db = getDB();

  let sinceTs = nowSec - Math.max(5, burstWindowSec);
  try {
    const lastOut = await db.collection("messages").findOne(
      {
        user_id: String(tenantUserId),
        direction: "outbound",
        $or: [{ to_digits: digits }, { to_id: contactId }],
      },
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } }
    );
    if (lastOut?.timestamp != null) {
      sinceTs = Math.max(sinceTs, Number(lastOut.timestamp) + 1);
    }
  } catch {}

  const contactOr = [{ from_digits: digits }];
  if (contactId) contactOr.push({ from_id: contactId });

  let rows = [];
  try {
    rows = await db.collection("messages")
      .find({
        user_id: String(tenantUserId),
        direction: "inbound",
        type: "text",
        timestamp: { $gte: sinceTs },
        $or: contactOr,
      })
      .sort({ timestamp: 1 })
      .limit(maxParts)
      .project({ text_body: 1 })
      .toArray();
  } catch {
    return "";
  }

  const parts = rows.map((r) => String(r.text_body || "").trim()).filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Debounce rapid multi-message bursts: reset a timer on each inbound; when the
 * customer pauses, run `onReady` once with merged text from the DB.
 */
export function scheduleInboundCoalesce(tenantUserId, contactId, { delayMs, onReady }) {
  const key = coalesceKey(tenantUserId, contactId);
  let entry = pending.get(key);
  if (!entry) {
    entry = { timer: null, onReady };
    pending.set(key, entry);
  } else {
    entry.onReady = onReady;
  }

  clearTimeout(entry.timer);
  const waitMs = Math.max(0, Number(delayMs) || 0);

  entry.timer = setTimeout(async () => {
    pending.delete(key);
    try {
      await onReady();
    } catch (e) {
      console.error("[InboundCoalescer] onReady failed:", e?.message || e);
    }
  }, waitMs);

  if (typeof entry.timer?.unref === "function") entry.timer.unref();
}

export function resetInboundCoalescerForTests() {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
  }
  pending.clear();
}

export default {
  isLikelyMessageFragment,
  coalesceDelayMs,
  shouldUseInboundCoalescer,
  loadInboundBurstText,
  scheduleInboundCoalesce,
  resetInboundCoalescerForTests,
};
