
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
if (!process.env.VERCEL) {
  const envLocalPath = path.resolve(process.cwd(), '.env.local');
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
  } else if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
} else {
  console.log('Running in Vercel environment - using environment variables from Vercel');
}
(() => {
  const UNQUOTE = /^(['"])([\s\S]*)\1$/;
  const cleaned = [];
  for (const k of Object.keys(process.env)) {
    const v = process.env[k];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    const m = trimmed.match(UNQUOTE);
    const next = m ? m[2].trim() : trimmed;
    if (next !== v) {
      process.env[k] = next;
      cleaned.push(k);
    }
  }
  if (cleaned.length && process.env.DEBUG_LOGS === '1') {
    console.log('[config] Sanitized env vars (stripped surrounding quotes/whitespace):', cleaned.join(', '));
  }
})();
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

export const PORT = process.env.PORT || 3000;
export const IS_VERCEL = Boolean(process.env.VERCEL);
export const VERCEL_ENV = process.env.VERCEL_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
export const CLERK_PUBLISHABLE = process.env.CLERK_PUBLISHABLE || process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || null;

export const CLERK_SECRET = process.env.CLERK_SECRET_KEY || null;

export const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE && CLERK_SECRET);
export const CLERK_JWT_KEY =
  process.env.CLERK_JWT_KEY ||
  process.env.CLERK_JWT_PUBLIC_KEY ||
  process.env.CLERK_JWT_VERIFICATION_KEY ||
  null;
export const CLERK_AUTHORIZED_PARTIES = process.env.CLERK_AUTHORIZED_PARTIES || null;
if (CLERK_PUBLISHABLE) process.env.CLERK_PUBLISHABLE_KEY = CLERK_PUBLISHABLE;
if (CLERK_SECRET) process.env.CLERK_SECRET_KEY = CLERK_SECRET;
export const CLERK_SIGN_IN_URL = process.env.CLERK_SIGN_IN_URL;

export const CLERK_SIGN_UP_URL = process.env.CLERK_SIGN_UP_URL;
export const STATIC_DIR = "public";
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);
export const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || null;
export const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || null;
export const META_EMBEDDED_SIGNUP_CONFIG_ID =
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID
  || process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID
  || null;
export const META_GRAPH_VERSION = (process.env.META_GRAPH_VERSION || "v21.0").trim();
export const META_EMBEDDED_SIGNUP_ENABLED = Boolean(
  META_APP_ID && META_APP_SECRET && META_EMBEDDED_SIGNUP_CONFIG_ID
);
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
export const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
export const SMTP_USER = process.env.SMTP_USER || null;
export const SMTP_PASS = process.env.SMTP_PASS || null;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

/** Fail fast in production when signing secrets would fall back to dev defaults. */
export function assertProductionSecrets() {
  if (process.env.NODE_ENV === 'test') return;
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!isProd) return;

  const sessionSecret = (process.env.SESSION_TOKEN_SECRET || '').trim();
  const clerkSecret = (process.env.CLERK_SECRET_KEY || process.env.CLERK_SECRET || '').trim();
  const effectiveSession = sessionSecret || clerkSecret;

  if (!effectiveSession || effectiveSession === 'dev-secret-change') {
    throw new Error('[security] Set SESSION_TOKEN_SECRET or CLERK_SECRET_KEY in production');
  }

  const mediaSecret = (process.env.MEDIA_SIGN_SECRET || sessionSecret || clerkSecret || '').trim();
  if (!mediaSecret || mediaSecret === 'dev-media-secret') {
    throw new Error('[security] Set MEDIA_SIGN_SECRET or SESSION_TOKEN_SECRET in production');
  }
}

