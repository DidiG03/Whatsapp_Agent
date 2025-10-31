import { CLERK_ENABLED, CLERK_PUBLISHABLE, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL, PUBLIC_BASE_URL } from "../config.mjs";
import { getAuth, clerkClient } from "@clerk/express";
import { signSessionToken } from "../middleware/auth.mjs";

export default function registerAuthRoutes(app) {
  // Redirect main auth route to signin
  app.get("/auth", (_req, res) => {
    res.redirect("/auth/signin");
  });

  // Custom signup page with Clerk integration
  app.get("/auth/signup", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sign Up - WhatsApp Agent</title>
        <link rel="stylesheet" href="/styles.css">
        <link rel="icon" href="/logo-icon.png" type="image/png">
        <script src="https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js" data-clerk-publishable-key="${CLERK_PUBLISHABLE}"></script>
      </head>
      <body class="auth-aurora">
        <div class="auth-shell">
          <aside class="brand-pane">
            <div class="brand-inner">
              <img src="/logo-icon.png" alt="WhatsApp Agent" class="brand-logo">
              <h2 class="brand-title"><span>WhatsApp Agent</span></h2>
              <p class="brand-tagline">Automate chats, bookings and your inbox — effortlessly.</p>
              <ul class="brand-list">
                <li>AI replies and smart triage</li>
                <li>One‑tap booking links</li>
                <li>Secure and privacy‑first</li>
              </ul>
            </div>
          </aside>
          <main class="form-pane">
            <div class="form-card">
              <div class="auth-header">
                <img src="/logo-icon.png" alt="WhatsApp Agent" class="auth-logo">
                <h1 class="auth-title">Create Account</h1>
                <p class="auth-subtitle">Join WhatsApp Agent and start automating your conversations</p>
              </div>
              <div id="signup-component"></div>
              <div class="auth-footer">
                <p class="auth-switch">
                  Already have an account? 
                  <a href="/auth/signin" class="auth-link">Sign in</a>
                </p>
              </div>
            </div>
          </main>
        </div>
        
        <script>
          const clerkPublishableKey = '${CLERK_PUBLISHABLE}';
          
          if (!clerkPublishableKey || clerkPublishableKey === 'undefined' || clerkPublishableKey === 'null') {
            document.getElementById('signup-component').innerHTML = 
              '<div class="error-message">Authentication is not configured. Please contact support.</div>';
          } else {
            // Wait for Clerk to be available, then initialize
            let retryCount = 0;
            const maxRetries = 50; // 5 seconds max
            function initializeClerk() {
              if (window.Clerk && window.Clerk.load) {
                // Wait for Clerk to be fully ready
                window.Clerk.load().then(() => {
                  // Mount the SignUp component
                  window.Clerk.mountSignUp(document.getElementById('signup-component'), {
                  appearance: {
                    elements: {
                      rootBox: 'clerk-signup-root',
                      card: 'clerk-signup-card',
                      headerTitle: 'clerk-signup-title',
                      headerSubtitle: 'clerk-signup-subtitle',
                      socialButtonsBlockButton: 'clerk-social-button',
                      formButtonPrimary: 'btn btn-primary btn-full',
                      formFieldInput: 'form-input',
                      formFieldLabel: 'form-label',
                      footerActionLink: 'auth-link',
                      identityPreviewText: 'form-text',
                      formFieldInputShowPasswordButton: 'password-toggle',
                      formFieldInputShowPasswordIcon: 'eye-icon',
                      formFieldSuccessText: 'form-success',
                      formFieldErrorText: 'form-error',
                      alertText: 'form-error',
                      formHeaderTitle: 'auth-title',
                      formHeaderSubtitle: 'auth-subtitle'
                    },
                    layout: {
                      socialButtonsPlacement: 'bottom',
                      socialButtonsVariant: 'blockButton'
                    }
                    },
                    afterSignUpUrl: '/dashboard',
                    signInUrl: '/auth/signin',
                    redirectUrl: new URLSearchParams(window.location.search).get('redirect_url') || '/dashboard'
                });
                }).catch(error => {
                  console.error('Failed to load Clerk:', error);
                  document.getElementById('signup-component').innerHTML = 
                    '<div class="error-message">Failed to load authentication. Please refresh the page.</div>';
                });
              } else {
                retryCount++;
                if (retryCount >= maxRetries) {
                  console.error('Clerk failed to load after', maxRetries, 'retries');
                  document.getElementById('signup-component').innerHTML = 
                    '<div class="error-message">Failed to load authentication. Please refresh the page.</div>';
                  return;
                }
                setTimeout(initializeClerk, 100);
              }
            }
            
            // Start initialization
            initializeClerk();
          }
        </script>
      </body>
      </html>
    `);
  });

  // Custom signin page with Clerk integration
  app.get("/auth/signin", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sign In - WhatsApp Agent</title>
        <link rel="stylesheet" href="/styles.css">
        <link rel="icon" href="/logo-icon.png" type="image/png">
        <script src="https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js" data-clerk-publishable-key="${CLERK_PUBLISHABLE}"></script>
      </head>
      <body class="auth-aurora">
        <div class="auth-shell">
          <aside class="brand-pane">
            <div class="brand-inner">
              <img src="/logo-icon.png" alt="WhatsApp Agent" class="brand-logo">
              <h2 class="brand-title"><span>WhatsApp Agent</span></h2>
              <p class="brand-tagline">Operate faster with an AI‑assisted, unified WhatsApp inbox.</p>
              <ul class="brand-list">
                <li>Unified threads and analytics</li>
                <li>Faster responses with AI assist</li>
                <li>Notifications that matter</li>
              </ul>
            </div>
          </aside>
          <main class="form-pane">
            <div class="form-card">
              <div class="auth-header">
                <img src="/logo-icon.png" alt="WhatsApp Agent" class="auth-logo">
                <h1 class="auth-title">Welcome Back</h1>
                <p class="auth-subtitle">Sign in to your WhatsApp Agent account</p>
              </div>
              <div id="signin-component"></div>
              <div class="auth-footer">
                <p class="auth-switch">
                  Don't have an account? 
                  <a href="/auth/signup" class="auth-link">Sign up</a>
                </p>
              </div>
            </div>
          </main>
        </div>
        
        <script>
          const clerkPublishableKey = '${CLERK_PUBLISHABLE}';
          
          if (!clerkPublishableKey || clerkPublishableKey === 'undefined' || clerkPublishableKey === 'null') {
            document.getElementById('signin-component').innerHTML = 
              '<div class="error-message">Authentication is not configured. Please contact support.</div>';
          } else {
            // Wait for Clerk to be available, then initialize
            let retryCount = 0;
            const maxRetries = 50; // 5 seconds max
            
            function initializeClerk() {
              if (window.Clerk && window.Clerk.load) {
                // Wait for Clerk to be fully ready
                window.Clerk.load().then(() => {
                  // Mount the SignIn component
                  window.Clerk.mountSignIn(document.getElementById('signin-component'), {
                    appearance: {
                      elements: {
                        rootBox: 'clerk-signin-root',
                        card: 'clerk-signin-card',
                        headerTitle: 'clerk-signin-title',
                        headerSubtitle: 'clerk-signin-subtitle',
                        socialButtonsBlockButton: 'clerk-social-button',
                        formButtonPrimary: 'btn btn-primary btn-full',
                        formFieldInput: 'form-input',
                        formFieldLabel: 'form-label',
                        footerActionLink: 'auth-link',
                        identityPreviewText: 'form-text',
                        formFieldInputShowPasswordButton: 'password-toggle',
                        formFieldInputShowPasswordIcon: 'eye-icon',
                        formFieldSuccessText: 'form-success',
                        formFieldErrorText: 'form-error',
                        alertText: 'form-error',
                        formHeaderTitle: 'auth-title',
                        formHeaderSubtitle: 'auth-subtitle'
                      },
                      layout: {
                        socialButtonsPlacement: 'bottom',
                        socialButtonsVariant: 'blockButton'
                        
                      }
                    },
                    afterSignInUrl: '/dashboard',
                    signUpUrl: '/auth/signup',
                    redirectUrl: new URLSearchParams(window.location.search).get('redirect_url') || '/dashboard'
                  });
                }).catch(error => {
                  console.error('Failed to load Clerk:', error);
                  document.getElementById('signin-component').innerHTML = 
                    '<div class="error-message">Failed to load authentication. Please refresh the page.</div>';
                });
              } else {
                retryCount++;
                if (retryCount >= maxRetries) {
                  console.error('Clerk failed to load after', maxRetries, 'retries');
                  document.getElementById('signin-component').innerHTML = 
                    '<div class="error-message">Failed to load authentication. Please refresh the page.</div>';
                  return;
                }
                console.log('Clerk not available yet, retrying...', retryCount);
                setTimeout(initializeClerk, 100);
              }
            }
            
            // Start initialization
            initializeClerk();
          }
        </script>
      </body>
      </html>
    `);
  });


  app.get("/auth/status", (req, res) => {
    try {
      const auth = getAuth(req) || {};
      const { userId, sessionId } = auth;
      
      // Return detailed auth status including session info
      return res.json({ 
        signedIn: !!userId,
        userId: userId || null,
        sessionId: sessionId || null,
        needsRefresh: false // We'll determine this based on session age
      });
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

  // Issue a signed token for WebSocket auth (ttl configurable via WS_TOKEN_TTL_SECONDS)
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

  // New endpoint to refresh session
  app.post("/auth/refresh", async (req, res) => {
    try {
      const auth = getAuth(req) || {};
      const { userId, sessionId } = auth;
      
      if (!userId) {
        return res.status(401).json({ 
          success: false, 
          error: 'No active session to refresh',
          redirectTo: '/auth'
        });
      }

      // Check if we can refresh the session
      if (sessionId) {
        try {
          // Verify the session is still valid
          const session = await clerkClient.sessions.getSession(sessionId);
          if (session && session.status === 'active') {
            return res.json({ 
              success: true, 
              message: 'Session is still valid',
              userId,
              sessionId
            });
          }
        } catch (sessionError) {
          console.log('Session verification failed, may need refresh:', sessionError.message);
        }
      }

      // If we get here, the session needs refresh
      return res.status(401).json({ 
        success: false, 
        error: 'Session expired, please sign in again',
        redirectTo: '/auth'
      });
      
    } catch (error) {
      console.error('Session refresh failed:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Session refresh failed',
        redirectTo: '/auth'
      });
    }
  });

  app.get("/logout", async (req, res) => {
    if (!CLERK_ENABLED) return res.redirect("/");
    try {
      const { sessionId } = getAuth(req) || {};
      if (sessionId) await clerkClient.sessions.revokeSession(sessionId);
    } catch {}
    // Clear any clerk session cookies
    res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    return res.redirect("/auth/signin");
  });
}

