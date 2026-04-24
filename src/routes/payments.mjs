import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { getVercelWebAnalyticsSnippet } from "../utils.mjs";
import {
  buildConnectAuthorizeUrl,
  parseConnectState,
  completeStripeConnect,
  disconnectStripeAccount,
  getStripeConnectStatus,
  createInboxPaymentRequest,
  listPaymentRequests,
  isStripeConnectAvailable
} from "../services/agentPayments.mjs";

function safeRedirectPath(input) {
  if (!input || typeof input !== 'string') return '/dashboard';
  if (!input.startsWith('/')) return '/dashboard';
  return input;
}

export default function registerPaymentRoutes(app) {
  app.get("/pay/:id", async (req, res) => {
    try {
      const rawId = (req.params.id || "").toString().trim();
      if (!rawId) {
        return res.status(400).send("Missing payment id");
      }
      const { PaymentRequest } = await import("../schemas/mongodb.mjs");
      const doc = await PaymentRequest.findById(rawId).lean();
      if (!doc || !doc.payment_link_url) {
        return res.status(404).send("Payment link not found");
      }
      if (['expired', 'canceled'].includes(String(doc.status || '').toLowerCase())) {
        return res.status(410).send("This payment link is no longer active.");
      }
      return res.redirect(doc.payment_link_url);
    } catch (err) {
      console.error("Payment redirect error:", err?.message || err);
      return res.status(500).send("Unable to open payment link right now.");
    }
  });
  app.get("/payments/thank-you", (req, res) => {
    const status = (req.query.status || '').toString().toLowerCase();
    const isSuccess = status === 'success';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <html>
        <head>
          <title>${isSuccess ? 'Payment received' : 'Payment cancelled'} • WhatsApp Agent</title>
          <link rel="stylesheet" href="/styles.css">
          ${getVercelWebAnalyticsSnippet()}
        </head>
        <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f1f5f9;">
          <div class="card" style="max-width:420px;">
            <div style="font-size:32px;margin-bottom:12px;text-align:center;">${isSuccess ? '✅' : '⚠️'}</div>
            <h2 style="margin:0 0 8px 0;text-align:center;">${isSuccess ? 'Payment received' : 'Payment cancelled'}</h2>
            <p style="text-align:center;color:#475569;">You can close this tab and return to the conversation.</p>
          </div>
        </body>
      </html>
    `);
  });
  app.get("/stripe/connect/start", ensureAuthed, (req, res) => {
    try {
      const redirectTo = safeRedirectPath(req.query.redirect || '/dashboard');
      const userId = getCurrentUserId(req);
      if (!isStripeConnectAvailable()) {
        return res.redirect(`${redirectTo}?stripe_error=unavailable`);
      }
      const url = buildConnectAuthorizeUrl(userId, redirectTo);
      return res.redirect(url);
    } catch (err) {
      console.error('Stripe connect start error:', err?.message || err);
      return res.redirect('/dashboard?stripe_error=start_failed');
    }
  });
  app.get("/stripe/connect/callback", ensureAuthed, async (req, res) => {
    const { code, state, error, error_description } = req.query;
    const fallback = '/dashboard';
    const payload = parseConnectState(state);
    const redirectTo = safeRedirectPath(payload?.redirect || fallback);
    const userId = getCurrentUserId(req);

    if (!payload || payload.uid !== userId) {
      return res.redirect(`${fallback}?stripe_error=state_mismatch`);
    }
    if (error) {
      return res.redirect(`${redirectTo}?stripe_error=${encodeURIComponent(error_description || error)}`);
    }
    try {
      await completeStripeConnect(userId, code);
      return res.redirect(`${redirectTo}?stripe_connected=1`);
    } catch (err) {
      console.error('Stripe connect callback error:', err?.message || err);
      return res.redirect(`${redirectTo}?stripe_error=connect_failed`);
    }
  });
  app.post("/api/payments/stripe/disconnect", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      await disconnectStripeAccount(userId);
      res.json({ success: true });
    } catch (err) {
      console.error('Stripe disconnect error:', err?.message || err);
      res.status(500).json({ success: false, error: 'disconnect_failed' });
    }
  });
  app.get("/api/payments/stripe/status", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const status = await getStripeConnectStatus(userId);
      res.json({ success: true, ...status });
    } catch (err) {
      console.error('Stripe status error:', err?.message || err);
      res.status(500).json({ success: false, error: 'status_failed' });
    }
  });
  app.post("/api/payments/request", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const contactId = (req.body?.contact || '').toString().trim();
      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_required' });
      }
      const amount = req.body?.amount;
      const currency = req.body?.currency;
      const description = req.body?.description;
      const result = await createInboxPaymentRequest({
        userId,
        contactId,
        amount,
        currency,
        description
      });
      res.json(result);
    } catch (err) {
      console.error('Payment request creation failed:', err?.message || err);
      res.status(400).json({ success: false, error: err?.message || 'payment_request_failed' });
    }
  });
  app.get("/api/payments/requests", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const contactId = (req.query?.contact || '').toString().trim();
      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_required' });
      }
      const requests = await listPaymentRequests(userId, contactId, Number(req.query?.limit) || 5);
      res.json({ success: true, requests });
    } catch (err) {
      console.error('Payment requests query failed:', err?.message || err);
      res.status(500).json({ success: false, error: 'list_failed' });
    }
  });
}

