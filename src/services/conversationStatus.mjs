/**
 * Conversation Status Management Service
 * Handles conversation status transitions: new, in_progress, resolved, closed
 */

import { Handoff } from "../schemas/mongodb.mjs";

// Valid conversation statuses
export const CONVERSATION_STATUSES = {
  NEW: 'new',
  IN_PROGRESS: 'in_progress', 
  RESOLVED: 'resolved',
};

// Status display names
export const STATUS_DISPLAY_NAMES = {
  [CONVERSATION_STATUSES.NEW]: 'New',
  [CONVERSATION_STATUSES.IN_PROGRESS]: 'In Progress',
  [CONVERSATION_STATUSES.RESOLVED]: 'Resolved', 
};

// Status colors for UI
export const STATUS_COLORS = {
  [CONVERSATION_STATUSES.NEW]: '#3b82f6', // Blue
  [CONVERSATION_STATUSES.IN_PROGRESS]: '#f59e0b', // Amber
  [CONVERSATION_STATUSES.RESOLVED]: '#10b981', // Green
};

/**
 * Get conversation status for a contact
 */
export async function getConversationStatus(userId, contactId) {
  const handoff = await Handoff.findOne({ user_id: userId, contact_id: contactId });
  return handoff?.conversation_status || CONVERSATION_STATUSES.NEW;
}

/**
 * Update conversation status
 */
export async function updateConversationStatus(userId, contactId, status, reason = null) {
  if (!Object.values(CONVERSATION_STATUSES).includes(status)) {
    throw new Error(`Invalid conversation status: ${status}`);
  }

  await Handoff.findOneAndUpdate(
    { user_id: userId, contact_id: contactId },
    { 
      user_id: userId,
      contact_id: contactId,
      conversation_status: status,
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );
  
  // Log status change for audit trail
  console.log(`📊 Conversation status updated: ${contactId} -> ${status} (${reason || 'No reason provided'})`);
  
  return true;
}

/**
 * Get all conversations with their statuses for a user
 */
export async function getConversationsWithStatus(userId) {
  return await Handoff.find({ user_id: userId })
    .select('contact_id conversation_status is_human human_expires_ts updatedAt last_seen_ts')
    .sort({ updatedAt: -1 });
}

/**
 * Get conversations by status
 */
export async function getConversationsByStatus(userId, status) {
  return await Handoff.find({ user_id: userId, conversation_status: status })
    .select('contact_id conversation_status is_human human_expires_ts updatedAt last_seen_ts')
    .sort({ updatedAt: -1 });
}

/**
 * Get conversation status statistics
 */
export async function getConversationStatusStats(userId) {
  const results = await Handoff.aggregate([
    { $match: { user_id: userId } },
    {
      $group: {
        _id: '$conversation_status',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const stats = {};
  
  // Initialize all statuses with 0
  Object.values(CONVERSATION_STATUSES).forEach(status => {
    stats[status] = 0;
  });
  
  // Fill in actual counts
  results.forEach(row => {
    stats[row._id] = row.count;
  });
  
  return stats;
}

/**
 * Auto-update status based on conversation activity
 */
export async function autoUpdateConversationStatus(userId, contactId) {
  const currentStatus = await getConversationStatus(userId, contactId);
  
  // Auto-transition rules
  if (currentStatus === CONVERSATION_STATUSES.NEW) {
    // If agent takes over (human mode), move to in_progress
    const handoff = await Handoff.findOne({ user_id: userId, contact_id: contactId });
    
    if (handoff?.is_human) {
      await updateConversationStatus(userId, contactId, CONVERSATION_STATUSES.IN_PROGRESS, 'Agent took over conversation');
    }
  }
}
