

import { getDB } from '../db-mongodb.mjs';
export async function createReply(originalMessageId, replyMessageId) {
  try {
    const db = getDB();
    const coll = db.collection('message_replies');
    await coll.updateOne(
      { original_message_id: originalMessageId, reply_message_id: replyMessageId },
      { $setOnInsert: { original_message_id: originalMessageId, reply_message_id: replyMessageId, createdAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  } catch (error) {
    console.error('Error creating reply:', error);
    return { success: false, error: error.message };
  }
}
export async function getMessageReplies(messageId) {
  try {
    const db = getDB();
    const repliesColl = db.collection('message_replies');
    const messagesColl = db.collection('messages');
    const links = await repliesColl.find({ original_message_id: messageId }).sort({ createdAt: 1 }).toArray();
    if (!links.length) return [];
    const ids = links.map(l => l.reply_message_id);
    const msgs = await messagesColl.find({ id: { $in: ids } }).project({ direction: 1, type: 1, text_body: 1, timestamp: 1, raw: 1, id: 1 }).toArray();
    const map = new Map(msgs.map(m => [m.id, m]));
    return links.map(l => ({ reply_message_id: l.reply_message_id, created_at: l.createdAt, ...(map.get(l.reply_message_id) || {}) }));
  } catch (error) {
    console.error('Error getting message replies:', error);
    return [];
  }
}
export async function getOriginalMessage(replyMessageId) {
  try {
    const db = getDB();
    const repliesColl = db.collection('message_replies');
    const messagesColl = db.collection('messages');
    const link = await repliesColl.findOne({ reply_message_id: replyMessageId });
    if (!link) return null;
    const msg = await messagesColl.findOne({ id: link.original_message_id }, { projection: { direction: 1, type: 1, text_body: 1, timestamp: 1, raw: 1, id: 1 } });
    return { original_message_id: link.original_message_id, created_at: link.createdAt, ...(msg || {}) };
  } catch (error) {
    console.error('Error getting original message:', error);
    return null;
  }
}
export async function getMessagesReplies(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return {};
  try {
    const db = getDB();
    const repliesColl = db.collection('message_replies');
    const messagesColl = db.collection('messages');
    const links = await repliesColl.find({ original_message_id: { $in: messageIds } }).sort({ createdAt: 1 }).toArray();
    if (!links.length) return {};
    const replyIds = Array.from(new Set(links.map(l => l.reply_message_id)));
    const msgs = await messagesColl.find({ id: { $in: replyIds } }).project({ id: 1, direction: 1, type: 1, text_body: 1, timestamp: 1, raw: 1 }).toArray();
    const msgMap = new Map(msgs.map(m => [m.id, m]));
    const grouped = {};
    for (const l of links) {
      const arr = grouped[l.original_message_id] || (grouped[l.original_message_id] = []);
      arr.push({ reply_message_id: l.reply_message_id, created_at: l.createdAt, ...(msgMap.get(l.reply_message_id) || {}) });
    }
    return grouped;
  } catch (error) {
    console.error('Error getting messages replies:', error);
    return {};
  }
}
export async function getReplyOriginals(replyMessageIds) {
  if (!Array.isArray(replyMessageIds) || replyMessageIds.length === 0) return {};
  try {
    const db = getDB();
    const repliesColl = db.collection('message_replies');
    const messagesColl = db.collection('messages');
    const links = await repliesColl.find({ reply_message_id: { $in: replyMessageIds } }).toArray();
    if (!links.length) return {};
    const origIds = Array.from(new Set(links.map(l => l.original_message_id)));
    const origMsgs = await messagesColl.find({ id: { $in: origIds } }).project({ id: 1, direction: 1, type: 1, text_body: 1, timestamp: 1, raw: 1 }).toArray();
    const map = new Map(origMsgs.map(m => [m.id, m]));
    const grouped = {};
    for (const l of links) {
      grouped[l.reply_message_id] = { original_message_id: l.original_message_id, created_at: l.createdAt, ...(map.get(l.original_message_id) || {}) };
    }
    return grouped;
  } catch (error) {
    console.error('Error getting reply originals:', error);
    return {};
  }
}
