
import "../config.mjs";
import Stripe from 'stripe';

function cleanEnv(v) {
  if (v === undefined || v === null) return v;
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const STRIPE_SECRET_KEY = cleanEnv(process.env.STRIPE_SECRET_KEY);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
export async function ensureCustomerForUser(userId, customerEmail = null) {
  if (!isStripeEnabled() || !stripe || !userId) return null;
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const { updateUserPlan } = await import('./usage.mjs');
    const plan = await UserPlan.findOne({ user_id: String(userId) }).lean();
    if (plan?.stripe_customer_id) {
      const storedId = String(plan.stripe_customer_id);
      try {
        await stripe.customers.retrieve(storedId);
        return storedId;
      } catch (error) {
        if (!isStripeResourceMissingError(error)) throw error;
        console.warn('Stale stripe_customer_id cleared for user', userId, storedId);
        await updateUserPlan(userId, {
          stripe_customer_id: null,
          stripe_subscription_id: null,
        });
      }
    }
    let customerId = null;
    if (customerEmail) {
      try {
        const list = await stripe.customers.list({ email: customerEmail, limit: 1 });
        if (Array.isArray(list?.data) && list.data.length > 0) {
          customerId = list.data[0].id;
        }
      } catch {}
    }
    if (!customerId) {
      const created = await stripe.customers.create({
        email: customerEmail || undefined,
        metadata: { user_id: String(userId) }
      });
      customerId = created.id;
    }
    try { await updateUserPlan(userId, { stripe_customer_id: String(customerId) }); } catch {}
    return customerId;
  } catch (e) {
    console.error('ensureCustomerForUser failed:', e?.message || e);
    return null;
  }
}
export async function hasDefaultPaymentMethod(customerId) {
  if (!isStripeEnabled() || !stripe || !customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(String(customerId), { expand: ['invoice_settings.default_payment_method'] });
    const dpm = customer?.invoice_settings?.default_payment_method;
    if (dpm && (typeof dpm === 'string' ? dpm : dpm?.id)) return true;
    const pms = await stripe.paymentMethods.list({ customer: String(customerId), type: 'card', limit: 1 });
    if (Array.isArray(pms?.data) && pms.data.length > 0) {
      try { await stripe.customers.update(String(customerId), { invoice_settings: { default_payment_method: pms.data[0].id } }); } catch {}
      return true;
    }
  } catch (e) {
    console.warn('hasDefaultPaymentMethod check failed:', e?.message || e);
  }
  return false;
}
export function isStripeEnabled() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
}
export function getStripePublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY;
}

export function planBillingSettingsUrl(query = "") {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const q = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  return `${base}/settings${q}#billing`;
}

export function formatStripeApiError(error, fallback = "Stripe request failed") {
  const code = String(error?.code || error?.raw?.code || "").toLowerCase();
  const rawMessage = String(error?.raw?.message || error?.message || "").trim();
  if (code === "api_key_expired") {
    return "Your Stripe secret key has expired. Generate a new key in the Stripe Dashboard and update STRIPE_SECRET_KEY (use sk_test_… keys for local development).";
  }
  if (error?.type === "StripeAuthenticationError" || code === "invalid_api_key") {
    return "Stripe authentication failed. Check STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in your environment.";
  }
  if (isStripeResourceMissingError(error)) {
    if (rawMessage.toLowerCase().includes("no such customer")) {
      return STALE_CUSTOMER_MESSAGE;
    }
    return STALE_SUBSCRIPTION_MESSAGE;
  }
  if (rawMessage) return rawMessage;
  return fallback;
}

export function stripeErrorHttpStatus(error) {
  const code = String(error?.code || error?.raw?.code || "").toLowerCase();
  if (code === "api_key_expired" || error?.type === "StripeAuthenticationError" || code === "invalid_api_key") {
    return 503;
  }
  const status = Number(error?.statusCode || error?.raw?.statusCode || 0);
  if (status >= 400 && status < 600) return status;
  return 502;
}

