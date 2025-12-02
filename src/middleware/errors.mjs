/**
 * Error handling middleware and request logging utilities (graceful).
 * - requestLogger: lightweight request timing (fallback; primary logging handled in monitoring/logger.mjs)
 * - notFoundHandler: friendly 404 for unknown routes
 * - errorHandler: maps common failures to friendly messages with proper status codes
 * - wrapAsync: helper to capture async errors and pass to next()
 */
import { logHelpers } from "../monitoring/logger.mjs";
import { getProfessionalHead, renderSidebar, renderTopbar } from "../utils.mjs";

/**
 * Request logger middleware - logs incoming requests
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const originalSend = res.send;
  try {
    res.send = function(data) {
      const duration = Date.now() - start;
      try {
        // Lightweight structured line to avoid pulling main logger
        // Keeps compatibility where monitoring logger is not mounted
        process.stdout.write(`REQ ${req.method} ${req.url} ${res.statusCode} ${duration}ms\n`);
      } catch {}
      originalSend.call(this, data);
    };
  } catch {}
  next();
}

/**
 * Friendly mapping of errors to HTTP status and user-facing messages.
 * Adds x-correlation-id header when available.
 */
export function errorHandler(err, req, res, next) {
  const isDev = process.env.NODE_ENV !== "production";
  const cid = req.correlationId || req.headers["x-correlation-id"] || null;

  // Log with context
  try { logHelpers.logError(err, { path: req.path, method: req.method, correlationId: cid }); } catch {}

  if (res.headersSent) return next(err);

  // Status mapping
  let status = Number(err?.status || err?.statusCode) || 500;
  let code = String(err?.code || "").toUpperCase();
  let type = String(err?.type || "");
  const name = String(err?.name || "");

  // CSRF
  if (code === "EBADCSRFTOKEN" || name === "EBADCSRFTOKEN") status = 403;
  // Rate limit (express-rate-limit attaches statusCode)
  if (name === "RateLimitError") status = 429;
  // Validation (Joi/Zod or custom)
  if (/validation/i.test(name) || /validation/i.test(type)) status = status || 400;
  // Multer (uploads)
  if (code === "LIMIT_FILE_SIZE") status = 413;
  if (code === "LIMIT_UNEXPECTED_FILE" || code === "LIMIT_FILE_COUNT") status = 400;
  // Stripe errors
  if (/Stripe/.test(name) || /stripe/i.test(type)) status = status || 402;
  // Upstream/network
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /FetchError/i.test(name)) status = status || 504;

  // Message mapping (safe)
  const friendly = (() => {
    if (status === 403 && (code === "EBADCSRFTOKEN" || name === "EBADCSRFTOKEN")) return "Session expired. Please refresh the page and try again.";
    if (status === 413) return "The file is too large. Please upload a smaller file.";
    if (status === 429) return "Too many requests. Please slow down and try again shortly.";
    if (status === 401) return "You need to sign in to continue.";
    if (status === 402) return "There was a problem with the payment. Please check your payment method.";
    if (status === 400) return "The data provided is invalid. Please review and try again.";
    if (status === 504) return "Our upstream service took too long to respond. Please try again.";
    if (status === 503) return "Service temporarily unavailable. Please try again in a moment.";
    return isDev ? (err?.message || "An unexpected error occurred.") : "Something went wrong. Please try again.";
  })();

  // Negotiate response
  res.setHeader("x-correlation-id", cid || "");
  const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
  if (wantsJson) {
    return res.status(status).json({
      error: friendly,
      status,
      ...(isDev ? { detail: err?.message, code, type, name } : {})
    });
  }
  // Simple HTML fallback (no leaking internals in prod)
  res.status(status).send(`
    <html><head><title>Error</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <div class="container">
          <div class="layout"><main class="main"><div class="main-content">
            <div class="card">
              <h3 style="margin-top:0;">Oops</h3>
              <p>${escapeHtmlSafe(friendly)}</p>
              ${cid ? `<div class="small" style="color:#6b7280;">Reference: ${escapeHtmlSafe(String(cid))}</div>` : ""}
              <a href="/" class="btn btn-ghost" style="margin-top:8px;">Back to Home</a>
            </div>
          </div></main></div>
        </div>
      </body>
    </html>
  `);
}

/** 404 for unknown routes (mount before errorHandler) */
export function notFoundHandler(req, res) {
  const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
  if (wantsJson) {
    return res.status(404).json({ error: "Not found" });
  }
  // Simple branded 404 page
  res.status(404).send(`
    <html>${getProfessionalHead('Not Found')}<body>
      <div class="container">
        ${renderTopbar('Not Found', '')}
        <div class="layout">
          ${renderSidebar('dashboard', {})}
          <main class="main">
            <div class="main-content">
              <div class="card" style="max-width:720px;margin:20px auto;">
                <div style="font-size:64px; line-height:1; font-weight:800; color:#111827; letter-spacing:-1px; margin:0 0 10px 0;">404</div>
                <h3 style="margin:0 0 6px 0;">Page not found</h3>
                <p class="small" style="color:#6b7280; margin:0 0 10px 0;">
                  The page you were looking for doesn’t exist or may have moved.
                </p>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                  <a class="btn btn-primary" href="/dashboard">Go to Dashboard</a>
                  <a class="btn btn-ghost" href="/">Home</a>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </body></html>
  `);
}

/** Wrap async route handlers to forward errors to errorHandler. */
export function wrapAsync(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function escapeHtmlSafe(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}