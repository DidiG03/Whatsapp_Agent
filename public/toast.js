
window.Toast = {
  show: function(message, type = 'info', duration = 4000) {
    const container = this.getContainer();
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = this.getIcon(type);
    toast.innerHTML = `
      <div class="toast-content">
        <div class="toast-icon">${icon}</div>
        <div class="toast-message">${message}</div>
        <button class="toast-close" onclick="Toast.close(this)">×</button>
      </div>
      <div class="toast-actions" style="display:none"></div>
      <div class="toast-progress"></div>
    `;
    
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 100);
    const progressBar = toast.querySelector('.toast-progress');
    progressBar.style.animation = `toast-progress ${duration}ms linear`;
    
    setTimeout(() => {
      if (toast.parentNode) {
        this.close(toast.querySelector('.toast-close'));
      }
    }, duration);
    
    return toast;
  },
  showWithActions: function(message, type = 'info', duration = 5000, actions = []) {
    const toast = this.show(message, type, duration);
    if (!toast) return null;
    
    const actionsContainer = toast.querySelector('.toast-actions');
    if (!actionsContainer) return toast;
    actionsContainer.innerHTML = '';
    const validActions = Array.isArray(actions) ? actions.filter(a => a && a.label) : [];
    if (validActions.length > 0) {
      actionsContainer.style.display = 'flex';
      validActions.forEach((action) => {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = String(action.label);
        if (typeof action.onClick === 'function') {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            try { action.onClick(e); } catch {}
          });
        }
        actionsContainer.appendChild(btn);
      });
    }
    
    return toast;
  },
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
  getIcon: function(type) {
    switch(type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': 
      default: return 'ℹ';
    }
  },
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
  closeAll: function() {
    const container = this.getContainer();
    const toasts = container.querySelectorAll('.toast-notification');
    toasts.forEach(toast => {
      this.close(toast.querySelector('.toast-close'));
    });
  },
  success: function(message, duration = 4000) {
    return this.show(message, 'success', duration);
  },
  error: function(message, duration = 6000) {
    return this.show(message, 'error', duration);
  },
  warning: function(message, duration = 5000) {
    return this.show(message, 'warning', duration);
  },
  info: function(message, duration = 4000) {
    return this.show(message, 'info', duration);
  }
};
document.addEventListener('DOMContentLoaded', function() {
  const urlParams = new URLSearchParams(window.location.search);
  const toastMessage = urlParams.get('toast');
  const toastType = urlParams.get('type') || 'info';
  
  if (toastMessage) {
    Toast.show(decodeURIComponent(toastMessage), toastType);
    const newUrl = window.location.pathname + window.location.search.replace(/[?&]toast=[^&]*&?/g, '').replace(/[?&]type=[^&]*&?/g, '').replace(/\?$/, '');
    window.history.replaceState({}, document.title, newUrl);
  }
});
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.Toast;
}
