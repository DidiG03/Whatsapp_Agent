# Web Notifications Feature

A real-time web notification system with a bell icon in the navbar that alerts users when customers escalate to support.

## Features

- 🔔 **Bell Icon in Navbar**: Visible on all main pages with unread count badge
- 📬 **Dropdown Notifications**: Click bell to see notification list
- 🔵 **Unread Indicators**: Blue dot on unread notifications
- ⏰ **Relative Timestamps**: Shows "Just now", "5m ago", "2h ago", etc.
- 🔄 **Auto-Refresh**: Polls for new notifications every 30 seconds
- ✅ **Mark as Read**: Click notification to mark as read and navigate to link
- 📝 **Mark All Read**: Button to mark all notifications as read at once
- 🎨 **Beautiful UI**: Modern dropdown with smooth animations

## How It Works

### Notification Creation

When a customer escalates to support (webhook handler):
1. Customer request triggers escalation flow
2. System creates notification in database
3. Notification includes:
   - Title: "New Support Escalation"
   - Message: Customer name + reason
   - Link: Direct link to inbox conversation
   - Type: "escalation"
   - Metadata: Customer details as JSON

### Notification Display

1. **Bell Icon**: Shows in topbar on all pages
2. **Badge**: Red badge with count of unread notifications
3. **Dropdown**: Opens on click, shows last 20 notifications
4. **Auto-Update**: Checks for new notifications every 30s

### User Interactions

- **Click bell**: Toggle dropdown
- **Click notification**: Mark as read + navigate to link
- **Click "Mark all read"**: Mark all as read
- **Click outside**: Close dropdown

## API Endpoints

### GET /api/notifications
Fetch user's notifications
```
Query params:
  - limit: Max notifications to return (default: 20)
  - unread_only: Only return unread (default: false)

Response:
{
  "success": true,
  "notifications": [...],
  "unreadCount": 5
}
```

### POST /api/notifications/:id/read
Mark specific notification as read
```
Response:
{
  "success": true
}
```

### POST /api/notifications/read-all
Mark all notifications as read
```
Response:
{
  "success": true
}
```

### DELETE /api/notifications/:id
Delete specific notification
```
Response:
{
  "success": true
}
```

## Database Schema

```sql
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'escalation', 'message', etc.
  title TEXT NOT NULL,              -- "New Support Escalation"
  message TEXT,                     -- Details
  link TEXT,                        -- /inbox/+1234567890
  is_read INTEGER DEFAULT 0,        -- 0 = unread, 1 = read
  created_at INTEGER DEFAULT (strftime('%s','now')),
  metadata JSON                     -- Additional data
);
```

## Files Added/Modified

### New Files
- `src/routes/notifications.mjs` - API endpoints
- `public/notifications.js` - Frontend JavaScript
- `WEB_NOTIFICATIONS.md` - This documentation

### Modified Files
- `src/db.mjs` - Added notifications table
- `src/routes/webhook.mjs` - Create notification on escalation
- `src/app.mjs` - Register notification routes
- `src/utils.mjs` - Updated `renderTopbar()` with bell icon
- `public/styles.css` - Added notification styles
- `src/routes/dashboard.mjs` - Include notifications.js
- `src/routes/inbox.mjs` - Include notifications.js
- `src/routes/settings.mjs` - Include notifications.js

## Styling

The notification UI includes:
- **Bell icon**: Hover effect, padding, clean SVG icon
- **Badge**: Red circle with white text, positioned on bell
- **Dropdown**: White card with shadow, 380px wide
- **Items**: Hover effects, unread highlighting (blue background)
- **Dot indicator**: Blue dot for unread items
- **Typography**: Clear hierarchy (title, message, timestamp)

## Future Enhancements

Potential additions:
- Push notifications (browser API)
- Notification sounds
- Different notification types (new message, booking, etc.)
- Notification preferences per type
- Email digest of notifications
- Notification history page
- Bulk actions (delete all read, etc.)
- Notification filtering by type
- WebSocket for real-time updates (vs polling)

## Usage Example

When a customer escalates:
1. Customer: "I need help with my order"
2. Bot: "What's your name?"
3. Customer: "John Doe"
4. Bot: "What's the reason?"
5. Customer: "Need to change delivery address"
6. **Notification created** ✨
7. User sees:
   - Red badge on bell icon
   - "New Support Escalation" in dropdown
   - "John Doe requested to speak with a human: Need to change delivery address"
   - Click to go directly to conversation

## Testing

1. **Trigger escalation**: Have a test contact escalate to support via WhatsApp
2. **Check bell**: Bell icon should show badge with "1"
3. **Open dropdown**: Click bell to see notification
4. **Click notification**: Should mark as read and navigate to inbox
5. **Verify count**: Badge should disappear when all read

## Security

- ✅ All endpoints require authentication (`ensureAuthed`)
- ✅ User can only see their own notifications
- ✅ SQL injection prevention via prepared statements
- ✅ XSS prevention via HTML escaping in frontend
- ✅ Click outside to close (no hanging dropdowns)

## Performance

- Polling interval: 30 seconds (configurable)
- Dropdown loads lazily (only on open)
- Last 20 notifications cached in memory
- SQL indexes on `user_id` and `is_read`
- Cleanup recommended: Delete old read notifications periodically

