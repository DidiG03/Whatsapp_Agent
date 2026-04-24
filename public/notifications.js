

let notificationsCache = [];
let notificationCheckInterval = null;
function toggleNotifications(event) {
  event?.stopPropagation();
  const dropdown = document.getElementById('notification-dropdown');
  if (!dropdown) return;
  
  const isVisible = dropdown.style.display === 'block';
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
async function loadNotifications() {
  try {
    const response = await fetch('/api/notifications?limit=20', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });
    if (response.status === 401) {
      return;
    }
    const data = await response.json();
    
    if (data.success) {
      notificationsCache = data.notifications;
      updateNotificationBadge(data.unreadCount);
      renderNotifications(data.notifications);
    }
  } catch (error) {
    renderNotificationError();
  }
}
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
function renderNotificationError() {
  const list = document.getElementById('notification-list');
  if (!list) return;
  list.innerHTML = '<div class="notification-error">Failed to load notifications</div>';
}
async function handleNotificationClick(notificationId, link, event) {
  event?.stopPropagation();
  
  try {
    await fetch(`/api/notifications/${notificationId}/read`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      credentials: 'include'
    });
    await loadNotifications();
    if (link && link !== 'null' && link !== 'undefined') {
      window.location.href = link;
    }
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
  }
}
async function markAllAsRead(event) {
  event?.stopPropagation();
  
  try {
    const response = await fetch('/api/notifications/read-all', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      credentials: 'include'
    });
    
    if (response.ok) {
      await loadNotifications();
    }
  } catch (error) {
    console.error('Failed to mark all as read:', error);
  }
}
function formatTimeAgo(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - timestamp;
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString();
}
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function startNotificationPolling() {
  if (notificationCheckInterval) return;
  notificationCheckInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/notifications?limit=1&unread_only=true', {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
      if (response.status === 401) {
        stopNotificationPolling();
        return;
      }
      const data = await response.json();
      
      if (data.success) {
        updateNotificationBadge(data.unreadCount);
      }
    } catch (error) {
    }
  }, 30000);
}
function stopNotificationPolling() {
  if (notificationCheckInterval) {
    clearInterval(notificationCheckInterval);
    notificationCheckInterval = null;
  }
}
document.addEventListener('click', function(event) {
  const bell = document.getElementById('notification-bell');
  const dropdown = document.getElementById('notification-dropdown');
  
  if (bell && dropdown && !bell.contains(event.target)) {
    dropdown.style.display = 'none';
  }
});
document.addEventListener('DOMContentLoaded', function() {
  loadNotifications();
  startNotificationPolling();
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      stopNotificationPolling();
    } else {
      startNotificationPolling();
      loadNotifications();
    }
  });
  window.addEventListener('beforeunload', stopNotificationPolling);
  (function attachRealtime(){
    try {
      const rm = window.realtimeManager;
      if (rm && rm.socket) {
        try { rm.socket.off && rm.socket.off('notification_created'); } catch {}
        rm.socket.on('notification_created', (data) => {
          try {
            const notif = data?.notification;
            if (notif) {
              notificationsCache = [notif].concat(notificationsCache || []);
              const badge = document.getElementById('notification-badge');
              const newCount = typeof data?.unreadCount === 'number' ? data.unreadCount : (function(){
                const current = parseInt((badge?.textContent || '0').replace(/\D/g,''), 10) || 0;
                return current + 1;
              })();
              updateNotificationBadge(newCount);
              const dropdown = document.getElementById('notification-dropdown');
              if (dropdown && dropdown.style.display === 'block') {
                renderNotifications(notificationsCache);
              }
            }
          } catch {}
        });
        return;
      }
      setTimeout(attachRealtime, 500);
    } catch {}
  })();
});

