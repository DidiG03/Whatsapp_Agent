/**
 * Clerk authentication middleware and helpers.
 * - initClerk(app): mounts Clerk with GET handshake only for GET requests
 * - ensureAuthed: Express guard to require a signed-in user
 * - isAuthenticated: check if request has a signed-in user
 * - getCurrentUserId: read current Clerk user id
 * - getSignedInEmail: resolve primary email of the signed-in user
 */
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";
import crypto from "node:crypto";
import { CLERK_ENABLED, CLERK_PUBLISHABLE, CLERK_SECRET, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL, PUBLIC_BASE_URL } from "../config.mjs";
const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || CLERK_SECRET || "dev-secret-change";

/**
 * Initialize Clerk middleware with GET-handshake optimization.
 * @param {import('express').Express} app
 */
export function initClerk(app) {
  if (!CLERK_ENABLED) {
    console.warn("[Clerk] Disabled: missing CLERK_PUBLISHABLE_KEY or CLERK_SECRET_KEY");
    return;
  }
  // Always provide a redirect_url so hosted Clerk pages can return to our app
  const appendRedirect = (url, baseUrl = PUBLIC_BASE_URL) => {
    if (!url) return url;
    return url.includes("redirect_url=") ? url : `${url}${url.includes("?") ? "&" : "?"}redirect_url=${encodeURIComponent(baseUrl)}`;
  };
  const signInUrl = appendRedirect(CLERK_SIGN_IN_URL || "/auth/signin");
  const signUpUrl = appendRedirect(CLERK_SIGN_UP_URL || "/auth/signup");
  // Use a single Clerk middleware for all requests to ensure consistent session handling
  const clerkMW = clerkMiddleware({
    publishableKey: CLERK_PUBLISHABLE,
    secretKey: CLERK_SECRET,
    signInUrl,
    signUpUrl,
    afterSignInUrl: '/dashboard',
    afterSignUpUrl: '/dashboard',
  });
  app.use(clerkMW);
}

/** Require an authenticated session for protected routes. */
export function ensureAuthed(req, res, next) {
  if (!CLERK_ENABLED) return next();
  try {
    const { userId, sessionId } = getAuth(req);
    if (!userId) {
      // For AJAX requests, return JSON error instead of redirect
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ 
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          redirectTo: '/auth'
        });
      }
      
      // For form submissions, try to handle gracefully
      if (req.method === 'POST' && req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
        // Return a special response that the client can handle
        return res.status(401).json({ 
          error: 'Session expired, please refresh and try again',
          code: 'SESSION_EXPIRED',
          redirectTo: '/auth'
        });
      }
      
      // Redirect to our custom signin page
      const currentBaseUrl = `${req.protocol}://${req.get('host')}`;
      const redirectUrl = req.originalUrl ? `${currentBaseUrl}${req.originalUrl}` : currentBaseUrl;
      const signInUrl = `${currentBaseUrl}/auth/signin?redirect_url=${encodeURIComponent(redirectUrl)}`;
      return res.redirect(signInUrl);
    }
    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    
    // For AJAX requests, return JSON error instead of redirect
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ 
        error: 'Authentication check failed',
        code: 'AUTH_ERROR',
        redirectTo: '/auth'
      });
    }
    
    // For form submissions, try to handle gracefully
    if (req.method === 'POST' && req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      return res.status(401).json({ 
        error: 'Session expired, please refresh and try again',
        code: 'SESSION_EXPIRED',
        redirectTo: '/auth'
      });
    }
    
    // Redirect to our custom signin page
    const currentBaseUrl = `${req.protocol}://${req.get('host')}`;
    const redirectUrl = req.originalUrl ? `${currentBaseUrl}${req.originalUrl}` : currentBaseUrl;
    const signInUrl = `${currentBaseUrl}/auth/signin?redirect_url=${encodeURIComponent(redirectUrl)}`;
    return res.redirect(signInUrl);
  }
}

/** Return true if the request is from an authenticated user. */
export function isAuthenticated(req) {
  if (!CLERK_ENABLED) return false;
  try { return !!getAuth(req)?.userId; } catch { return false; }
}

/** Get the current user's Clerk ID or null when unauthenticated. */
export function getCurrentUserId(req) {
  if (!CLERK_ENABLED) return null;
  try { return getAuth(req)?.userId || null; } catch { return null; }
}

/** Resolve the primary email address for the signed-in user. */
export async function getSignedInEmail(req) {
  if (!CLERK_ENABLED) return null;
  try {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary = user.emailAddresses?.find(e => e.id === primaryId)?.emailAddress;
    return primary || user.emailAddresses?.[0]?.emailAddress || null;
  } catch {
    return null;
  }
}

export { clerkClient };

// --------------------- Signed session token for iframes ---------------------
function b64u(input) {
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64uJson(obj) { return b64u(JSON.stringify(obj)); }
function fromB64u(str){
  str = String(str||'').replace(/-/g,'+').replace(/_/g,'/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/** Sign a short-lived session token carrying user id. */
export function signSessionToken(userId, ttlSeconds = 900) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { uid: String(userId), exp: Math.floor(Date.now()/1000) + Math.max(60, ttlSeconds) };
  const h = b64uJson(header);
  const p = b64uJson(payload);
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', SESSION_TOKEN_SECRET).update(data).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${data}.${sig}`;
}

/** Verify token and return userId (or null). */
export function verifySessionToken(token) {
  try {
    const parts = String(token||'').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const data = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', SESSION_TOKEN_SECRET).update(data).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (expected !== s) return null;
    const payload = JSON.parse(fromB64u(p));
    if (!payload?.uid || !payload?.exp) return null;
    const now = Math.floor(Date.now()/1000);
    if (now > Number(payload.exp)) return null;
    return String(payload.uid);
  } catch { return null; }
}

/** Check if the current user is an admin */
export function ensureAdmin(req, res, next) {
  if (!CLERK_ENABLED) {
    // In development, allow access if no Clerk is configured
    return next();
  }
  
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }
    
    // Check if user email is in admin list
    const adminEmails = process.env.ADMIN_EMAILS?.split(',') || [];
    if (adminEmails.length === 0) {
      // If no admin emails configured, deny access
      return res.status(403).json({ 
        error: 'Admin access not configured',
        code: 'ADMIN_NOT_CONFIGURED'
      });
    }
    
    // Get user email from Clerk
    clerkClient.users.getUser(userId)
      .then(user => {
        const userEmail = user.emailAddresses.find(email => email.id === user.primaryEmailAddressId)?.emailAddress;
        
        if (!userEmail || !adminEmails.includes(userEmail)) {
          return res.status(403).json({ 
            error: 'Admin access required',
            code: 'ADMIN_REQUIRED'
          });
        }
        
        // User is admin, proceed
        next();
      })
      .catch(error => {
        console.error('Admin check error:', error);
        return res.status(500).json({ 
          error: 'Failed to verify admin status',
          code: 'ADMIN_CHECK_ERROR'
        });
      });
      
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ 
      error: 'Admin authentication failed',
      code: 'ADMIN_AUTH_ERROR'
    });
  }
}

