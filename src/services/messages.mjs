import { db, getDB } from "../db-mongodb.mjs";
import { normalizePhone } from "../utils.mjs";
import { Customer } from "../schemas/mongodb.mjs";

/**
 * Record an outbound message in the messages table (idempotent).
 * Mirrors existing inserts used across webhook routes.
 */
export async function recordOutboundMessage({
  messageId,
  userId,
  cfg,
  to,
  type,
  text,
  raw
}) {
  if (!messageId || !userId || !to) return false;
  try {
    // Opt-out and temporary block check
    try {
      const customer = await Customer.findOne({ user_id: String(userId), contact_id: String(to) }).lean();
      const now = Math.floor(Date.now()/1000);
      if (customer?.opted_out) return false;
      if (customer?.blocked_until_ts && customer.blocked_until_ts > now) return false;
    } catch {}
    const dbNative = getDB();
    const messages = dbNative.collection('messages');
    const fromBiz = (cfg?.business_phone || "").replace(/\D/g, "") || null;
    const doc = {
      id: String(messageId),
      user_id: String(userId),
      direction: 'outbound',
      from_id: fromBiz,
      to_id: String(to),
      from_digits: normalizePhone(fromBiz) || null,
      to_digits: normalizePhone(String(to)) || null,
      type: type || 'text',
      text_body: text || null,
      timestamp: Math.floor(Date.now() / 1000),
      raw: raw || null
    };
    const res = await messages.updateOne(
      { id: doc.id },
      { $setOnInsert: doc },
      { upsert: true }
    );
    return (res.upsertedCount || 0) > 0 || (res.matchedCount || 0) > 0;
  } catch (e) {
    return false;
  }
}

// Record an inbound message idempotently; returns true if newly inserted
export async function recordInboundMessage({
  messageId,
  userId,
  from,
  businessPhone,
  type,
  text,
  timestamp,
  raw
}) {
  if (!messageId || !userId) return false;
  try {
    const dbNative = getDB();
    const messages = dbNative.collection('messages');
    const fromDigits = normalizePhone(from) || null;
    const toDigits = normalizePhone(businessPhone) || null;
    const ts = typeof timestamp === 'number' ? Number(timestamp) : Math.floor(Date.now() / 1000);
    const doc = {
      id: String(messageId),
      user_id: String(userId),
      direction: 'inbound',
      from_id: from || null,
      to_id: businessPhone || null,
      from_digits: fromDigits,
      to_digits: toDigits,
      type: type || null,
      text_body: text || null,
      timestamp: ts,
      raw: raw || null
    };
    const res = await messages.updateOne(
      { id: doc.id },
      { $setOnInsert: doc },
      { upsert: true }
    );
    return (res.upsertedCount || 0) > 0;
  } catch (e) {
    return false;
  }
}


