/**
 * Message reactions service for handling emoji reactions to messages.
 */

import { db } from '../db-mongodb.mjs';

/**
 * Get all reactions for a specific message
 */
export function getMessageReactions(messageId) {
  const reactions = db.prepare(`
    SELECT emoji, user_id, created_at, COUNT(*) as count
    FROM message_reactions 
    WHERE message_id = ?
    GROUP BY emoji
    ORDER BY created_at ASC
  `).all(messageId);
  
  return reactions;
}

/**
 * Add a reaction to a message
 */
export function addReaction(messageId, userId, emoji) {
  try {
    const result = db.prepare(`
      INSERT INTO message_reactions (message_id, user_id, emoji)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id, emoji) DO NOTHING
    `).run(messageId, userId, emoji);
    
    return { success: true, id: result.lastInsertRowid };
  } catch (error) {
    console.error('Error adding reaction:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove a reaction from a message
 */
export function removeReaction(messageId, userId, emoji) {
  try {
    const result = db.prepare(`
      DELETE FROM message_reactions 
      WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).run(messageId, userId, emoji);
    
    return { success: true, deleted: result.changes > 0 };
  } catch (error) {
    console.error('Error removing reaction:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Toggle a reaction (add if not exists, remove if exists)
 */
export function toggleReaction(messageId, userId, emoji) {
  try {
    // Check if reaction exists
    const existing = db.prepare(`
      SELECT id FROM message_reactions 
      WHERE message_id = ? AND user_id = ? AND emoji = ?
    `).get(messageId, userId, emoji);
    
    if (existing) {
      const result = removeReaction(messageId, userId, emoji);
      return { ...result, added: false, removed: true };
    } else {
      const result = addReaction(messageId, userId, emoji);
      return { ...result, added: true, removed: false };
    }
  } catch (error) {
    console.error('Error toggling reaction:', error);
    return { success: false, error: error.message, added: false, removed: false };
  }
}

/**
 * Get reactions for multiple messages
 */
export function getMessagesReactions(messageIds) {
  if (!messageIds.length) return {};
  
  const placeholders = messageIds.map(() => '?').join(',');
  const reactions = db.prepare(`
    SELECT message_id, emoji, user_id, created_at, COUNT(*) as count
    FROM message_reactions 
    WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji
    ORDER BY created_at ASC
  `).all(...messageIds);
  
  // Group reactions by message_id
  const groupedReactions = {};
  reactions.forEach(reaction => {
    if (!groupedReactions[reaction.message_id]) {
      groupedReactions[reaction.message_id] = [];
    }
    groupedReactions[reaction.message_id].push(reaction);
  });
  
  return groupedReactions;
}

/**
 * Get user's reactions for multiple messages (only agent reactions, not customer reactions)
 */
export function getUserReactionsForMessages(messageIds, userId) {
  if (!messageIds.length) return {};
  
  const placeholders = messageIds.map(() => '?').join(',');
  const userReactions = db.prepare(`
    SELECT message_id, emoji
    FROM message_reactions 
    WHERE message_id IN (${placeholders}) AND user_id = ? AND user_id NOT LIKE 'customer_%'
  `).all(...messageIds, userId);
  
  // Group by message_id
  const groupedUserReactions = {};
  userReactions.forEach(reaction => {
    if (!groupedUserReactions[reaction.message_id]) {
      groupedUserReactions[reaction.message_id] = [];
    }
    groupedUserReactions[reaction.message_id].push(reaction.emoji);
  });
  
  return groupedUserReactions;
}
