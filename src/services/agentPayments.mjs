import Stripe from 'stripe';
import crypto from 'node:crypto';
import { AgentStripeConnection, PaymentRequest } from '../schemas/mongodb.mjs';
import { getSettingsForUser } from './settings.mjs';
import { sendWhatsAppText } from './whatsapp.mjs';
import { recordOutboundMessage } from './messages.mjs';
import { PUBLIC_BASE_URL, STRIPE_SECRET_KEY } from '../config.mjs';

const baseStripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID || null;
const CONNECT_REDIRECT_URL = process.env.STRIPE_CONNECT_REDIRECT_URL || `${PUBLIC_BASE_URL}/stripe/connect/callback`;
const CONNECT_SCOPE = process.env.STRIPE_CONNECT_SCOPE || 'read_write';
const DEFAULT_PAYMENT_CURRENCY = (process.env.AGENT_PAYMENTS_DEFAULT_CURRENCY || 'usd').toLowerCase();
const STATE_SECRET = process.env.STRIPE_CONNECT_STATE_SECRET || process.env.SESSION_TOKEN_SECRET || process.env.CLERK_SECRET_KEY || 'stripe-connect-state';
const STATE_TTL_MS = Math.max(60_000, parseInt(process.env.STRIPE_CONNECT_STATE_TTL_MS || '600000', 10));
const PAYMENT_EXPIRES_MIN = Math.max(5, parseInt(process.env.AGENT_PAYMENT_EXPIRES_MIN || '30', 10));

function ensureConnectConfigured() {
  if (!baseStripe || !CONNECT_CLIENT_ID) {
    throw new Error('Stripe Connect is not configured');
  }
}

function toB64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64Url(input) {
  let str = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function signStatePayload(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('hex');
  return toB64Url(JSON.stringify({ payload, sig }));
}

function verifyStateToken(token) {
  if (!token) return null;
  try {
    const decoded = JSON.parse(fromB64Url(token));
    const payload = decoded?.payload;
    const sig = decoded?.sig;
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', STATE_SECRET).update(JSON.stringify(payload)).digest('hex');
    if (expected !== sig) return null;
    if (!payload.uid || !payload.ts) return null;
    if (Date.now() - Number(payload.ts) > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isStripeConnectAvailable() {
  return !!(baseStripe && CONNECT_CLIENT_ID);
}

export function buildConnectState(userId, redirectTo = '/dashboard') {
  if (!userId) throw new Error('Missing user id');
  const payload = {
    uid: String(userId),
    ts: Date.now(),
    redirect: redirectTo
  };
  return signStatePayload(payload);
}

export function parseConnectState(stateToken) {
  return verifyStateToken(stateToken);
}

export function buildConnectAuthorizeUrl(userId, redirectTo = '/dashboard') {
  ensureConnectConfigured();
  const state = buildConnectState(userId, redirectTo);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CONNECT_CLIENT_ID,
    scope: CONNECT_SCOPE,
    state
  });
  if (CONNECT_REDIRECT_URL) {
    params.set('redirect_uri', CONNECT_REDIRECT_URL);
  }
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export async function completeStripeConnect(userId, code) {
  ensureConnectConfigured();
  if (!code) throw new Error('Missing authorization code');
  const tokenResponse = await baseStripe.oauth.token({
    grant_type: 'authorization_code',
    code
  });
  if (!tokenResponse?.stripe_user_id || !tokenResponse?.access_token) {
    throw new Error('Stripe did not return OAuth tokens');
  }

  const account = await baseStripe.accounts.retrieve(tokenResponse.stripe_user_id).catch(() => null);

  const doc = await AgentStripeConnection.findOneAndUpdate(
    { user_id: String(userId) },
    {
      $set: {
        user_id: String(userId),
        stripe_user_id: tokenResponse.stripe_user_id,
        stripe_account_id: account?.id || tokenResponse.stripe_user_id,
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        token_type: tokenResponse.token_type,
        scope: tokenResponse.scope,
        livemode: !!tokenResponse.livemode,
        publishable_key: tokenResponse.stripe_publishable_key,
        default_currency: (account?.default_currency || DEFAULT_PAYMENT_CURRENCY || 'usd').toLowerCase(),
        charges_enabled: !!account?.charges_enabled,
        payouts_enabled: !!account?.payouts_enabled,
        details_submitted: !!account?.details_submitted,
        business_profile: account?.business_profile || null,
        last_sync_ts: Math.floor(Date.now() / 1000),
        onboarding_url: null,
        error_message: null
      }
    },
    { new: true, upsert: true }
  );
  return doc?.toObject();
}

export async function disconnectStripeAccount(userId) {
  ensureConnectConfigured();
  if (!userId) throw new Error('Missing user');
  const record = await AgentStripeConnection.findOne({ user_id: String(userId) });
  if (!record) return { success: true };
  try {
    await baseStripe.oauth.deauthorize({
      client_id: CONNECT_CLIENT_ID,
      stripe_user_id: record.stripe_user_id
    });
  } catch (err) {
    console.error('Stripe deauthorize failed:', err?.message || err);
  }
  await AgentStripeConnection.deleteOne({ user_id: String(userId) });
  return { success: true };
}

export async function getStripeConnectStatus(userId) {
  if (!userId) return { connected: false, available: isStripeConnectAvailable() };
  const doc = await AgentStripeConnection.findOne({ user_id: String(userId) }).lean();
  if (!doc) {
    return { connected: false, available: isStripeConnectAvailable() };
  }
  return {
    connected: true,
    available: isStripeConnectAvailable(),
    account: {
      stripe_user_id: doc.stripe_user_id,
      stripe_account_id: doc.stripe_account_id,
      currency: doc.default_currency,
      charges_enabled: !!doc.charges_enabled,
      payouts_enabled: !!doc.payouts_enabled,
      details_submitted: !!doc.details_submitted,
      livemode: !!doc.livemode,
      business_profile: doc.business_profile,
      last_sync_ts: doc.last_sync_ts
    }
  };
}

function humanCurrency(amount, currency) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency?.toUpperCase() || 'USD'
    }).format(amount);
  } catch {
    return `${currency?.toUpperCase() || 'USD'} ${amount}`;
  }
}

