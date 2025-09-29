/**
 * Application configuration constants loaded from environment variables.
 * This module runs dotenv at import-time so all other modules can rely on
 * process.env being populated. Only plain constants are exported.
 */
import dotenv from "dotenv";

dotenv.config();

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
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

