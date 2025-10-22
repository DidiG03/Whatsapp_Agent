/**
 * Application configuration constants loaded from environment variables.
 * This module runs dotenv at import-time so all other modules can rely on
 * process.env being populated. Only plain constants are exported.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Only load .env file if it exists and we're not in Vercel
if (!process.env.VERCEL && fs.existsSync('.env')) {
  dotenv.config();
} else if (process.env.VERCEL) {
  console.log('Running in Vercel environment - using environment variables from Vercel');
}

/** Log verbosity level used by pino logger. */
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
/** Port the HTTP server listens on. */
export const PORT = process.env.PORT || 3000;

/** Clerk publishable key, if configured (can also come from NEXT_PUBLIC_ variant). */
export const CLERK_PUBLISHABLE = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || null;
/** Clerk secret key, required for server-side auth. */
export const CLERK_SECRET = process.env.CLERK_SECRET_KEY || null;
/** Convenience flag indicating whether Clerk auth is enabled. */
export const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE && CLERK_SECRET);

// Ensure Clerk SDK sees keys even if only NEXT_PUBLIC_* was provided
if (CLERK_PUBLISHABLE) process.env.CLERK_PUBLISHABLE_KEY = CLERK_PUBLISHABLE;
if (CLERK_SECRET) process.env.CLERK_SECRET_KEY = CLERK_SECRET;

/** Hosted Clerk sign-in URL (optional). */
export const CLERK_SIGN_IN_URL = process.env.CLERK_SIGN_IN_URL;
/** Hosted Clerk sign-up URL (optional). */
export const CLERK_SIGN_UP_URL = process.env.CLERK_SIGN_UP_URL;

/** Directory path used to serve static assets. */
export const STATIC_DIR = "public";

/** Public base URL used for links sent to users (e.g., ICS downloads). */
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 
  (process.env.VERCEL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);

/** Email/SMTP configuration for notifications */
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
export const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
export const SMTP_USER = process.env.SMTP_USER || null;
export const SMTP_PASS = process.env.SMTP_PASS || null;

/** Stripe configuration for payments */
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

