/**
 * Quick Replies service for managing predefined message templates.
 */

import { db } from "../db-serverless.mjs";

/**
 * Get all quick replies for a user
 */
export function getQuickReplies(userId) {
  try {
    return db.prepare(`
      SELECT id, text, category, display_order, created_at, updated_at
      FROM quick_replies 
      WHERE user_id = ? 
      ORDER BY category, display_order ASC
    `).all(userId);
  } catch (error) {
    console.error('Error getting quick replies:', error);
    return [];
  }
}

/**
 * Get all quick reply categories for a user
 */
export function getQuickReplyCategories(userId) {
  try {
    return db.prepare(`
      SELECT DISTINCT category 
      FROM quick_replies 
      WHERE user_id = ? AND category IS NOT NULL
      ORDER BY category ASC
    `).all(userId).map(row => row.category);
  } catch (error) {
    console.error('Error getting quick reply categories:', error);
    return [];
  }
}

/**
 * Create a new quick reply
 */
export function createQuickReply(userId, text, category = 'General') {
  try {
    // Get the next display order for this category
    const maxOrder = db.prepare(`
      SELECT MAX(display_order) as max_order 
      FROM quick_replies 
      WHERE user_id = ? AND category = ?
    `).get(userId, category)?.max_order || 0;
    
    const stmt = db.prepare(`
      INSERT INTO quick_replies (user_id, text, category, display_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
    `);
    
    const result = stmt.run(userId, text, category, maxOrder + 1);
    return { success: true, id: result.lastInsertRowid };
  } catch (error) {
    console.error('Error creating quick reply:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update an existing quick reply
 */
export function updateQuickReply(userId, id, text, category) {
  try {
    const stmt = db.prepare(`
      UPDATE quick_replies 
      SET text = ?, category = ?, updated_at = strftime('%s','now')
      WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(text, category, id, userId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error updating quick reply:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a quick reply
 */
export function deleteQuickReply(userId, id) {
  try {
    const stmt = db.prepare(`
      DELETE FROM quick_replies 
      WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(id, userId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error deleting quick reply:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Reorder quick replies within a category
 */
export function reorderQuickReplies(userId, category, orderedIds) {
  try {
    const transaction = db.transaction(() => {
      orderedIds.forEach((id, index) => {
        db.prepare(`
          UPDATE quick_replies 
          SET display_order = ?, updated_at = strftime('%s','now')
          WHERE id = ? AND user_id = ? AND category = ?
        `).run(index + 1, id, userId, category);
      });
    });
    
    transaction();
    return { success: true };
  } catch (error) {
    console.error('Error reordering quick replies:', error);
    return { success: false, error: error.message };
  }
}
