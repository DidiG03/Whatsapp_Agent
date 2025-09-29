/**
 * Conversation listing helpers.
 * - listContactsForUser: latest contacts for Inbox
 * - listMessagesForThread: chronological messages for a contact thread
 */
import { db } from "../db.mjs";

/** List the latest 100 contacts with last timestamp and last text preview. */
export function listContactsForUser(userId) {
  return db.prepare(`
    WITH contacts AS (
      SELECT from_id AS contact, timestamp AS ts
      FROM messages
      WHERE user_id = ? AND direction = 'inbound' AND from_id IS NOT NULL
      UNION ALL
      SELECT to_id   AS contact, timestamp AS ts
      FROM messages
      WHERE user_id = ? AND direction = 'outbound' AND to_id IS NOT NULL
    ),
    latest AS (
      SELECT contact, MAX(COALESCE(ts,0)) AS last_ts
      FROM contacts
      WHERE contact IS NOT NULL AND contact <> ''
      GROUP BY contact
    )
    SELECT l.contact,
           l.last_ts,
           (
             SELECT m.text_body FROM messages m
             WHERE m.user_id = ?
               AND (
                (m.direction = 'inbound'  AND m.from_id = l.contact) OR
                (m.direction = 'outbound' AND m.to_id   = l.contact)
               )
             ORDER BY COALESCE(m.timestamp,0) DESC
             LIMIT 1
           ) AS last_text
    FROM latest l
    LEFT JOIN handoff h ON h.contact_id = l.contact AND (h.user_id = ? OR h.user_id IS NULL)
    WHERE COALESCE(h.is_archived,0) = 0 AND COALESCE(h.deleted_at,0) = 0
    ORDER BY l.last_ts DESC
    LIMIT 100
  `).all(userId, userId, userId, userId);
}

/** List messages for a user+phoneDigits thread ordered by timestamp ASC. */
export function listMessagesForThread(userId, phoneDigits) {
  return db.prepare(`
    SELECT direction, text_body, COALESCE(timestamp, 0) AS ts
    FROM messages
    WHERE user_id = ?
      AND (
        ((from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) AND direction = 'inbound') OR
        ((to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?)) AND direction = 'outbound')
      )
    ORDER BY ts ASC
  `).all(userId, phoneDigits, phoneDigits, phoneDigits, phoneDigits);
}