export function isStripeResourceMissingError(error) {
  const code = String(error?.code || error?.raw?.code || "").toLowerCase();
  if (code === "resource_missing") return true;
  const msg = String(error?.raw?.message || error?.message || "").toLowerCase();
  return (
    msg.includes("no such subscription") ||
    msg.includes("no such customer") ||
    msg.includes("no such schedule")
  );
}

const STALE_SUBSCRIPTION_MESSAGE =
  "Your saved subscription was not found in Stripe. This usually happens after switching between test and live API keys, or if the subscription was deleted in Stripe. Your plan has been reset to Free.";

const STALE_CUSTOMER_MESSAGE =
  "Your saved Stripe customer was not found in this Stripe account. This usually happens after switching between test and live API keys. Please try again — a new customer will be created.";

export function getSubscriptionTrialDays() {
  const raw = cleanEnv(process.env.STRIPE_TRIAL_DAYS);
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return 0;
  const configured = raw === undefined || raw === null || raw === "" ? 14 : Number(raw);
  if (!Number.isFinite(configured) || configured < 0) return 14;
  return Math.floor(configured);
}

async function customerEligibleForTrial(customerId) {
  const days = getSubscriptionTrialDays();
  if (!days || !stripe || !customerId) return 0;
  try {
    const list = await stripe.subscriptions.list({
      customer: String(customerId),
      status: "all",
      limit: 20,
    });
    const subs = Array.isArray(list?.data) ? list.data : [];
    const hadSubscription = subs.some((s) => {
      const st = String(s.status || "");
      return st !== "incomplete" && st !== "incomplete_expired";
    });
    if (hadSubscription) return 0;
  } catch (e) {
    console.warn("Trial eligibility check failed:", e?.message || e);
  }
  return days;
}

export async function getOfferedTrialDays(customerId = null) {
  const configured = getSubscriptionTrialDays();
  if (!configured) return 0;
  if (!customerId) return configured;
  return customerEligibleForTrial(customerId);
}

async function getCheckoutSubscriptionExtras(customerId) {
  const trialDays = await customerEligibleForTrial(customerId);
  if (!trialDays) return {};
  return { subscription_data: { trial_period_days: trialDays } };
}

export async function reconcileStaleStripeCustomer(userId) {
  if (!isStripeEnabled() || !stripe || !userId) {
    return { reconciled: false };
  }
  const { getUserPlan, updateUserPlan, getPlanPricing } = await import("./usage.mjs");
  const plan = await getUserPlan(userId);
  const customerId = plan?.stripe_customer_id;
  if (!customerId) return { reconciled: false };

  try {
    await stripe.customers.retrieve(String(customerId));
    return { reconciled: false };
  } catch (error) {
    if (!isStripeResourceMissingError(error)) throw error;
  }

  const pricing = getPlanPricing();
  const free = pricing.free || { monthly_limit: 100, whatsapp_numbers: 1 };
  await updateUserPlan(userId, {
    plan_name: "free",
    status: "active",
    monthly_limit: free.monthly_limit,
    whatsapp_numbers: free.whatsapp_numbers,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    billing_cycle_start: Math.floor(Date.now() / 1000),
  });

  return { reconciled: true, message: STALE_CUSTOMER_MESSAGE };
}

export async function reconcileStaleStripeBilling(userId) {
  const customerResult = await reconcileStaleStripeCustomer(userId);
  if (customerResult.reconciled) return customerResult;
  return reconcileStaleStripeSubscription(userId);
}

