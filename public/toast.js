// Modern Toast Notification System
// Global toast utility for the WhatsApp Agent

window.Toast = {
  // Show a toast notification
  show: function(message, type = 'info', duration = 4000) {
    const container = this.getContainer();
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    
    // Toast content
    const icon = this.getIcon(type);
    toast.innerHTML = `
      <div class="toast-content">
        <div class="toast-icon">${icon}</div>
        <div class="toast-message">${message}</div>
        <button class="toast-close" onclick="Toast.close(this)">×</button>
      </div>
      <div class="toast-progress"></div>
    `;
    
    container.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Auto dismiss
    const progressBar = toast.querySelector('.toast-progress');
    progressBar.style.animation = `toast-progress ${duration}ms linear`;
    
    setTimeout(() => {
      if (toast.parentNode) {
        this.close(toast.querySelector('.toast-close'));
      }
    }, duration);
    
    return toast;
  },
  
  // Get or create toast container
  getContainer: function() {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  },
  
  // Get icon for toast type
  getIcon: function(type) {
    switch(type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': 
      default: return 'ℹ';
    }
  },
  
  // Close a toast notification
  close: function(button) {
    const toast = button.closest('.toast-notification');
    if (toast) {
      toast.classList.remove('show');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 300);
    }
  },
  
  // Close all toasts
  closeAll: function() {
    const container = this.getContainer();
    const toasts = container.querySelectorAll('.toast-notification');
    toasts.forEach(toast => {
      this.close(toast.querySelector('.toast-close'));
    });
  },
  
  // Success toast
  success: function(message, duration = 4000) {
    return this.show(message, 'success', duration);
  },
  
  // Error toast
  error: function(message, duration = 6000) {
    return this.show(message, 'error', duration);
  },
  
  // Warning toast
  warning: function(message, duration = 5000) {
    return this.show(message, 'warning', duration);
  },
  
  // Info toast
  info: function(message, duration = 4000) {
    return this.show(message, 'info', duration);
  }
};

// Auto-show toasts from URL parameters on page load
document.addEventListener('DOMContentLoaded', function() {
  const urlParams = new URLSearchParams(window.location.search);
  const toastMessage = urlParams.get('toast');
  const toastType = urlParams.get('type') || 'info';
  
  if (toastMessage) {
    Toast.show(decodeURIComponent(toastMessage), toastType);
    // Clean up URL without reloading
    const newUrl = window.location.pathname + window.location.search.replace(/[?&]toast=[^&]*&?/g, '').replace(/[?&]type=[^&]*&?/g, '').replace(/\?$/, '');
    window.history.replaceState({}, document.title, newUrl);
  }
});

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.Toast;
}
