import { CLERK_ENABLED, CLERK_PUBLISHABLE, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL, PUBLIC_BASE_URL } from "../config.mjs";
import { getAuth, clerkClient } from "@clerk/express";
import { signSessionToken } from "../middleware/auth.mjs";
import { getVercelWebAnalyticsSnippet } from "../utils.mjs";

function clearClerkCookies(req, res) {
  const names = new Set([
    "__session",
    "__refresh",
    "__client_uat",
    "__clerk_handshake",
    "__clerk_db_jwt",
    "__clerk_redirect_count",
    "__clerk_handshake_nonce",
    "__clerk_synced",
    "__clerk_redirect_url",
    "__clerk_help",
    "__clerk_hs_reason",
    "__dev_session",
  ]);

  for (const name of Object.keys(req.cookies || {})) {
    if (/^__(session|refresh|client_uat|clerk|dev_)/.test(name)) {
      names.add(name);
    }
  }

  const clearOpts = [
    { path: "/" },
    { path: "/", httpOnly: true },
    { path: "/", httpOnly: true, sameSite: "lax" },
    { path: "/", httpOnly: true, secure: true, sameSite: "lax" },
    { path: "/", httpOnly: true, secure: true, sameSite: "none" },
  ];

  for (const name of names) {
    for (const opts of clearOpts) {
      res.clearCookie(name, opts);
    }
  }
}

const CLERK_JS_VERSION = (process.env.CLERK_JS_VERSION || '5').toString().trim() || '5';

