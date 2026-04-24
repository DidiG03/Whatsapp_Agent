
import { logHelpers } from "../monitoring/logger.mjs";
import { getProfessionalHead, renderSidebar, renderTopbar } from "../utils.mjs";
export function requestLogger(req, res, next) {
  const start = Date.now();
  const originalSend = res.send;
  try {
    res.send = function(data) {
      const duration = Date.now() - start;
      try {
        process.stdout.write(`REQ ${req.method} ${req.url} ${res.statusCode} ${duration}ms\n`);
      } catch {}
      originalSend.call(this, data);
    };
  } catch {}
  next();
}
export function errorHandler(err, req, res, next) {
  const isDev = process.env.NODE_ENV !== "production";
  const cid = req.correlationId || req.headers["x-correlation-id"] || null;
  try { logHelpers.logError(err, { path: req.path, method: req.method, correlationId: cid }); } catch {}

  if (res.headersSent) return next(err);
  let status = Number(err?.status || err?.statusCode) || 500;
  let code = String(err?.code || "").toUpperCase();
  let type = String(err?.type || "");
  const name = String(err?.name || "");
  if (code === "EBADCSRFTOKEN" || name === "EBADCSRFTOKEN") status = 403;
  if (name === "RateLimitError") status = 429;
  if (/validation/i.test(name) || /validation/i.test(type)) status = status || 400;
  if (code === "LIMIT_FILE_SIZE") status = 413;
  if (code === "LIMIT_UNEXPECTED_FILE" || code === "LIMIT_FILE_COUNT") status = 400;
  if (/Stripe/.test(name) || /stripe/i.test(type)) status = status || 402;
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /FetchError/i.test(name)) status = status || 504;
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
  res.setHeader("x-correlation-id", cid || "");
  const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
  if (wantsJson) {
    return res.status(status).json({
      error: friendly,
      status,
      ...(isDev ? { detail: err?.message, code, type, name } : {})
    });
  }
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
export function notFoundHandler(req, res) {
  const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
  if (wantsJson) {
    return res.status(404).json({ error: "Not found" });
  }
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