export async function reconcileStaleStripeSubscription(userId, subscriptionId = null) {
  if (!isStripeEnabled() || !stripe || !userId) {
    return { reconciled: false };
  }
  const { getUserPlan, updateUserPlan, getPlanPricing } = await import("./usage.mjs");
  const plan = await getUserPlan(userId);
  const subId = subscriptionId || plan?.stripe_subscription_id;
  if (!subId) return { reconciled: false };

  try {
    await stripe.subscriptions.retrieve(String(subId));
    return { reconciled: false };
  } catch (error) {
    if (!isStripeResourceMissingError(error)) throw error;
  }

  const pricing = getPlanPricing();
  const free = pricing.free || { monthly_limit: 100, whatsapp_numbers: 1 };
  await updateUserPlan(userId, {
    plan_name: "free",
    status: "active",
    monthly_limit: free.monthly_limit,
    whatsapp_numbers: free.whatsapp_numbers,
    stripe_subscription_id: null,
    billing_cycle_start: Math.floor(Date.now() / 1000),
  });

  return { reconciled: true, message: STALE_SUBSCRIPTION_MESSAGE };
}
async function ensureSingleActiveSubscription(customerId, keepId = null) {
  if (!isStripeEnabled() || !stripe || !customerId) return;
  try {
    const list = await stripe.subscriptions.list({
      customer: String(customerId),
      status: 'all',
      limit: 100
    });
    const subs = Array.isArray(list?.data) ? list.data : [];
    for (const s of subs) {
      if (keepId && s.id === keepId) continue;
      const st = String(s.status || '');
      if (st === 'active' || st === 'trialing' || st === 'past_due' || st === 'unpaid') {
        try { await stripe.subscriptions.update(s.id, { cancel_at_period_end: true }); } catch {}
      } else if (st === 'incomplete' || st === 'incomplete_expired') {
        try { await stripe.subscriptions.cancel(s.id); } catch {}
      }
    }
  } catch (e) {
    console.warn('ensureSingleActiveSubscription failed:', e?.message || e);
  }
}
export async function createCheckoutSession(userId, planName, customerEmail = null, priceId = null, promoCode = null) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }
  const planDetails = getPlanDetails(planName);
  if (!planDetails) {
    throw new Error('Invalid plan name');
  }
  if (planName === 'free') {
    return { url: null, planName: 'free' };
  }

  try {
    const customerId = await ensureCustomerForUser(userId, customerEmail);
    if (!customerId) {
      throw new Error('Failed to create Stripe customer');
    }
    try {
      const envKey = `STRIPE_PRICE_ID_${String(planName || '').toUpperCase()}`;
      const sanitize = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
      const priceFromEnv = sanitize(process.env[envKey] || process.env.STRIPE_PRICE_ID || '');
      if (!priceId && priceFromEnv) priceId = priceFromEnv;
    } catch {}
    let currency = String(process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
    let discountsArray = undefined;
    if (promoCode) {
      try {
        const list = await stripe.promotionCodes.list({ code: String(promoCode).trim(), limit: 1 });
        const pc = list?.data?.[0];
        if (pc?.id && !pc?.expired && pc?.active !== false) {
          discountsArray = [{ promotion_code: pc.id }];
        } else {
          console.warn('Promotion code not applicable or not found:', promoCode);
        }
      } catch (e) {
        console.warn('Promotion code lookup failed:', e?.message || e);
      }
    }

    if (priceId) {
      try {
        const priceObj = await stripe.prices.retrieve(priceId);
        if (priceObj?.id) {
          if (priceObj.currency) currency = String(priceObj.currency).toLowerCase();
          const subscriptionExtras = await getCheckoutSubscriptionExtras(customerId);
          const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [ { price: priceObj.id, quantity: 1 } ],
            mode: 'subscription',
            ...subscriptionExtras,
            ...(discountsArray ? { discounts: discountsArray } : { allow_promotion_codes: true }),
            success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: planBillingSettingsUrl("canceled=true"),
            metadata: { user_id: userId, plan_name: planName, price_id: priceObj.id }
          }, { idempotencyKey: `cs_${userId}_${Date.now()}` });
          return { url: session.url, sessionId: session.id, planName };
        }
      } catch (e) {
        const msg = e?.raw?.message || e?.message || '';
        console.warn('Stripe price validation failed; falling back to price_data:', msg);
      }
    }
    try {
      if (customerId) {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
        const existingCurrency = subs?.data?.[0]?.items?.data?.[0]?.price?.currency || subs?.data?.[0]?.plan?.currency;
        if (existingCurrency) currency = existingCurrency.toLowerCase();
      }
    } catch {}
    const subscriptionExtras = await getCheckoutSubscriptionExtras(customerId);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            ...(function(){
              try {
                const sanitize = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
                const productId = sanitize(process.env.STRIPE_PRODUCT_ID_STARTER || process.env.STRIPE_PRODUCT_ID || '');
                if (productId) return { product: productId };
              } catch {}
              return {
                product_data: {
                  name: `${planDetails.name} Plan`,
                  description: planDetails.features.join(', ')
                }
              };
            })(),
            unit_amount: planDetails.price * 100,            recurring: {
              interval: 'month'
            }
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      ...subscriptionExtras,
      ...(discountsArray ? { discounts: discountsArray } : { allow_promotion_codes: true }),
      success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: planBillingSettingsUrl("canceled=true"),
      metadata: {
        user_id: userId,
        plan_name: planName
      }
    }, { idempotencyKey: `cs_${userId}_${Date.now()}` });

    return { url: session.url, sessionId: session.id, planName };
  } catch (error) {
    console.error('Stripe checkout session creation failed:', error);
    const wrapped = new Error(formatStripeApiError(error, 'Failed to create checkout session'));
    wrapped.code = error?.code || error?.raw?.code;
    wrapped.stripeError = error;
    throw wrapped;
  }
}
export async function createPayAsYouGoSetupSession(userId, customerEmail = null) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }
  try {
    const customerId = await ensureCustomerForUser(userId, customerEmail);
    if (!customerId) throw new Error('Failed to create Stripe customer');
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'setup',
      payment_method_types: ['card'],
      payment_method_collection: 'always',
      success_url: planBillingSettingsUrl("success=true"),
      cancel_url: planBillingSettingsUrl("canceled=true"),
      metadata: { user_id: String(userId), purpose: 'payg_setup' }
    });
    return { url: session?.url || null, sessionId: session?.id || null };
  } catch (e) {
    console.error('Failed to create PAYG setup session:', e?.message || e);
    throw new Error('Failed to create setup session');
  }
}
export async function chargePayAsYouGo(userId, units = 1, opts = {}) {
  if (!isStripeEnabled() || !stripe) return { charged: false, reason: 'stripe_disabled' };
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const plan = await UserPlan.findOne({ user_id: String(userId) }).lean();
    if (!plan || !plan.payg_enabled) {
      return { charged: false, reason: 'payg_disabled' };
    }
    const customerId = plan.stripe_customer_id || await ensureCustomerForUser(userId, opts?.email || null);
    if (!customerId) {
      return { charged: false, reason: 'no_customer' };
    }
    const amountCents = Math.max(1, Math.floor((plan.payg_rate_cents || Number(process.env.PAYG_RATE_CENTS || 5)) * (units || 1)));
    let currency = String(plan.payg_currency || process.env.PAYG_CURRENCY || 'usd').toLowerCase();
    try {
      const test = (currency || 'usd').toUpperCase();
      if (!/^[A-Z]{3}$/.test(test)) currency = 'usd';
      else currency = test.toLowerCase();
    } catch { currency = 'usd'; }
    try {
      const intent = await stripe.paymentIntents.create({
        customer: customerId,
        amount: amountCents,
        currency,
        confirm: true,
        off_session: true,
        automatic_payment_methods: { enabled: true },
        description: `Pay-as-you-go usage charge (${units} unit${units === 1 ? '' : 's'})`,
        metadata: {
          user_id: String(userId),
          type: 'payg_usage',
          units: String(units)
        }
      }, opts?.idempotencyKey ? { idempotencyKey: String(opts.idempotencyKey) } : undefined);
      return { charged: true, payment_intent_id: intent?.id || null };
    } catch (e) {
      console.warn('PAYG charge failed:', e?.message || e);
      return { charged: false, reason: 'payment_failed' };
    }
  } catch (e) {
    console.error('chargePayAsYouGo error:', e?.message || e);
    return { charged: false, reason: 'internal_error' };
  }
}
export async function getCheckoutSession(sessionId) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }

  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error('Failed to retrieve checkout session:', error);
    throw new Error('Failed to retrieve checkout session');
  }
}
export async function handlePayAsYouGoSetupCompleted(session) {
  if (!isStripeEnabled() || !stripe) return;
  try {
    const userId = session?.metadata?.user_id;
    const purpose = session?.metadata?.purpose || '';
    if (!userId || purpose !== 'payg_setup') return;
    const customerId = session?.customer ? String(session.customer) : null;
    const setupIntentId = session?.setup_intent ? String(session.setup_intent) : null;
    let paymentMethodId = null;
    if (setupIntentId) {
      try {
        const si = await stripe.setupIntents.retrieve(setupIntentId);
        paymentMethodId = (typeof si?.payment_method === 'string' ? si.payment_method : si?.payment_method?.id) || null;
      } catch (e) {
        console.warn('Failed to retrieve setup intent:', e?.message || e);
      }
    }
    if (customerId && paymentMethodId) {
      try {
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId }
        });
      } catch (e) {
        console.warn('Failed to set default payment method:', e?.message || e);
      }
    }
    const { updateUserPlan } = await import('./usage.mjs');
    await updateUserPlan(userId, {
      payg_enabled: true,
      ...(customerId ? { stripe_customer_id: customerId } : {})
    });
  } catch (e) {
    console.error('handlePayAsYouGoSetupCompleted error:', e?.message || e);
  }
}
export async function cancelSubscription(subscriptionId) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }

  try {
    return await stripe.subscriptions.cancel(subscriptionId);
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    throw new Error('Failed to cancel subscription');
  }
}
export async function cancelBillingForUserDeletion(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { attempted: false, canceled: 0, failed: 0, results: [] };
  if (!stripe || !process.env.STRIPE_SECRET_KEY) return { attempted: false, canceled: 0, failed: 0, results: [] };

  let plan = null;
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    plan = await UserPlan.findOne({ user_id: uid })
      .select('stripe_subscription_id stripe_customer_id payg_enabled plan_name')
      .lean()
      .catch(() => null);
  } catch {
    plan = null;
  }

  const subIdFromPlan = plan?.stripe_subscription_id ? String(plan.stripe_subscription_id) : null;
  const customerId = plan?.stripe_customer_id ? String(plan.stripe_customer_id) : null;
  let subscriptionIds = [];
  if (subIdFromPlan) subscriptionIds.push(subIdFromPlan);
  if (!subscriptionIds.length && customerId) {
    try {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100
      });
      const subs = Array.isArray(list?.data) ? list.data : [];
      for (const s of subs) {
        const st = String(s?.status || '');
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(st)) {
          if (s?.id) subscriptionIds.push(String(s.id));
        }
      }
    } catch (e) {
      console.warn('[cancelBillingForUserDeletion] list subscriptions failed:', e?.message || e);
    }
  }
  subscriptionIds = [...new Set(subscriptionIds.filter(Boolean))];
  if (!subscriptionIds.length) return { attempted: false, canceled: 0, failed: 0, results: [] };
  const results = [];

  for (const subscription_id of subscriptionIds) {
    try {
      let scheduleId = null;
      try {
        const sub = await stripe.subscriptions.retrieve(subscription_id, { expand: ['schedule'] });
        scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null;
      } catch {}

      if (scheduleId) {
        await stripe.subscriptionSchedules.cancel(String(scheduleId));
      } else {
        await stripe.subscriptions.cancel(subscription_id, { prorate: false, invoice_now: false });
      }
      results.push({ subscription_id, ok: true });
    } catch (e) {
      results.push({ subscription_id, ok: false, error: String(e?.raw?.message || e?.message || e) });
    }
  }

  const canceled = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  return { attempted: true, canceled, failed, results };
}
export async function getSubscription(subscriptionId) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }

  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    console.error('Failed to retrieve subscription:', error?.message || error);
    const err = new Error(formatStripeApiError(error, 'Failed to retrieve subscription'));
    err.code = error?.code || error?.raw?.code || null;
    throw err;
  }
}
export async function getSubscriptionScheduleForSubscription(subscriptionId) {
  if (!isStripeEnabled() || !stripe) {
    return null;
  }
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['schedule'] });
    let scheduleId = null;
    try { scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null; } catch {}
    if (!scheduleId) {
      const customerId = (typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id) || null;
      if (customerId) {
        const list = await stripe.subscriptionSchedules.list({ customer: customerId, limit: 10 });
        const schedules = Array.isArray(list?.data) ? list.data : [];
        const match = schedules.find((s) => {
          try {
            const schedSub = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
            return schedSub === subscriptionId;
          } catch { return false; }
        });
        scheduleId = (match && match.id) || (schedules[0]?.id || null);
      }
    }
    if (!scheduleId) return null;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ['phases.items.price'] });
    return schedule || null;
  } catch (e) {
    console.warn('Failed to load subscription schedule:', e?.message || e);
    return null;
  }
}
function getPlanDetails(planName) {
  const plans = {
    free: {
      name: 'Free',
      price: 0,
      monthly_limit: 100,
      whatsapp_numbers: 1,
      features: [
        'Basic AI responses',
        'Email notifications',
        '1 WhatsApp number',
        'Community support'
      ]
    },
    starter: {
      name: 'Starter',
      price: 14,
      monthly_limit: 1000,
      whatsapp_numbers: 1,
      features: [
        'Advanced AI customization',
        'Email + web notifications',
        'Calendar integration',
        'Basic analytics',
        'Priority support'
      ]
    }
  };

  return plans[planName] || null;
}

