
import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { Notification } from "../schemas/mongodb.mjs";

export default function registerNotificationRoutes(app) {
  app.get("/api/notifications", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const limit = parseInt(req.query.limit || '20', 10);
    const unreadOnly = req.query.unread_only === 'true';
    
    try {
      const findQuery = { user_id: userId };
      if (unreadOnly) findQuery.is_read = false;
      const notifications = await Notification.find(findQuery).sort({ createdAt: -1 }).limit(limit).lean();
      const unreadCount = await Notification.countDocuments({ user_id: userId, is_read: false });
      
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
  app.post("/api/notifications/:id/read", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const notificationId = parseInt(req.params.id, 10);
    
    try {
      await Notification.findOneAndUpdate({ _id: String(notificationId), user_id: userId }, { $set: { is_read: true } });
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error marking notification as read:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
  app.post("/api/notifications/read-all", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    
    try {
      await Notification.updateMany({ user_id: userId, is_read: false }, { $set: { is_read: true } });
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error marking all as read:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
  app.delete("/api/notifications/:id", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const notificationId = parseInt(req.params.id, 10);
    
    try {
      await Notification.findOneAndDelete({ _id: String(notificationId), user_id: userId });
      res.json({ success: true });
    } catch (e) {
      console.error('[Notifications API] Error deleting notification:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

