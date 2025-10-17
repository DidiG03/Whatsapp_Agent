/**
 * Message replies service for handling thread-style conversations.
 */

import { db } from '../db.mjs';

/**
 * Create a reply relationship between two messages
 */
export function createReply(originalMessageId, replyMessageId) {
  try {
    const result = db.prepare(`
      INSERT INTO message_replies (original_message_id, reply_message_id)
      VALUES (?, ?)
      ON CONFLICT(original_message_id, reply_message_id) DO NOTHING
    `).run(originalMessageId, replyMessageId);
    
    return { success: true, id: result.lastInsertRowid };
  } catch (error) {
    console.error('Error creating reply:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all replies for a specific message
 */
export function getMessageReplies(messageId) {
  try {
    const replies = db.prepare(`
      SELECT mr.reply_message_id, mr.created_at,
             m.direction, m.type, m.text_body, m.timestamp, m.raw
      FROM message_replies mr
      JOIN messages m ON mr.reply_message_id = m.id
      WHERE mr.original_message_id = ?
      ORDER BY mr.created_at ASC
    `).all(messageId);
    
    return replies;
  } catch (error) {
    console.error('Error getting message replies:', error);
    return [];
  }
}

/**
 * Get the original message that a reply is responding to
 */
export function getOriginalMessage(replyMessageId) {
  try {
    const original = db.prepare(`
      SELECT mr.original_message_id, mr.created_at,
             m.direction, m.type, m.text_body, m.timestamp, m.raw
      FROM message_replies mr
      JOIN messages m ON mr.original_message_id = m.id
      WHERE mr.reply_message_id = ?
    `).get(replyMessageId);
    
    return original;
  } catch (error) {
    console.error('Error getting original message:', error);
    return null;
  }
}

/**
 * Get replies for multiple messages
 */
export function getMessagesReplies(messageIds) {
  if (!messageIds.length) return {};
  
  try {
    const placeholders = messageIds.map(() => '?').join(',');
    const replies = db.prepare(`
      SELECT mr.original_message_id, mr.reply_message_id, mr.created_at,
             m.direction, m.type, m.text_body, m.timestamp, m.raw
      FROM message_replies mr
      JOIN messages m ON mr.reply_message_id = m.id
      WHERE mr.original_message_id IN (${placeholders})
      ORDER BY mr.created_at ASC
    `).all(...messageIds);
    
    // Group replies by original message ID
    const groupedReplies = {};
    replies.forEach(reply => {
      if (!groupedReplies[reply.original_message_id]) {
        groupedReplies[reply.original_message_id] = [];
      }
      groupedReplies[reply.original_message_id].push(reply);
    });
    
    return groupedReplies;
  } catch (error) {
    console.error('Error getting messages replies:', error);
    return {};
  }
}

/**
 * Get original messages for multiple reply messages
 */
export function getReplyOriginals(replyMessageIds) {
  if (!replyMessageIds.length) return {};
  
  try {
    const placeholders = replyMessageIds.map(() => '?').join(',');
    const originals = db.prepare(`
      SELECT mr.reply_message_id, mr.original_message_id, mr.created_at,
             m.direction, m.type, m.text_body, m.timestamp, m.raw
      FROM message_replies mr
      JOIN messages m ON mr.original_message_id = m.id
      WHERE mr.reply_message_id IN (${placeholders})
    `).all(...replyMessageIds);
    
    // Group by reply message ID
    const groupedOriginals = {};
    originals.forEach(original => {
      groupedOriginals[original.reply_message_id] = original;
    });
    
    return groupedOriginals;
  } catch (error) {
    console.error('Error getting reply originals:', error);
    return {};
  }
}
