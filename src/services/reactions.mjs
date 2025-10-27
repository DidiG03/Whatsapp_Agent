/**
 * Message reactions service for handling emoji reactions to messages.
 */

import { getDB } from '../db-mongodb.mjs';

/**
 * Get all reactions for a specific message
 */
export async function getMessageReactions(messageId) {
  if (!messageId) return [];
  const db = getDB();
  const coll = db.collection('message_reactions');
  const pipeline = [
    { $match: { message_id: messageId } },
    { $group: { _id: { emoji: '$emoji', user_id: '$user_id' }, count: { $sum: 1 }, created_at: { $min: '$createdAt' } } },
    { $project: { emoji: '$_id.emoji', user_id: '$_id.user_id', count: 1, created_at: 1, _id: 0 } },
    { $sort: { created_at: 1 } }
  ];
  return await coll.aggregate(pipeline).toArray();
}

/**
 * Add a reaction to a message
 */
export async function addReaction(messageId, userId, emoji) {
  try {
    const db = getDB();
    const coll = db.collection('message_reactions');
    await coll.updateOne(
      { message_id: messageId, user_id, emoji },
      { $setOnInsert: { message_id: messageId, user_id, emoji, createdAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  } catch (error) {
    console.error('Error adding reaction:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(messageId, userId, emoji) {
  try {
    const db = getDB();
    const coll = db.collection('message_reactions');
    const result = await coll.deleteOne({ message_id: messageId, user_id: userId, emoji });
    return { success: true, deleted: result.deletedCount > 0 };
  } catch (error) {
    console.error('Error removing reaction:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Toggle a reaction (add if not exists, remove if exists)
 */
export async function toggleReaction(messageId, userId, emoji) {
  try {
    const db = getDB();
    const coll = db.collection('message_reactions');
    const existing = await coll.findOne({ message_id: messageId, user_id: userId, emoji });
    if (existing) {
      const result = await removeReaction(messageId, userId, emoji);
      return { ...result, added: false, removed: true };
    } else {
      const result = await addReaction(messageId, userId, emoji);
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
export async function getMessagesReactions(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return {};
  const db = getDB();
  const coll = db.collection('message_reactions');
  const reactions = await coll.aggregate([
    { $match: { message_id: { $in: messageIds } } },
    { $group: { _id: { message_id: '$message_id', emoji: '$emoji', user_id: '$user_id' }, count: { $sum: 1 }, created_at: { $min: '$createdAt' } } },
    { $project: { message_id: '$_id.message_id', emoji: '$_id.emoji', user_id: '$_id.user_id', count: 1, created_at: 1, _id: 0 } },
    { $sort: { created_at: 1 } }
  ]).toArray();

  const groupedReactions = {};
  for (const reaction of reactions) {
    if (!groupedReactions[reaction.message_id]) groupedReactions[reaction.message_id] = [];
    groupedReactions[reaction.message_id].push(reaction);
  }
  return groupedReactions;
}

/**
 * Get user's reactions for multiple messages (only agent reactions, not customer reactions)
 */
export async function getUserReactionsForMessages(messageIds, userId) {
  if (!Array.isArray(messageIds) || messageIds.length === 0 || !userId) return {};
  const db = getDB();
  const coll = db.collection('message_reactions');
  const cursor = await coll.find({ message_id: { $in: messageIds }, user_id: userId, user_id: { $not: /^customer_/ } }, { projection: { message_id: 1, emoji: 1 } });
  const list = await cursor.toArray();
  const grouped = {};
  for (const r of list) {
    if (!grouped[r.message_id]) grouped[r.message_id] = [];
    grouped[r.message_id].push(r.emoji);
  }
  return grouped;
}
