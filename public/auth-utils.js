

class AuthManager {
  constructor() {
    this.maxRetries = 2;
    this.retryDelay = 1000;    this.autoCheckIntervalMs = 300000;    try {
      setInterval(async () => {
        try {
          const status = await this.checkAuthStatus();
          if (status?.success === true && status?.signedIn === false) {
            window.location.href = '/auth';
          }
        } catch {}
      }, this.autoCheckIntervalMs);
    } catch {}
  }
  async checkAuthStatus() {
    try {
      const response = await fetch('/auth/status', { 
        credentials: 'include',
        headers: {
          'Accept': 'application/json'
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
        signedIn: true,
        error: error.message
      };
    }
  }
  async refreshSession() {
    try {
      const response = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Session refresh failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  async submitFormWithAuth(form, retryCount = 0) {
    if (!form || !form.action) {
      console.error('Form submission error: Invalid form element');
      alert('Form submission failed: Invalid form');
      return false;
    }
    const authStatus = await this.checkAuthStatus();
    
    if (!authStatus.success || !authStatus.signedIn) {
      if (retryCount < this.maxRetries) {
        console.log(`Attempting session refresh (attempt ${retryCount + 1}/${this.maxRetries})`);
        
        const refreshResult = await this.refreshSession();
        if (refreshResult.success) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          return this.submitFormWithAuth(form, retryCount + 1);
        }
      }
      alert('Your session has expired. Please sign in again.');
      window.location.href = '/auth';
      return false;
    }
    form.submit();
    return true;
  }
  showToast(message, type = 'info') {
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
        const success = await this.submitFormWithAuth(form);
        
        if (success) {
        }
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
      const authStatus = await this.checkAuthStatus();
      if (authStatus.success === true && authStatus.signedIn === false) {
        console.log('User not authenticated, redirecting to auth page');
        window.location.href = '/auth';
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
document.addEventListener('DOMContentLoaded', function() {
  const enhancedForms = document.querySelectorAll('form[data-auth-enhanced]');
  enhancedForms.forEach(form => {
    window.authManager.setupFormSubmission(form);
  });
});
