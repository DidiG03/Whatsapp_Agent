(function () {
  if (window.__AUTH_UTILS_LOADED__) return;
  window.__AUTH_UTILS_LOADED__ = true;

class AuthManager {
  constructor() {
    this.maxRetries = 2;
    this.retryDelay = 1000;
    this.autoCheckIntervalMs = 300000;
    this.keepaliveIntervalMs = 240000;
    this._rawFetch = window.fetch.bind(window);
    this._clerkReady = null;
    this._authRedirectScheduled = false;
    this._lastAuthToastAt = 0;

    this.authenticatedFetch = this.authenticatedFetch.bind(this);
    this.getSessionToken = this.getSessionToken.bind(this);
    this.handleUnauthorized = this.handleUnauthorized.bind(this);
    this.shouldSuppressAuthToast = this.shouldSuppressAuthToast.bind(this);

    document.addEventListener('DOMContentLoaded', () => {
      this.initClerk().catch(() => {});
    });

    try {
      setInterval(async () => {
        try {
          if (document.hidden) return;
          const status = await this.checkAuthStatus();
          if (status?.success === true && status?.signedIn === false) {
            this.handleUnauthorized();
          }
        } catch {}
      }, this.autoCheckIntervalMs);
    } catch {}

    try {
      setInterval(async () => {
        try {
          if (document.hidden) return;
          await this.touchSession();
        } catch {}
      }, this.keepaliveIntervalMs);
    } catch {}
  }

  async initClerk() {
    if (this._clerkReady) return this._clerkReady;
    this._clerkReady = (async () => {
      const deadline = Date.now() + 8000;
      while (!window.Clerk?.load && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!window.Clerk?.load) return false;
      await Promise.race([
        window.Clerk.load(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Clerk load timeout')), 8000))
      ]);
      return !!window.Clerk?.session;
    })().catch(() => false);
    return this._clerkReady;
  }

  async getSessionToken() {
    try {
      await Promise.race([
        this.initClerk(),
        new Promise((resolve) => setTimeout(() => resolve(false), 8000))
      ]);
    } catch {
      return null;
    }
    if (!window.Clerk?.session) return null;
    try {
      return await Promise.race([
        window.Clerk.session.getToken(),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ]);
    } catch {
      return null;
    }
  }

  async getCurrentUserId() {
    await this.initClerk();
    if (window.Clerk?.user?.id) return window.Clerk.user.id;
    const status = await this.checkAuthStatus();
    return status?.userId || null;
  }

  async touchSession() {
    const status = await this.checkAuthStatus();
    return !!(status?.success && status?.signedIn);
  }

  async checkAuthStatus() {
    try {
      const response = await this._rawFetch('/auth/status', {
        credentials: 'include',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Auth status check failed: ${response.status}`);
      }

      const authData = await response.json();
      return {
        success: true,
        ...authData
      };
    } catch (error) {
      console.error('Auth status check failed:', error);
      return {
        success: false,
        signedIn: false,
        error: error.message
      };
    }
  }

  async refreshSession() {
    try {
      await Promise.race([
        this.initClerk(),
        new Promise((resolve) => setTimeout(() => resolve(false), 8000))
      ]);
      if (window.Clerk?.session?.reload) {
        await Promise.race([
          window.Clerk.session.reload(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Clerk reload timeout')), 8000))
        ]);
        if (window.Clerk.session?.id) {
          return { success: true, userId: window.Clerk.user?.id || null };
        }
      }
    } catch (error) {
      console.warn('Clerk session reload failed:', error?.message || error);
    }

    try {
      const response = await this._rawFetch('/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json().catch(() => ({}));
      return response.ok ? data : { success: false, ...data };
    } catch (error) {
      console.error('Session refresh failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async authenticatedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    let sameOrigin = false;
    try {
      sameOrigin = url.startsWith('/') || new URL(url, window.location.origin).origin === window.location.origin;
    } catch {
      sameOrigin = url.startsWith('/');
    }
    if (!sameOrigin) {
      return this._rawFetch(input, init);
    }

    const perform = async () => {
      const headers = new Headers(init.headers || {});
      if (!headers.has('Accept')) headers.set('Accept', 'application/json');
      // Same-origin browser requests use Clerk session cookies via credentials.
      // Do not add Authorization here — browsers send Origin automatically and
      // Clerk rejects requests that include both Origin and Authorization.
      return this._rawFetch(input, {
        ...init,
        headers,
        credentials: init.credentials ?? 'include'
      });
    };

    let response = await perform();
    if (response.status === 401) {
      const refreshed = await this.refreshSession();
      if (refreshed?.success) {
        response = await perform();
      }
    }
    return response;
  }

  shouldSuppressAuthToast(url) {
    const value = String(url || '');
    return [
      '/api/notifications',
      '/api/realtime/status',
      '/api/usage/status',
      '/auth/status'
    ].some((path) => value.includes(path));
  }

  handleUnauthorized(responseUrl) {
    if (this._authRedirectScheduled) return;
    const now = Date.now();
    if (now - this._lastAuthToastAt < 5000) return;
    this._lastAuthToastAt = now;
    this._authRedirectScheduled = true;
    this.showToast('Your session expired. Please sign in again.', 'warning');
    setTimeout(() => {
      try {
        const target = `/auth/signin?redirect_url=${encodeURIComponent(window.location.href)}`;
        window.location.href = target;
      } catch {}
    }, 1500);
  }

  async submitFormWithAuth(form, retryCount = 0) {
    if (!form || !form.action) {
      console.error('Form submission error: Invalid form element');
      alert('Form submission failed: Invalid form');
      return false;
    }

    await this.touchSession();
    const authStatus = await this.checkAuthStatus();

    if (!authStatus.success || !authStatus.signedIn) {
      if (retryCount < this.maxRetries) {
        const refreshResult = await this.refreshSession();
        if (refreshResult.success) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
          return this.submitFormWithAuth(form, retryCount + 1);
        }
      }
      this.handleUnauthorized();
      return false;
    }

    form.submit();
    return true;
  }

  showToast(message, type = 'info') {
    try {
      if (window.Toast && typeof window.Toast[type] === 'function') {
        window.Toast[type](message);
        return;
      }
      if (window.Toast && typeof window.Toast.show === 'function') {
        window.Toast.show(message, type);
        return;
      }
    } catch {}
    if (typeof showToast === 'function') {
      showToast(message, type);
    } else {
      alert(message);
    }
  }

  setupFormSubmission(form) {
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      const originalText = submitButton ? submitButton.textContent : '';
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Submitting...';
      }

      try {
        await this.submitFormWithAuth(form);
      } catch (error) {
        console.error('Form submission setup error:', error);
        alert('An unexpected error occurred. Please try again.');
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalText;
        }
      }
    });
  }

  async checkAuthOnLoad() {
    try {
      await this.touchSession();
      const authStatus = await this.checkAuthStatus();
      if (authStatus.success === true && authStatus.signedIn === false) {
        window.location.href = '/auth/signin?redirect_url=' + encodeURIComponent(window.location.href);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Auth check on load failed:', error);
      return true;
    }
  }
}

window.authManager = new AuthManager();
window.checkAuthThenSubmit = async function(form) {
  return window.authManager.submitFormWithAuth(form);
};
window.checkAuthOnLoad = async function() {
  return window.authManager.checkAuthOnLoad();
};

window.deleteInboxConversation = async function(form, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!form?.action) return false;

  const submitButton = form.querySelector('button[type="submit"]');
  const originalText = submitButton ? submitButton.textContent : '';
  if (submitButton) {
    submitButton.disabled = true;
  }

  try {
    await window.authManager.touchSession();
    let authStatus = await window.authManager.checkAuthStatus();
    if (!authStatus.success || !authStatus.signedIn) {
      const refreshed = await window.authManager.refreshSession();
      if (!refreshed?.success) {
        window.authManager.handleUnauthorized();
        return false;
      }
      authStatus = await window.authManager.checkAuthStatus();
      if (!authStatus.success || !authStatus.signedIn) {
        window.authManager.handleUnauthorized();
        return false;
      }
    }

    const resp = await window.authManager.authenticatedFetch(form.action, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'text/html,application/json' }
    });

    if (resp.status === 401) {
      window.authManager.handleUnauthorized();
      return false;
    }

    if (!resp.ok && resp.status !== 302 && resp.status !== 303) {
      throw new Error('Delete failed');
    }

    const target = '/inbox?toast=' + encodeURIComponent('Conversation deleted') + '&toast_type=success';
    window.location.replace(target);
    return false;
  } catch (error) {
    console.error('Delete conversation failed:', error);
    if (submitButton) {
      submitButton.disabled = false;
      if (originalText) submitButton.textContent = originalText;
    }
    const msg = error?.message || 'Failed to delete conversation';
    if (window.Toast?.error) window.Toast.error(msg);
    else if (window.Toast?.show) window.Toast.show(msg, 'error');
    else alert(msg);
    return false;
  }
};

document.addEventListener('DOMContentLoaded', function() {
  const enhancedForms = document.querySelectorAll('form[data-auth-enhanced]');
  enhancedForms.forEach((form) => {
    window.authManager.setupFormSubmission(form);
  });
});

})();
