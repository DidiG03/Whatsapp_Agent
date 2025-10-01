/**
 * Notification routes for web alerts
 * - GET /api/notifications: fetch user's notifications
 * - POST /api/notifications/:id/read: mark notification as read
 * - POST /api/notifications/read-all: mark all as read
 */
import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { db } from "../db.mjs";

export default function registerNotificationRoutes(app) {
  // Get notifications for current user
  app.get("/api/notifications", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const limit = parseInt(req.query.limit || '20', 10);
    const unreadOnly = req.query.unread_only === 'true';
    
    try {
      let query = `SELECT * FROM notifications WHERE user_id = ?`;
      let params = [userId];
      
      if (unreadOnly) {
        query += ` AND is_read = 0`;
      }
      
      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      
      const notifications = db.prepare(query).all(...params);
      
      // Get unread count
      const unreadCount = db.prepare(`SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0`).get(userId)?.count || 0;
      
      res.json({
        success: true,
        notifications,
        unreadCount
      });
    } catch (e) {
      console.error('[Notifications API] Error fetching notifications:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
  
  // Mark notification as read
  app.post("/api/notifications/:id/read", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const notificationId = parseInt(req.params.id, 10);
    
    try {
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(notificationId, userId);
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error marking notification as read:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
  
  // Mark all notifications as read
  app.post("/api/notifications/read-all", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    
    try {
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`).run(userId);
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error marking all as read:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
  
  // Delete notification
  app.delete("/api/notifications/:id", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const notificationId = parseInt(req.params.id, 10);
    
    try {
      db.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`).run(notificationId, userId);
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error deleting notification:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

