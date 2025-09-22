/**
 * Conversation listing helpers.
 * - listContactsForUser: latest contacts for Inbox
 * - listMessagesForThread: chronological messages for a contact thread
 */
import { db } from "../db.mjs";

/** List the latest 100 contacts with their most recent timestamp. */
export function listContactsForUser(userId) {
  return db.prepare(`
    SELECT contact, MAX(COALESCE(ts, 0)) AS last_ts FROM (
      SELECT from_id AS contact, timestamp AS ts
      FROM messages
      WHERE user_id = ?
        AND direction = 'inbound'
        AND from_id IS NOT NULL
      UNION ALL
      SELECT to_id AS contact, timestamp AS ts
      FROM messages
      WHERE user_id = ?
        AND direction = 'outbound'
        AND to_id IS NOT NULL
    )
    WHERE contact IS NOT NULL AND contact <> ''
    GROUP BY contact
    ORDER BY last_ts DESC
    LIMIT 100
  `).all(userId, userId);
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

