
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";
import crypto from "node:crypto";
import { CLERK_AUTHORIZED_PARTIES, CLERK_ENABLED, CLERK_JWT_KEY, CLERK_PUBLISHABLE, CLERK_SECRET, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL, PUBLIC_BASE_URL } from "../config.mjs";
const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || CLERK_SECRET || "dev-secret-change";
const WS_TOKEN_TTL_SECONDS = parseInt(process.env.WS_TOKEN_TTL_SECONDS || '7200', 10);
function clerkEnabledRuntime() {
  const secret = (process.env.CLERK_SECRET_KEY || '').trim();
  if (!secret) return false;
  const pub =
    (process.env.CLERK_PUBLISHABLE_KEY || '').trim() ||
    (process.env.CLERK_PUBLISHABLE || '').trim() ||
    (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '').trim();
  return !!pub;
}

function fallbackUserId() {
  if (process.env.NODE_ENV === 'test') return 'test-user-id';
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') return null;
  const devId = (process.env.DEV_USER_ID || '').trim();
  return devId || null;
}

function fallbackEmail() {
  if (process.env.NODE_ENV === 'test') return 'test@example.com';
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') return null;
  const devEmail = (process.env.DEV_USER_EMAIL || '').trim();
  return devEmail || null;
}
const _emailCache = new Map();const EMAIL_CACHE_TTL_MS = Math.max(30_000, Number(process.env.CLERK_EMAIL_CACHE_TTL_MS || 300_000));export function initClerk(app) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) {
    console.warn("[Clerk] Disabled: missing CLERK_PUBLISHABLE_KEY or CLERK_SECRET_KEY");
    return;
  }
  const signInUrl = (CLERK_SIGN_IN_URL || "/auth/signin");
  const signUpUrl = (CLERK_SIGN_UP_URL || "/auth/signup");
  const jwtKey = CLERK_JWT_KEY || null;
  const authorizedParties = (() => {
    const fromEnv = (CLERK_AUTHORIZED_PARTIES || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (fromEnv.length) return fromEnv;
    return undefined;
  })();
  const clerkMW = clerkMiddleware({
    publishableKey: CLERK_PUBLISHABLE,
    secretKey: CLERK_SECRET,
    ...(jwtKey ? { jwtKey } : {}),
    ...(authorizedParties ? { authorizedParties } : {}),
    signInUrl,
    signUpUrl,
    afterSignInUrl: '/dashboard',
    afterSignUpUrl: '/dashboard',
  });
  app.use(clerkMW);
}
export function ensureAuthed(req, res, next) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) return next();
  try {
    const { userId, sessionId } = getAuth(req);
    if (!userId) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ 
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          redirectTo: '/auth'
        });
      }
      if (req.method === 'POST' && req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
        return res.status(401).json({ 
          error: 'Session expired, please refresh and try again',
          code: 'SESSION_EXPIRED',
          redirectTo: '/auth'
        });
      }
      const currentBaseUrl = `${req.protocol}://${req.get('host')}`;
      const redirectUrl = req.originalUrl ? `${currentBaseUrl}${req.originalUrl}` : currentBaseUrl;
      const signInUrl = `${currentBaseUrl}/auth/signin?redirect_url=${encodeURIComponent(redirectUrl)}`;
      return res.redirect(signInUrl);
    }
    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ 
        error: 'Authentication check failed',
        code: 'AUTH_ERROR',
        redirectTo: '/auth'
      });
    }
    if (req.method === 'POST' && req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      return res.status(401).json({ 
        error: 'Session expired, please refresh and try again',
        code: 'SESSION_EXPIRED',
        redirectTo: '/auth'
      });
    }
    const currentBaseUrl = `${req.protocol}://${req.get('host')}`;
    const redirectUrl = req.originalUrl ? `${currentBaseUrl}${req.originalUrl}` : currentBaseUrl;
    const signInUrl = `${currentBaseUrl}/auth/signin?redirect_url=${encodeURIComponent(redirectUrl)}`;
    return res.redirect(signInUrl);
  }
}
export function isAuthenticated(req) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) return !!fallbackUserId();
  try { return !!getAuth(req)?.userId; } catch { return false; }
}
export function getCurrentUserId(req) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) return fallbackUserId();
  try { return getAuth(req)?.userId || null; } catch { return null; }
}
export async function getSignedInEmail(req) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) return fallbackEmail();
  try {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const cached = _emailCache.get(userId);
    if (cached && cached.expMs > Date.now()) {
      return cached.email;
    }
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary = user.emailAddresses?.find(e => e.id === primaryId)?.emailAddress;
    const email = primary || user.emailAddresses?.[0]?.emailAddress || null;
    _emailCache.set(userId, { email, expMs: Date.now() + EMAIL_CACHE_TTL_MS });
    return email;
  } catch {
    return null;
  }
}

export { clerkClient };
function b64u(input) {
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64uJson(obj) { return b64u(JSON.stringify(obj)); }
function fromB64u(str){
  str = String(str||'').replace(/-/g,'+').replace(/_/g,'/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
export function signSessionToken(userId, ttlSeconds = WS_TOKEN_TTL_SECONDS) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { uid: String(userId), exp: Math.floor(Date.now()/1000) + Math.max(60, ttlSeconds) };
  const h = b64uJson(header);
  const p = b64uJson(payload);
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', SESSION_TOKEN_SECRET).update(data).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${data}.${sig}`;
}
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
export async function ensureAdmin(req, res, next) {
  if (!CLERK_ENABLED || !clerkEnabledRuntime()) {
    return next();
  }
  
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }
    const adminEmails = process.env.ADMIN_EMAILS?.split(',') || [];
    if (adminEmails.length === 0) {
      return res.status(403).json({ 
        error: 'Admin access not configured',
        code: 'ADMIN_NOT_CONFIGURED'
      });
    }
    
    const userEmail = await getSignedInEmail(req);
    if (!userEmail || !adminEmails.includes(userEmail)) {
      return res.status(403).json({ 
        error: 'Admin access required',
        code: 'ADMIN_REQUIRED'
      });
    }
    return next();
      
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ 
      error: 'Admin authentication failed',
      code: 'ADMIN_AUTH_ERROR'
    });
  }
}

