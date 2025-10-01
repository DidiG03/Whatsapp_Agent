/**
 * Notifications functionality for web alerts
 */

let notificationsCache = [];
let notificationCheckInterval = null;

// Toggle notification dropdown
function toggleNotifications(event) {
  event?.stopPropagation();
  const dropdown = document.getElementById('notification-dropdown');
  if (!dropdown) return;
  
  const isVisible = dropdown.style.display === 'block';
  
  // Close all other dropdowns
  document.querySelectorAll('.notification-dropdown').forEach(el => {
    if (el !== dropdown) el.style.display = 'none';
  });
  
  if (isVisible) {
    dropdown.style.display = 'none';
  } else {
    dropdown.style.display = 'block';
    loadNotifications();
  }
}

// Load notifications from API
async function loadNotifications() {
  try {
    const response = await fetch('/api/notifications?limit=20');
    const data = await response.json();
    
    if (data.success) {
      notificationsCache = data.notifications;
      updateNotificationBadge(data.unreadCount);
      renderNotifications(data.notifications);
    }
  } catch (error) {
    console.error('Failed to load notifications:', error);
    renderNotificationError();
  }
}

// Update notification badge
function updateNotificationBadge(count) {
  const badge = document.getElementById('notification-badge');
  if (!badge) return;
  
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Render notifications in dropdown
function renderNotifications(notifications) {
  const list = document.getElementById('notification-list');
  if (!list) return;
  
  if (!notifications || notifications.length === 0) {
    list.innerHTML = '<div class="notification-empty">No notifications yet</div>';
    return;
  }
  
  list.innerHTML = notifications.map(notif => {
    const timeAgo = formatTimeAgo(notif.created_at);
    const unreadClass = notif.is_read ? '' : 'notification-unread';
    
    return `
      <div class="notification-item ${unreadClass}" onclick="handleNotificationClick(${notif.id}, '${escapeHtml(notif.link || '')}', event)">
        <div class="notification-content">
          <div class="notification-title">${escapeHtml(notif.title)}</div>
          <div class="notification-message">${escapeHtml(notif.message || '')}</div>
          <div class="notification-time">${timeAgo}</div>
        </div>
        ${!notif.is_read ? '<div class="notification-dot"></div>' : ''}
      </div>
    `;
  }).join('');
}

// Render error state
function renderNotificationError() {
  const list = document.getElementById('notification-list');
  if (!list) return;
  list.innerHTML = '<div class="notification-error">Failed to load notifications</div>';
}

// Handle notification click
async function handleNotificationClick(notificationId, link, event) {
  event?.stopPropagation();
  
  try {
    // Mark as read
    await fetch(`/api/notifications/${notificationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Update UI
    await loadNotifications();
    
    // Navigate to link if provided
    if (link && link !== 'null' && link !== 'undefined') {
      window.location.href = link;
    }
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
  }
}

// Mark all notifications as read
async function markAllAsRead(event) {
  event?.stopPropagation();
  
  try {
    const response = await fetch('/api/notifications/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.ok) {
      await loadNotifications();
    }
  } catch (error) {
    console.error('Failed to mark all as read:', error);
  }
}

// Format timestamp as relative time
function formatTimeAgo(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - timestamp;
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  
  // Format as date for older notifications
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString();
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Check for new notifications periodically
function startNotificationPolling() {
  // Check every 30 seconds
  notificationCheckInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/notifications?limit=1&unread_only=true');
      const data = await response.json();
      
      if (data.success) {
        updateNotificationBadge(data.unreadCount);
      }
    } catch (error) {
      // Silently fail, don't spam console
    }
  }, 30000);
}

// Stop notification polling
function stopNotificationPolling() {
  if (notificationCheckInterval) {
    clearInterval(notificationCheckInterval);
    notificationCheckInterval = null;
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', function(event) {
  const bell = document.getElementById('notification-bell');
  const dropdown = document.getElementById('notification-dropdown');
  
  if (bell && dropdown && !bell.contains(event.target)) {
    dropdown.style.display = 'none';
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  // Load initial count
  loadNotifications();
  
  // Start polling for new notifications
  startNotificationPolling();
  
  // Clean up on page unload
  window.addEventListener('beforeunload', stopNotificationPolling);
});

