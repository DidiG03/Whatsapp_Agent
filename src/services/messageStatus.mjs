

import { getDB } from "../db-mongodb.mjs";
export const MESSAGE_STATUS = {
  SENT: 'sent',  DELIVERED: 'delivered',  READ: 'read',  FAILED: 'failed'};
export const READ_STATUS = {
  UNREAD: 'unread',
  READ: 'read'
};
export async function updateMessageDeliveryStatus(messageId, status, timestamp = null) {
  if (!Object.values(MESSAGE_STATUS).includes(status)) {
    throw new Error(`Invalid message status: ${status}`);
  }
  const rank = {
    [MESSAGE_STATUS.SENT]: 1,
    [MESSAGE_STATUS.DELIVERED]: 2,
    [MESSAGE_STATUS.READ]: 3,
    [MESSAGE_STATUS.FAILED]: 99
  };

  const db = getDB();
  const now = timestamp || Math.floor(Date.now() / 1000);
  if (status === MESSAGE_STATUS.FAILED) {
    const resFailed = await db.collection('messages').updateOne(
      { id: messageId },
      { $set: { delivery_status: MESSAGE_STATUS.FAILED, delivery_timestamp: now } }
    );
    if (resFailed.modifiedCount > 0) {
      console.log(`📤 Message ${messageId} delivery status updated to: ${MESSAGE_STATUS.FAILED}`);
      return true;
    }
    return false;
  }
  const res = await db.collection('messages').updateOne(
    { id: messageId, $or: [ { delivery_status: { $exists: false } }, { delivery_status: null }, { delivery_status: { $in: [MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED] } } ] },
    [
      {
        $set: {
          delivery_status: {
            $cond: [
              { $or: [
                { $eq: ['$delivery_status', null] },
                { $lt: [ { $ifNull: [ { $getField: { field: '$delivery_status', input: { sent: 1, delivered: 2, read: 3 } } }, 0 ] }, rank[status] ] }
              ] },
              status,
              '$delivery_status'
            ]
          },
          delivery_timestamp: now,
          read_status: { $ifNull: ['$read_status', 'unread'] }
        }
      }
    ]
  );
  if (res.modifiedCount > 0) {
    console.log(`📤 Message ${messageId} delivery status updated to: ${status}`);
    return true;
  }
  
  return false;
}
export async function updateMessageReadStatus(messageId, status, timestamp = null) {
  if (!Object.values(READ_STATUS).includes(status)) {
    throw new Error(`Invalid read status: ${status}`);
  }

  const db = getDB();
  const res = await db.collection('messages').updateOne(
    { id: messageId },
    { $set: { read_status: status, read_timestamp: timestamp || Math.floor(Date.now() / 1000), delivery_status: MESSAGE_STATUS.READ, delivery_timestamp: timestamp || Math.floor(Date.now() / 1000) } }
  );
  if (res.modifiedCount > 0) {
    console.log(`👁️ Message ${messageId} read status updated to: ${status}`);
    return true;
  }
  
  return false;
}
export async function getMessageStatus(messageId) {
  const db = getDB();
  return await db.collection('messages').findOne(
    { id: messageId },
    { projection: { _id: 0, delivery_status: 1, read_status: 1, delivery_timestamp: 1, read_timestamp: 1 } }
  );
}
export async function markConversationAsRead(userId, contactId) {
  const db = getDB();
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await db.collection('messages').updateMany(
    { user_id: userId, direction: 'inbound', $or: [ { from_digits: contactId }, { from_id: contactId } ], read_status: { $ne: 'read' } },
    { $set: { read_status: 'read', read_timestamp: timestamp } }
  );
  console.log(`👁️ Marked ${result.modifiedCount || 0} messages as read for conversation: ${contactId}`);
  return result.modifiedCount || 0;
}
export async function markMessageAsFailed(messageId, errorMessage = null) {
  const db = getDB();
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await db.collection('messages').updateOne(
    { id: messageId },
    { $set: { delivery_status: MESSAGE_STATUS.FAILED, delivery_timestamp: timestamp, error_message: errorMessage } }
  );
  if (res.modifiedCount > 0) {
    console.log(`❌ Message ${messageId} marked as failed: ${errorMessage || 'Unknown error'}`);
    return true;
  }
  
  return false;
}
export async function retryFailedMessage(messageId) {
  const db = getDB();
  const message = await db.collection('messages').findOne({ id: messageId, delivery_status: MESSAGE_STATUS.FAILED }, { projection: { id: 1, user_id: 1, text_body: 1, to_digits: 1, from_digits: 1, raw: 1 } });
  
  if (!message) {
    return { success: false, error: 'Message not found or not in failed state' };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  await db.collection('messages').updateOne({ id: messageId }, { $set: { delivery_status: MESSAGE_STATUS.SENT, delivery_timestamp: timestamp, error_message: null } });
  
  console.log(`🔄 Retrying failed message ${messageId}`);
  
  return {
    success: true,
    message: {
      id: message.id,
      userId: message.user_id,
      text: message.text_body,
      to: message.to_digits,
      from: message.from_digits,
      raw: message.raw
    }
  };
}
export async function simulateDeliveryStatusUpdate(messageId, status) {
  const timestamp = Math.floor(Date.now() / 1000);
  
  switch (status) {
    case 'delivered':
      await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.DELIVERED, timestamp);
      break;
    case 'read':
      await updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.READ, timestamp);
      await updateMessageReadStatus(messageId, READ_STATUS.READ, timestamp);
      break;
    case 'failed':
      await markMessageAsFailed(messageId, 'Simulated failure');
      break;
    default:
      console.warn(`Unknown delivery status: ${status}`);
  }
}
