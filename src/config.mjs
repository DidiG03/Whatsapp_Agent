
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
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
export const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
export const SMTP_USER = process.env.SMTP_USER || null;
export const SMTP_PASS = process.env.SMTP_PASS || null;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

