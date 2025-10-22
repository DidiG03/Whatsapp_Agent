import { CLERK_ENABLED, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL, PUBLIC_BASE_URL } from "../config.mjs";
import { getAuth, clerkClient } from "@clerk/express";

export default function registerAuthRoutes(app) {
  app.get("/auth", (_req, res) => {
    const pub = (process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ? "configured" : "missing publishable key";
    const secret = process.env.CLERK_SECRET_KEY ? "configured" : "missing secret key";
    const baseUrl = PUBLIC_BASE_URL;
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <div class="container">
          <h2>Auth</h2>
          <p class="small">Clerk status: ${pub}</p>
          <p class="small">Secret key: ${secret}</p>
          <p class="small">Base URL: ${baseUrl}</p>
          <p class="small">Environment: ${process.env.NODE_ENV || 'development'}</p>
          <ul class="list card">
            <li><a href="${(() => { const base = CLERK_SIGN_IN_URL || 'https://accounts.clerk.com/sign-in'; return base.includes('redirect_url=') ? base : `${base}${base.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(PUBLIC_BASE_URL)}`; })()}">Sign In</a></li>
            <li><a href="${(() => { const base = CLERK_SIGN_UP_URL || 'https://accounts.clerk.com/sign-up'; return base.includes('redirect_url=') ? base : `${base}${base.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(PUBLIC_BASE_URL)}`; })()}">Sign Up</a></li>
            ${CLERK_ENABLED ? '<li><a href="/logout">Sign out</a></li>' : ''}
          </ul>
        </div>
      </body></html>
    `);
  });

  app.get("/sign-in", (_req, res) => {
    // Redirect to Clerk's hosted sign-in page
    const signInUrl = CLERK_SIGN_IN_URL || 'https://accounts.clerk.com/sign-in';
    const redirectUrl = signInUrl.includes('redirect_url=') 
      ? signInUrl 
      : `${signInUrl}${signInUrl.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(PUBLIC_BASE_URL)}`;
    res.redirect(redirectUrl);
  });

  app.get("/sign-up", (_req, res) => {
    // Redirect to Clerk's hosted sign-up page
    const signUpUrl = CLERK_SIGN_UP_URL || 'https://accounts.clerk.com/sign-up';
    const redirectUrl = signUpUrl.includes('redirect_url=') 
      ? signUpUrl 
      : `${signUpUrl}${signUpUrl.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(PUBLIC_BASE_URL)}`;
    res.redirect(redirectUrl);
  });

  app.get("/sign-out", (_req, res) => {
    // Handle sign out
    res.redirect('/logout');
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
    return res.redirect(CLERK_SIGN_IN_URL || "/");
  });
}

