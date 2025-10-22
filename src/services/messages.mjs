import { db } from "../db-mongodb.mjs";
import { normalizePhone } from "../utils.mjs";

/**
 * Record an outbound message in the messages table (idempotent).
 * Mirrors existing inserts used across webhook routes.
 */
export function recordOutboundMessage({
  messageId,
  userId,
  cfg,
  to,
  type,
  text,
  raw
}) {
  if (!messageId || !userId || !to) return false;
  const fromBiz = (cfg?.business_phone || "").replace(/\D/g, "") || null;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
    VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?)
  `);
  try {
    stmt.run(
      messageId,
      userId,
      fromBiz,
      to,
      normalizePhone(fromBiz),
      normalizePhone(to),
      type || 'text',
      text || null,
      raw ? JSON.stringify(raw) : null
    );
    return true;
  } catch {
    return false;
  }
}