async function sendPaymentLinkMessage({ userId, contactId, publicUrl, amount, currency, description }) {
  const cfg = await getSettingsForUser(userId);
  if (!cfg?.whatsapp_token || !cfg?.phone_number_id) {
    throw new Error('WhatsApp configuration missing. Add WhatsApp token to send payment links.');
  }
  cfg.user_id = userId;
  const prettyAmount = humanCurrency(amount, currency);
  const lines = [
    `Here is your secure payment link for ${prettyAmount}${description ? ` (${description})` : ''}.`,
    '',
    `Tap to pay: ${publicUrl}`,
    '',
    'Let us know once it is paid—thank you!'
  ];
  const body = lines.join('\n');
  const resp = await sendWhatsAppText(contactId, body, cfg);
  const outboundId = resp?.messages?.[0]?.id;
  if (outboundId) {
    try {
      await recordOutboundMessage({
        messageId: outboundId,
        userId,
        cfg,
        to: contactId,
        type: 'text',
        text: body,
        raw: { payment_request: true }
      });
      try {
        const { broadcastNewMessage } = await import('../routes/realtime.mjs');
        broadcastNewMessage(userId, String(contactId), {
          id: outboundId,
          direction: 'outbound',
          type: 'text',
          text_body: body,
          timestamp: Math.floor(Date.now() / 1000),
          contact: String(contactId),
          formatted_time: new Date().toLocaleTimeString(),
          delivery_status: 'sent',
          read_status: 'unread'
        });
      } catch (err) {
        console.error('Payment link realtime broadcast failed:', err?.message || err);
      }
    } catch (err) {
      console.error('Payment link record message failed:', err?.message || err);
    }
  }
  return outboundId;
}

function sanitizeAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) throw new Error('Enter a valid amount');
  const rounded = Math.round(num * 100) / 100;
  return Number(rounded.toFixed(2));
}

