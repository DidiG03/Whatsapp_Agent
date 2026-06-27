import crypto from "node:crypto";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";
const csrfDisabled = process.env.CSRF_DISABLED === "1" || isTest;

const COOKIE_NAME = "_wa_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const cookieOptions = {
  sameSite: "lax",
  httpOnly: true,
  secure: isProduction,
  path: "/",
};

function readToken(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  return typeof raw === "string" && raw.length ? raw : "";
}

function submittedToken(req) {
  return (
    req.headers["x-csrf-token"] ||
    req.headers["x-xsrf-token"] ||
    req.body?._csrf ||
    req.query?._csrf ||
    ""
  );
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Stateless double-submit-cookie CSRF protection (replaces the deprecated
// `csurf`). A random token is stored in an httpOnly cookie and also embedded in
// the page (via res.locals.csrfToken). State-changing requests must echo that
// token in a header or `_csrf` field; we compare it against the cookie. A
// cross-site attacker can neither read the httpOnly cookie nor the same-origin
// embedded token, so they cannot forge a matching pair.
export function csrfProtection(req, res, next) {
  if (csrfDisabled) return next();
  if (SAFE_METHODS.has(req.method)) return next();
  const cookieToken = readToken(req);
  const provided = submittedToken(req);
  if (cookieToken && provided && safeEqual(cookieToken, provided)) {
    return next();
  }
  res.status(403);
  if (req.accepts(["json", "html"]) === "json") {
    return res.json({ error: "invalid_csrf_token" });
  }
  return res.send("Invalid CSRF token");
}

/** Paths that must not require CSRF (external webhooks, etc.). */
export function shouldSkipCsrf(req) {
  if (csrfDisabled) return true;
  const path = String(req.path || "");
  if (path === "/webhook" || path.startsWith("/webhook/")) return true;
  if (path === "/stripe/webhook") return true;
  return false;
}

export function csrfProtectionUnlessSkipped(req, res, next) {
  if (shouldSkipCsrf(req)) return next();
  return csrfProtection(req, res, next);
}

export function attachCsrfToken(req, res, next) {
  if (csrfDisabled) {
    res.locals.csrfToken = "";
    return next();
  }
  try {
    let token = readToken(req);
    if (!token) {
      token = crypto.randomBytes(32).toString("hex");
      res.cookie(COOKIE_NAME, token, cookieOptions);
    }
    res.locals.csrfToken = token;
    return next();
  } catch (error) {
    return next(error);
  }
}

export default {
  csrfProtection,
  csrfProtectionUnlessSkipped,
  attachCsrfToken,
  shouldSkipCsrf,
};
