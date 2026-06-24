(function () {
  'use strict';

  var body = document.body;
  var mountId = body.getAttribute('data-auth-mount');
  var authMode = body.getAttribute('data-auth-mode');
  var revealTimeoutId = null;
  var completingSignIn = false;

  function getPublishableKey() {
    var script = document.querySelector('script[data-clerk-publishable-key]');
    if (script) return script.getAttribute('data-clerk-publishable-key') || '';
    return getMeta('clerk-publishable-key');
  }

  function getMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : '';
  }

  function readAppearance() {
    var el = document.getElementById('clerk-appearance-config');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || '{}');
    } catch {
      return {};
    }
  }

  function showAuthError(message) {
    var el = document.getElementById(mountId);
    if (el) {
      el.innerHTML = '<div class="error-message">' + message + '</div>';
    }
    revealAuthPage();
  }

  function formIsMounted() {
    var el = document.getElementById(mountId);
    if (!el) return false;
    return !!el.querySelector(
      'form, .cl-rootBox, .cl-signIn-root, .cl-signUp-root, .cl-card, .cl-socialButtons'
    );
  }

  function revealAuthPage() {
    if (revealTimeoutId) {
      clearTimeout(revealTimeoutId);
      revealTimeoutId = null;
    }
    var bootScreen = document.querySelector('.auth-page__boot-screen');
    if (bootScreen) {
      bootScreen.setAttribute('aria-busy', 'false');
    }
    body.classList.remove('auth-page--booting');
    body.classList.add('auth-page--ready');
  }

  function watchForMountedForm() {
    if (formIsMounted()) {
      revealAuthPage();
      return;
    }

    var el = document.getElementById(mountId);
    if (!el) {
      revealAuthPage();
      return;
    }

    var observer = new MutationObserver(function () {
      if (formIsMounted()) {
        observer.disconnect();
        revealAuthPage();
      }
    });

    observer.observe(el, { childList: true, subtree: true });
    revealTimeoutId = setTimeout(function () {
      observer.disconnect();
      revealAuthPage();
    }, 20000);
  }

  function safeRedirectUrl() {
    var raw = new URLSearchParams(window.location.search).get('redirect_url') || '';
    if (!raw) return '/inbox';
    try {
      if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('://')) return raw;
      var u = new URL(raw, window.location.origin);
      if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
    } catch {}
    return '/inbox';
  }

  async function waitForServerSessionThenRedirect(target, attempt, remountFn) {
    var tries = typeof attempt === 'number' ? attempt : 0;
    try {
      var response = await fetch('/auth/status', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      var data = await response.json().catch(function () { return {}; });
      if (data && data.signedIn) {
        window.location.replace(target);
        return;
      }
    } catch {}

    if (tries < 24) {
      setTimeout(function () {
        waitForServerSessionThenRedirect(target, tries + 1, remountFn);
      }, 250);
      return;
    }

    try {
      if (window.Clerk && window.Clerk.signOut) {
        await window.Clerk.signOut();
      }
    } catch {}

    completingSignIn = false;
    if (typeof remountFn === 'function') {
      remountFn();
      return;
    }
    showAuthError('Could not verify your session. Please sign in again.');
  }

  async function syncClerkSessionToServer() {
    try {
      if (window.Clerk && window.Clerk.session && window.Clerk.session.getToken) {
        await window.Clerk.session.getToken({ skipCache: true });
      }
      if (window.Clerk && window.Clerk.session && window.Clerk.session.reload) {
        await window.Clerk.session.reload();
      }
    } catch {}
  }

  function waitForClerk(onReady) {
    var retryCount = 0;
    var maxRetries = 80;

    function tick() {
      if (window.Clerk && window.Clerk.load) {
        window.Clerk.load().then(onReady).catch(function (error) {
          console.error('Failed to load Clerk:', error);
          showAuthError('Failed to load authentication. Please refresh the page.');
        });
        return;
      }
      retryCount++;
      if (retryCount >= maxRetries) {
        showAuthError('Failed to load authentication. Please refresh the page.');
        return;
      }
      setTimeout(tick, 100);
    }

    tick();
  }

  function mountAuthComponent(mountFn) {
    function remountAuth() {
      var el = document.getElementById(mountId);
      if (el) el.innerHTML = '';
      mountFn();
      watchForMountedForm();
    }

    function completeSignIn(target) {
      if (completingSignIn) return;
      completingSignIn = true;
      syncClerkSessionToServer().finally(function () {
        waitForServerSessionThenRedirect(target, 0, function () {
          completingSignIn = false;
          remountAuth();
        });
      });
    }

    waitForClerk(async function () {
      var target = safeRedirectUrl();
      try {
        var statusResponse = await fetch('/auth/status', {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        var status = await statusResponse.json().catch(function () { return {}; });
        if (status && status.signedIn) {
          window.location.replace(target);
          return;
        }
      } catch {}

      if (window.Clerk && window.Clerk.user) {
        completeSignIn(target);
        return;
      }

      remountAuth();

      if (window.Clerk && window.Clerk.addListener) {
        window.Clerk.addListener(function (payload) {
          if (payload && payload.user) {
            completeSignIn(target);
          }
        });
      }
    });
  }

  function init() {
    if (!mountId || !authMode) {
      revealAuthPage();
      return;
    }

    var publishableKey = getPublishableKey();
    if (!publishableKey || publishableKey === 'undefined' || publishableKey === 'null') {
      showAuthError('Authentication is not configured. Please contact support.');
      return;
    }

    var appearance = readAppearance();

    mountAuthComponent(function () {
      var el = document.getElementById(mountId);
      if (!el || !window.Clerk) return;

      if (authMode === 'signup' && window.Clerk.mountSignUp) {
        window.Clerk.mountSignUp(el, {
          appearance: appearance,
          signInUrl: '/auth/signin'
        });
        return;
      }

      if (authMode === 'signin' && window.Clerk.mountSignIn) {
        window.Clerk.mountSignIn(el, {
          appearance: appearance,
          signUpUrl: '/auth/signup'
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
