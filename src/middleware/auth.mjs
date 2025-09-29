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
import { CLERK_ENABLED, CLERK_PUBLISHABLE, CLERK_SECRET, CLERK_SIGN_IN_URL, CLERK_SIGN_UP_URL } from "../config.mjs";
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
  const clerkMWGet = clerkMiddleware({
    publishableKey: CLERK_PUBLISHABLE,
    secretKey: CLERK_SECRET,
    signInUrl: CLERK_SIGN_IN_URL,
    signUpUrl: CLERK_SIGN_UP_URL,
    enableHandshake: true,
  });
  const clerkMWNoHs = clerkMiddleware({
    publishableKey: CLERK_PUBLISHABLE,
    secretKey: CLERK_SECRET,
    signInUrl: CLERK_SIGN_IN_URL,
    signUpUrl: CLERK_SIGN_UP_URL,
    enableHandshake: true,
  });
  app.use((req, res, next) => (req.method === 'GET' ? clerkMWGet(req, res, next) : clerkMWNoHs(req, res, next)));
}

/** Require an authenticated session for protected routes. */
export function ensureAuthed(req, res, next) {
  if (!CLERK_ENABLED) return next();
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.redirect(CLERK_SIGN_IN_URL || "/auth");
    return next();
  } catch {
    return res.redirect(CLERK_SIGN_IN_URL || "/auth");
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