function authPageShell({ pageTitle, mountId, switchPrompt, switchHref, switchLabel, clerkInitScript }) {
  return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
        <title>${pageTitle} — Code Orbit Agent</title>
        <link rel="stylesheet" href="/styles.css">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        ${getVercelWebAnalyticsSnippet()}
        <link rel="icon" href="/logo-icon.png" type="image/png">
        <script src="https://unpkg.com/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js" data-clerk-publishable-key="${CLERK_PUBLISHABLE}"></script>
      </head>
      <body class="auth-page">
        <main class="auth-page__shell">
          <div class="auth-page__panel">
            <a href="/auth/signin" class="auth-page__brand">
              <img src="/logo-icon.png" alt="" class="auth-page__logo" width="32" height="32" />
              <span>Code Orbit Agent</span>
            </a>
            <div id="${mountId}" class="auth-page__clerk"></div>
            <p class="auth-page__switch">
              ${switchPrompt}
              <a href="${switchHref}" class="auth-page__link">${switchLabel}</a>
            </p>
          </div>
        </main>
        <script>${clerkInitScript}</script>
      </body>
      </html>`;
}

const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#4338ca',
    colorText: '#0f172a',
    colorTextSecondary: '#64748b',
    colorInputText: '#0f172a',
    colorBackground: '#ffffff',
    borderRadius: '10px',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize: '0.9375rem',
  },
  layout: {
    socialButtonsPlacement: 'top',
    socialButtonsVariant: 'blockButton',
    showOptionalFields: false,
  },
  elements: {
    rootBox: 'auth-clerk-root',
    card: 'auth-clerk-card',
    header: 'auth-clerk-header',
    headerTitle: 'auth-clerk-title',
    headerSubtitle: 'auth-clerk-subtitle',
    logoBox: 'auth-clerk-logo',
    logoImage: 'auth-clerk-logo-img',
    socialButtonsBlockButton: 'auth-clerk-social',
    dividerLine: 'auth-clerk-divider-line',
    dividerText: 'auth-clerk-divider-text',
    formFieldLabel: 'auth-clerk-label',
    formFieldInput: 'auth-clerk-input',
    formButtonPrimary: 'auth-clerk-submit',
    footer: 'auth-clerk-footer',
    footerAction: 'auth-clerk-footer-action',
    formFieldErrorText: 'auth-clerk-error',
    alertText: 'auth-clerk-error',
  },
};

export default function registerAuthRoutes(app) {
  app.get("/auth", (_req, res) => {
    res.redirect("/auth/signin");
  });

  const clerkBootstrap = `
    const clerkPublishableKey = '${CLERK_PUBLISHABLE}';
    function safeRedirectUrl() {
      const raw = new URLSearchParams(window.location.search).get('redirect_url') || '';
      if (!raw) return '/inbox';
      try {
        if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('://')) return raw;
        const u = new URL(raw, window.location.origin);
        if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
      } catch {}
      return '/inbox';
    }
    function showAuthError(mountId, message) {
      const el = document.getElementById(mountId);
      if (el) el.innerHTML = '<div class="error-message">' + message + '</div>';
    }
    function waitForClerk(mountId, onReady) {
      let retryCount = 0;
      const maxRetries = 50;
      function tick() {
        if (window.Clerk && window.Clerk.load) {
          window.Clerk.load().then(onReady).catch(function(error) {
            console.error('Failed to load Clerk:', error);
            showAuthError(mountId, 'Failed to load authentication. Please refresh the page.');
          });
          return;
        }
        retryCount++;
        if (retryCount >= maxRetries) {
          showAuthError(mountId, 'Failed to load authentication. Please refresh the page.');
          return;
        }
        setTimeout(tick, 100);
      }
      tick();
    }
  `;

  const clerkAppearanceJson = JSON.stringify(CLERK_APPEARANCE);

  app.get("/auth/signup", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(authPageShell({
      pageTitle: 'Sign Up',
      mountId: 'signup-component',
      switchPrompt: 'Already have an account?',
      switchHref: '/auth/signin',
      switchLabel: 'Sign in',
      clerkInitScript: clerkBootstrap + `
        const clerkAppearance = ${clerkAppearanceJson};
        if (!clerkPublishableKey || clerkPublishableKey === 'undefined' || clerkPublishableKey === 'null') {
          showAuthError('signup-component', 'Authentication is not configured. Please contact support.');
        } else {
          waitForClerk('signup-component', function() {
            window.Clerk.mountSignUp(document.getElementById('signup-component'), {
              appearance: clerkAppearance,
              afterSignUpUrl: '/inbox',
              signInUrl: '/auth/signin',
              redirectUrl: safeRedirectUrl()
            });
          });
        }
      `
    }));
  });

  app.get("/auth/signin", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(authPageShell({
      pageTitle: 'Sign In',
      mountId: 'signin-component',
      switchPrompt: "Don't have an account?",
      switchHref: '/auth/signup',
      switchLabel: 'Sign up',
      clerkInitScript: clerkBootstrap + `
        const clerkAppearance = ${clerkAppearanceJson};
        if (!clerkPublishableKey || clerkPublishableKey === 'undefined' || clerkPublishableKey === 'null') {
          showAuthError('signin-component', 'Authentication is not configured. Please contact support.');
        } else {
          waitForClerk('signin-component', function() {
            window.Clerk.mountSignIn(document.getElementById('signin-component'), {
              appearance: clerkAppearance,
              afterSignInUrl: '/inbox',
              signUpUrl: '/auth/signup',
              redirectUrl: safeRedirectUrl()
            });
          });
        }
      `
    }));
  });

  app.get("/auth/status", (req, res) => {
    try {
      const auth = getAuth(req) || {};
      const { userId, sessionId } = auth;
      res.setHeader("Cache-Control", "no-store");
      return res.json({ 
        signedIn: !!userId,
        userId: userId || null,
        sessionId: sessionId || null,
        needsRefresh: false      });
    } catch (error) {
      console.error('Auth status check failed:', error);
      return res.json({ 
        signedIn: false, 
        userId: null, 
        sessionId: null,
        needsRefresh: false,
        error: 'Auth check failed'
      });
    }
  });
  app.get("/auth/ws-token", (req, res) => {
    try {
      const { userId } = getAuth(req) || {};
      if (!userId) {
        return res.status(401).json({ error: "Not signed in" });
      }
      const token = signSessionToken(userId);
      return res.json({ token, userId });
    } catch (error) {
      console.error("Failed to issue WS token:", error);
      return res.status(500).json({ error: "Failed to issue token" });
    }
  });
  app.post("/auth/refresh", async (req, res) => {
    try {
      const auth = getAuth(req) || {};
      const { userId, sessionId } = auth;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'No active session to refresh',
          redirectTo: '/auth/signin'
        });
      }

      if (sessionId) {
        try {
          await clerkClient.sessions.getSession(sessionId);
        } catch {
          return res.status(401).json({
            success: false,
            error: 'Session is no longer valid',
            redirectTo: '/auth/signin'
          });
        }
      }

      return res.json({
        success: true,
        message: 'Session is active',
        userId,
        sessionId: sessionId || null
      });

    } catch (error) {
      console.error('Session refresh failed:', error);
      return res.status(500).json({
        success: false,
        error: 'Session refresh failed',
        redirectTo: '/auth/signin'
      });
    }
  });

  app.get("/logout", (req, res) => {
    if (!CLERK_ENABLED) return res.redirect("/");
    const { sessionId } = getAuth(req) || {};
    clearClerkCookies(req, res);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.redirect(303, "/auth/signin");
    if (sessionId) {
      clerkClient.sessions.revokeSession(sessionId).catch((error) => {
        console.warn("[logout] revokeSession failed:", error?.message || error);
      });
    }
  });
}

