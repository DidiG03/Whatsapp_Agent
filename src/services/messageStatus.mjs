/**
 * Message Status Management Service
 * Handles WhatsApp-style message delivery and read status tracking
 */

import { db } from "../db-serverless.mjs";

// Message status constants
export const MESSAGE_STATUS = {
  SENT: 'sent',           // 1 tick (gray)
  DELIVERED: 'delivered', // 2 ticks (gray) 
  READ: 'read',           // 2 ticks (blue)
  FAILED: 'failed'        // 1 red exclamation mark
};

// Read status constants
export const READ_STATUS = {
  UNREAD: 'unread',
  READ: 'read'
};

/**
 * Update message delivery status
 */
export function updateMessageDeliveryStatus(messageId, status, timestamp = null) {
  if (!Object.values(MESSAGE_STATUS).includes(status)) {
    throw new Error(`Invalid message status: ${status}`);
  }

  const stmt = db.prepare(`
    UPDATE messages 
    SET delivery_status = ?, delivery_timestamp = ?
    WHERE id = ?
  `);
  
  const result = stmt.run(status, timestamp || Math.floor(Date.now() / 1000), messageId);
  
  if (result.changes > 0) {
    console.log(`📤 Message ${messageId} delivery status updated to: ${status}`);
    return true;
  }
  
  return false;
}

/**
 * Update message read status
 */
export function updateMessageReadStatus(messageId, status, timestamp = null) {
  if (!Object.values(READ_STATUS).includes(status)) {
    throw new Error(`Invalid read status: ${status}`);
  }

  const stmt = db.prepare(`
    UPDATE messages 
    SET read_status = ?, read_timestamp = ?
    WHERE id = ?
  `);
  
  const result = stmt.run(status, timestamp || Math.floor(Date.now() / 1000), messageId);
  
  if (result.changes > 0) {
    console.log(`👁️ Message ${messageId} read status updated to: ${status}`);
    return true;
  }
  
  return false;
}

/**
 * Get message status for display
 */
export function getMessageStatus(messageId) {
  const stmt = db.prepare(`
    SELECT delivery_status, read_status, delivery_timestamp, read_timestamp
    FROM messages 
    WHERE id = ?
  `);
  
  return stmt.get(messageId);
}

/**
 * Mark all messages in a conversation as read
 */
export function markConversationAsRead(userId, contactId) {
  const stmt = db.prepare(`
    UPDATE messages 
    SET read_status = 'read', read_timestamp = ?
    WHERE user_id = ? 
      AND direction = 'inbound' 
      AND (from_digits = ? OR from_id = ?)
      AND read_status = 'unread'
  `);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const result = stmt.run(timestamp, userId, contactId, contactId);
  
  console.log(`👁️ Marked ${result.changes} messages as read for conversation: ${contactId}`);
  return result.changes;
}

/**
 * Mark a message as failed
 */
export function markMessageAsFailed(messageId, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE messages 
    SET delivery_status = ?, delivery_timestamp = ?, error_message = ?
    WHERE id = ?
  `);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const result = stmt.run(MESSAGE_STATUS.FAILED, timestamp, errorMessage, messageId);
  
  if (result.changes > 0) {
    console.log(`❌ Message ${messageId} marked as failed: ${errorMessage || 'Unknown error'}`);
    return true;
  }
  
  return false;
}

/**
 * Retry sending a failed message
 */
export function retryFailedMessage(messageId) {
  const stmt = db.prepare(`
    SELECT id, user_id, text_body, to_digits, from_digits, raw
    FROM messages 
    WHERE id = ? AND delivery_status = ?
  `);
  
  const message = stmt.get(messageId, MESSAGE_STATUS.FAILED);
  
  if (!message) {
    return { success: false, error: 'Message not found or not in failed state' };
  }
  
  // Reset status to sent for retry
  const updateStmt = db.prepare(`
    UPDATE messages 
    SET delivery_status = ?, delivery_timestamp = ?, error_message = NULL
    WHERE id = ?
  `);
  
  const timestamp = Math.floor(Date.now() / 1000);
  updateStmt.run(MESSAGE_STATUS.SENT, timestamp, messageId);
  
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

/**
 * Simulate WhatsApp webhook delivery status updates
 * In a real implementation, this would be called by WhatsApp webhooks
 */
export function simulateDeliveryStatusUpdate(messageId, status) {
  const timestamp = Math.floor(Date.now() / 1000);
  
  switch (status) {
    case 'delivered':
      updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.DELIVERED, timestamp);
      break;
    case 'read':
      updateMessageDeliveryStatus(messageId, MESSAGE_STATUS.READ, timestamp);
      updateMessageReadStatus(messageId, READ_STATUS.READ, timestamp);
      break;
    case 'failed':
      markMessageAsFailed(messageId, 'Simulated failure');
      break;
    default:
      console.warn(`Unknown delivery status: ${status}`);
  }
}
