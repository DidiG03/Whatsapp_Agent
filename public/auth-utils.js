/**
 * Enhanced authentication utilities for handling session refresh
 * This script provides robust auth checking and form submission handling
 */

class AuthManager {
  constructor() {
    this.maxRetries = 2;
    this.retryDelay = 1000; // 1 second
    this.autoCheckIntervalMs = 300000; // 5 minutes
    try {
      setInterval(async () => {
        try {
          const status = await this.checkAuthStatus();
          // Only redirect on a **confirmed** signed-out state.
          // Network/Clerk hiccups should not force the user to re-auth.
          if (status?.success === true && status?.signedIn === false) {
            // Redirect softly if session expired while idle
            window.location.href = '/auth';
          }
        } catch {}
      }, this.autoCheckIntervalMs);
    } catch {}
  }

  /**
   * Check authentication status with detailed information
   */
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
        // Treat as "unknown" rather than logged out to avoid redirect loops.
        signedIn: true,
        error: error.message
      };
    }
  }

  /**
   * Attempt to refresh the session
   */
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

  /**
   * Enhanced form submission with auth retry logic
   */
  async submitFormWithAuth(form, retryCount = 0) {
    // Validate form parameter
    if (!form || !form.action) {
      console.error('Form submission error: Invalid form element');
      alert('Form submission failed: Invalid form');
      return false;
    }

    // First, check auth status
    const authStatus = await this.checkAuthStatus();
    
    if (!authStatus.success || !authStatus.signedIn) {
      // Try to refresh session if we haven't exceeded max retries
      if (retryCount < this.maxRetries) {
        console.log(`Attempting session refresh (attempt ${retryCount + 1}/${this.maxRetries})`);
        
        const refreshResult = await this.refreshSession();
        if (refreshResult.success) {
          // Wait a bit for the session to propagate
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          // Retry the form submission
          return this.submitFormWithAuth(form, retryCount + 1);
        }
      }
      
      // If refresh failed or max retries exceeded, redirect to auth
      alert('Your session has expired. Please sign in again.');
      window.location.href = '/auth';
      return false;
    }

    // Auth is valid, proceed with form submission
    // For regular form submissions, we should let the browser handle it naturally
    // after authentication passes
    form.submit();
    return true;
  }

  /**
   * Show toast notification (if toast.js is available)
   */
  showToast(message, type = 'info') {
    if (typeof showToast === 'function') {
      showToast(message, type);
    } else {
      // Fallback to alert
      alert(message);
    }
  }

  /**
   * Setup enhanced form submission for a specific form
   */
  setupFormSubmission(form) {
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      
      // Show loading state
      const submitButton = form.querySelector('button[type="submit"]');
      const originalText = submitButton ? submitButton.textContent : '';
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Submitting...';
      }

      try {
        const success = await this.submitFormWithAuth(form);
        
        if (success) {
          // Form submission was successful
          // The response handling is done in submitFormWithAuth
        }
      } catch (error) {
        console.error('Form submission setup error:', error);
        alert('An unexpected error occurred. Please try again.');
      } finally {
        // Restore button state
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalText;
        }
      }
    });
  }

  /**
   * Setup enhanced auth checking for page load
   */
  async checkAuthOnLoad() {
    try {
      const authStatus = await this.checkAuthStatus();
      
      // Only redirect when we *successfully* checked and know the user is signed out.
      if (authStatus.success === true && authStatus.signedIn === false) {
        console.log('User not authenticated, redirecting to auth page');
        window.location.href = '/auth';
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Auth check on load failed:', error);
      // Do not redirect on transient errors.
      return true;
    }
  }
}

// Create global instance
window.authManager = new AuthManager();

// Enhanced auth checking function for backward compatibility
window.checkAuthThenSubmit = async function(form) {
  return window.authManager.submitFormWithAuth(form);
};

// Enhanced auth check on load function
window.checkAuthOnLoad = async function() {
  return window.authManager.checkAuthOnLoad();
};

// Auto-setup for forms with data-auth-enhanced attribute
document.addEventListener('DOMContentLoaded', function() {
  const enhancedForms = document.querySelectorAll('form[data-auth-enhanced]');
  enhancedForms.forEach(form => {
    window.authManager.setupFormSubmission(form);
  });
});
