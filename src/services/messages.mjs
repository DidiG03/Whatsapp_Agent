import { db, getDB } from "../db-mongodb.mjs";
import { normalizePhone } from "../utils.mjs";
import { canonicalContactId } from "./handoff.mjs";
import { Customer } from "../schemas/mongodb.mjs";
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
  const contactId = canonicalContactId(to);
  try {
    try {
      const customer = await Customer.findOne({ user_id: String(userId), contact_id: contactId }).lean();
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
      to_id: contactId,
      from_digits: normalizePhone(fromBiz) || null,
      to_digits: normalizePhone(contactId) || null,
      type: type || 'text',
      text_body: text || null,
      timestamp: Math.floor(Date.now() / 1000),
      raw: raw || null,
      delivery_status: 'sent',
      read_status: 'unread'
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
    const body = text ? String(text).trim() : (doc.text_body || null);
    const insertDoc = { ...doc, text_body: body };
    const res = await messages.updateOne(
      { id: doc.id },
      { $setOnInsert: insertDoc },
      { upsert: true }
    );
    const isNewMessage = (res.upsertedCount || 0) > 0;
    // Backfill late-arriving text (e.g. audio transcription) onto an existing row.
    if (body && !isNewMessage) {
      await messages.updateOne(
        { id: doc.id },
        { $set: { text_body: body } }
      );
    }
    // Return true ONLY for genuinely new messages. Meta retries webhook
    // deliveries, so callers rely on this to avoid replying twice and
    // double-counting usage for the same message id.
    return isNewMessage;
  } catch (e) {
    console.error('[recordInboundMessage] failed:', e?.message || e, { messageId, userId });
    return false;
  }
}

export async function persistInboundTranscript(messageId, text) {
  const body = String(text || "").trim();
  if (!messageId || !body) return false;
  try {
    const res = await getDB().collection("messages").updateOne(
      { id: String(messageId) },
      { $set: { text_body: body } }
    );
    return (res.modifiedCount || 0) > 0 || (res.matchedCount || 0) > 0;
  } catch {
    return false;
  }
}

