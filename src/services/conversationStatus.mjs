/**
 * Conversation Status Management Service
 * Handles conversation status transitions: new, in_progress, resolved, closed
 */

import { db } from "../db.mjs";

// Valid conversation statuses
export const CONVERSATION_STATUSES = {
  NEW: 'new',
  IN_PROGRESS: 'in_progress', 
  RESOLVED: 'resolved',
  CLOSED: 'closed'
};

// Status display names
export const STATUS_DISPLAY_NAMES = {
  [CONVERSATION_STATUSES.NEW]: 'New',
  [CONVERSATION_STATUSES.IN_PROGRESS]: 'In Progress',
  [CONVERSATION_STATUSES.RESOLVED]: 'Resolved', 
  [CONVERSATION_STATUSES.CLOSED]: 'Closed'
};

// Status colors for UI
export const STATUS_COLORS = {
  [CONVERSATION_STATUSES.NEW]: '#3b82f6', // Blue
  [CONVERSATION_STATUSES.IN_PROGRESS]: '#f59e0b', // Amber
  [CONVERSATION_STATUSES.RESOLVED]: '#10b981', // Green
  [CONVERSATION_STATUSES.CLOSED]: '#6b7280' // Gray
};

/**
 * Get conversation status for a contact
 */
export function getConversationStatus(userId, contactId) {
  const stmt = db.prepare(`
    SELECT conversation_status, updated_at 
    FROM handoff 
    WHERE user_id = ? AND contact_id = ?
  `);
  
  const result = stmt.get(userId, contactId);
  return result?.conversation_status || CONVERSATION_STATUSES.NEW;
}

/**
 * Update conversation status
 */
export function updateConversationStatus(userId, contactId, status, reason = null) {
  if (!Object.values(CONVERSATION_STATUSES).includes(status)) {
    throw new Error(`Invalid conversation status: ${status}`);
  }

  const stmt = db.prepare(`
    INSERT INTO handoff (contact_id, user_id, conversation_status, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(contact_id, user_id) 
    DO UPDATE SET 
      conversation_status = excluded.conversation_status,
      updated_at = strftime('%s','now')
  `);
  
  stmt.run(contactId, userId, status);
  
  // Log status change for audit trail
  console.log(`📊 Conversation status updated: ${contactId} -> ${status} (${reason || 'No reason provided'})`);
  
  return true;
}

/**
 * Get all conversations with their statuses for a user
 */
export function getConversationsWithStatus(userId) {
  const stmt = db.prepare(`
    SELECT 
      contact_id,
      conversation_status,
      is_human,
      human_expires_ts,
      updated_at,
      last_seen_ts
    FROM handoff 
    WHERE user_id = ? 
    ORDER BY updated_at DESC
  `);
  
  return stmt.all(userId);
}

/**
 * Get conversations by status
 */
export function getConversationsByStatus(userId, status) {
  const stmt = db.prepare(`
    SELECT 
      contact_id,
      conversation_status,
      is_human,
      human_expires_ts,
      updated_at,
      last_seen_ts
    FROM handoff 
    WHERE user_id = ? AND conversation_status = ?
    ORDER BY updated_at DESC
  `);
  
  return stmt.all(userId, status);
}

/**
 * Get conversation status statistics
 */
export function getConversationStatusStats(userId) {
  const stmt = db.prepare(`
    SELECT 
      conversation_status,
      COUNT(*) as count
    FROM handoff 
    WHERE user_id = ?
    GROUP BY conversation_status
  `);
  
  const results = stmt.all(userId);
  const stats = {};
  
  // Initialize all statuses with 0
  Object.values(CONVERSATION_STATUSES).forEach(status => {
    stats[status] = 0;
  });
  
  // Fill in actual counts
  results.forEach(row => {
    stats[row.conversation_status] = row.count;
  });
  
  return stats;
}

/**
 * Auto-update status based on conversation activity
 */
export function autoUpdateConversationStatus(userId, contactId) {
  const currentStatus = getConversationStatus(userId, contactId);
  
  // Auto-transition rules
  if (currentStatus === CONVERSATION_STATUSES.NEW) {
    // If agent takes over (human mode), move to in_progress
    const handoffStmt = db.prepare(`
      SELECT is_human FROM handoff WHERE user_id = ? AND contact_id = ?
    `);
    const handoff = handoffStmt.get(userId, contactId);
    
    if (handoff?.is_human) {
      updateConversationStatus(userId, contactId, CONVERSATION_STATUSES.IN_PROGRESS, 'Agent took over conversation');
    }
  }
}