export async function createInboxPaymentRequest({ userId, contactId, amount, currency, description }) {
  if (!userId || !contactId) throw new Error('Missing user or contact');
  const connection = await AgentStripeConnection.findOne({ user_id: String(userId) }).lean();
  if (!connection) {
    throw new Error('Connect Stripe before requesting payments.');
  }
  const stripeKey = connection.access_token;
  if (!stripeKey) throw new Error('Stripe access token missing. Reconnect Stripe.');
  const connectStripe = new Stripe(stripeKey);
  const safeAmount = sanitizeAmount(amount);
  const safeCurrency = String(currency || connection.default_currency || DEFAULT_PAYMENT_CURRENCY || 'usd').toLowerCase();
  const expiresAt = Math.floor(Date.now() / 1000) + PAYMENT_EXPIRES_MIN * 60;

  const desc = description ? String(description).trim().slice(0, 140) : '';
  const requestDoc = await PaymentRequest.create({
    user_id: String(userId),
    contact_id: String(contactId),
    created_by: String(userId),
    amount: safeAmount,
    currency: safeCurrency,
    description: desc,
    status: 'pending',
    stripe_account_id: connection.stripe_account_id || connection.stripe_user_id,
    expires_at: expiresAt
  });

  const metadata = {
    payment_request_id: String(requestDoc._id),
    tenant_user_id: String(userId),
    contact_id: String(contactId),
    type: 'agent_payment'
  };

  const session = await connectStripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: safeCurrency,
        product_data: {
          name: description ? description.slice(0, 80) : 'Payment request',
        },
        unit_amount: Math.round(safeAmount * 100)
      },
      quantity: 1
    }],
    metadata,
    client_reference_id: `${userId}:${contactId}`,
    success_url: `${PUBLIC_BASE_URL}/payments/thank-you?status=success`,
    cancel_url: `${PUBLIC_BASE_URL}/payments/thank-you?status=cancelled`
  });

  // Normalize existing docs: remove null payment_intent_id so unique sparse index works as intended
  try {
    await PaymentRequest.updateMany(
      { payment_intent_id: null },
      { $unset: { payment_intent_id: "" } }
    );
  } catch (e) {
    console.error("Failed to normalize payment_intent_id nulls:", e?.message || e);
  }

  const updateSet = {
    checkout_session_id: session.id,
    payment_link_url: session.url,
    expires_at: session.expires_at || expiresAt
  };
  if (session.payment_intent) {
    updateSet.payment_intent_id = session.payment_intent;
  }

  await PaymentRequest.findByIdAndUpdate(requestDoc._id, { $set: updateSet });

  let messageId = null;
  try {
    const publicUrl = `${PUBLIC_BASE_URL}/pay/${encodeURIComponent(String(requestDoc._id))}`;
    messageId = await sendPaymentLinkMessage({
      userId,
      contactId,
      publicUrl,
      amount: safeAmount,
      currency: safeCurrency,
      description: desc
    });
  } catch (err) {
    console.error('Failed to send payment link via WhatsApp:', err?.message || err);
  }

  if (messageId) {
    await PaymentRequest.findByIdAndUpdate(requestDoc._id, { $set: { message_id: messageId } });
  }

  return {
    success: true,
    request: {
      id: String(requestDoc._id),
      amount: safeAmount,
      currency: safeCurrency,
      description: desc,
      status: 'pending',
      payment_link_url: session.url,
      expires_at: session.expires_at || expiresAt
    }
  };
}

export async function listPaymentRequests(userId, contactId, limit = 5) {
  if (!userId || !contactId) return [];
  const rows = await PaymentRequest.find({
    user_id: String(userId),
    contact_id: String(contactId)
  })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(20, limit)))
    .lean();
  return rows.map(row => ({
    id: String(row._id),
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    status: row.status,
    payment_link_url: row.payment_link_url,
    created_at: row.createdAt,
    paid_at: row.paid_at,
    expires_at: row.expires_at
  }));
}

export async function handleCheckoutSessionEvent(session, eventType) {
  if (!session?.metadata?.payment_request_id) return false;
  const requestId = session.metadata.payment_request_id;
  const update = {
    last_event_payload: session,
    payment_intent_id: session.payment_intent || session.metadata?.payment_intent_id || null,
    stripe_account_id: session.account || session.metadata?.stripe_account_id || null
  };
  if (eventType === 'completed') {
    update.status = 'paid';
    update.paid_at = Math.floor(Date.now() / 1000);
  } else if (eventType === 'expired') {
    update.status = 'expired';
  } else if (eventType === 'async_payment_failed') {
    update.status = 'failed';
  }
  await PaymentRequest.findByIdAndUpdate(requestId, { $set: update });
  return true;
}

export async function handlePaymentIntentEvent(intent, eventType) {
  if (!intent?.metadata?.payment_request_id) return false;
  const requestId = intent.metadata.payment_request_id;
  const update = {
    last_event_payload: intent,
    payment_intent_id: intent.id
  };
  if (eventType === 'succeeded') {
    update.status = 'paid';
    update.paid_at = Math.floor(Date.now() / 1000);
  } else if (eventType === 'payment_failed') {
    update.status = 'failed';
  }
  await PaymentRequest.findByIdAndUpdate(requestId, { $set: update });
  return true;
}