async function claimCheckoutSession(sessionId, userId) {
  if (!sessionId) return false;
  try {
    const { getDB } = await import("../db-mongodb.mjs");
    const db = getDB();
    const existing = await db.collection("stripe_checkout_sessions").findOneAndUpdate(
      { session_id: String(sessionId) },
      {
        $setOnInsert: {
          session_id: String(sessionId),
          user_id: String(userId),
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "before" }
    );
    return !existing;
  } catch (e) {
    console.error("claimCheckoutSession error:", e?.message || e);
    return false;
  }
}

export async function handleSuccessfulPayment(session) {
  const sessionId = session?.id;
  const userId = session.metadata?.user_id;
  const planName = session.metadata?.plan_name;

  if (!userId || !planName) {
    console.error("Missing metadata in Stripe session:", sessionId);
    return { ok: false, reason: "missing_metadata" };
  }
  if (!sessionId) {
    console.error("Missing session id in Stripe checkout session");
    return { ok: false, reason: "missing_session_id" };
  }

  const claimed = await claimCheckoutSession(sessionId, userId);
  if (!claimed) {
    return { ok: true, alreadyProcessed: true };
  }

  const { updateUserPlan, getPlanPricing } = await import("./usage.mjs");

  const pricing = getPlanPricing();
  const planDetails = pricing[planName];

  if (!planDetails) {
    return { ok: false, reason: "invalid_plan" };
  }

  await updateUserPlan(userId, {
    plan_name: planName,
    status: "active",
    monthly_limit: planDetails.monthly_limit,
    whatsapp_numbers: planDetails.whatsapp_numbers,
    billing_cycle_start: Math.floor(Date.now() / 1000),
    stripe_subscription_id: session.subscription || null,
    stripe_customer_id: session.customer || null,
  });

  console.log(`User ${userId} successfully subscribed to ${planName} plan`);
  try {
    await ensureSingleActiveSubscription(session.customer, session.subscription);
  } catch (e) {
    console.warn("Single sub enforcement failed:", e?.message || e);
  }
  try {
    const amountCents =
      typeof session.amount_total === "number" ? session.amount_total : planDetails.price * 100;
    if (amountCents > 0) {
      const { sendPaymentReceiptEmail } = await import("./email.mjs");
      await sendPaymentReceiptEmail(userId, {
        amountCents,
        currency: session.currency || process.env.STRIPE_CURRENCY || "usd",
        planName,
        invoiceUrl: session?.invoice ? undefined : undefined,
      });
    }
  } catch (e) {
    console.error("Failed to send payment receipt email:", e?.message || e);
  }

  return { ok: true, alreadyProcessed: false };
}
export async function handleSubscriptionCanceled(subscription) {
  const customerId = subscription.customer;
  const subId = subscription.id;
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const plan = await UserPlan.findOne({ $or: [ { stripe_subscription_id: subId }, { stripe_customer_id: customerId } ] }).lean();
    if (plan?.user_id) {
      const { updateUserPlan } = await import('./usage.mjs');
      await updateUserPlan(plan.user_id, {
        plan_name: 'free',
        monthly_limit: 100,
        whatsapp_numbers: 1,
        billing_cycle_start: Math.floor(Date.now() / 1000),
        stripe_subscription_id: null
      });
      console.log(`User ${plan.user_id} subscription canceled, downgraded to free plan`);
    }
  } catch (e) {
    console.error('Failed to handle subscription cancellation:', e?.message || e);
  }
}
export async function handleSubscriptionUpdated(subscription) {
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const plan = await UserPlan.findOne({ stripe_subscription_id: subscription.id }).lean();
    if (!plan?.user_id) return;

    const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
    const currentPeriodEnd = subscription.current_period_end ? Math.floor(subscription.current_period_end) : Math.floor(Date.now()/1000);

    const stripeStatus = String(subscription.status || '').toLowerCase();
    let planStatus = String(plan.status || 'active').toLowerCase();
    if (stripeStatus === 'active' || stripeStatus === 'trialing') {
      planStatus = 'active';
    } else if (stripeStatus === 'past_due') {
      planStatus = 'past_due';
    } else if (stripeStatus === 'unpaid') {
      planStatus = 'unpaid';
    }

    const { updateUserPlan } = await import('./usage.mjs');
    await updateUserPlan(plan.user_id, {
      plan_name: plan.plan_name,
      status: planStatus,
      monthly_limit: plan.monthly_limit,
      whatsapp_numbers: plan.whatsapp_numbers,
      billing_cycle_start: plan.billing_cycle_start,
      stripe_customer_id: subscription.customer || plan.stripe_customer_id || null,
      stripe_subscription_id: subscription.id
    });

    if (cancelAtPeriodEnd) {
      console.log(`Subscription ${subscription.id} set to cancel at period end (${currentPeriodEnd}). User ${plan.user_id} will be downgraded then.`);
    }
  } catch (e) {
    console.error('Failed to handle subscription update:', e?.message || e);
  }
}
export async function handleInvoicePaymentState(invoice, succeeded) {
  try {
    const subId = invoice.subscription;
    if (!subId) return;
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const plan = await UserPlan.findOne({ stripe_subscription_id: subId }).lean();
    if (!plan?.user_id) return;
    const { updateUserPlan } = await import('./usage.mjs');
    if (succeeded) {
      await updateUserPlan(plan.user_id, { status: 'active' });
      try {
        const { sendPaymentReceiptEmail } = await import('./email.mjs');
        await sendPaymentReceiptEmail(plan.user_id, {
          amountCents: invoice.amount_paid ?? invoice.amount_due,
          currency: invoice.currency,
          planName: plan.plan_name,
          invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf
        });
      } catch (e) {
        console.error('Failed to send invoice success email:', e?.message || e);
      }
    } else {
      await updateUserPlan(plan.user_id, { status: 'past_due' });
      try {
        const { sendPaymentFailedEmail } = await import('./email.mjs');
        await sendPaymentFailedEmail(plan.user_id, {
          amountCents: invoice.amount_due,
          currency: invoice.currency,
          planName: plan.plan_name,
          reason: invoice.last_payment_error?.message || invoice.collection_method || 'payment_failed'
        });
      } catch (e) {
        console.error('Failed to send invoice failure email:', e?.message || e);
      }
    }
  } catch (e) {
    console.error('Failed to handle invoice payment state:', e?.message || e);
  }
}