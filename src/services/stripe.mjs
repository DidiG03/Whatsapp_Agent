/**
 * Stripe service for handling payments and subscriptions
 */
import Stripe from 'stripe';

// Initialize Stripe (only if API key is provided)
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Ensure a Stripe customer exists for this user. Stores the id on the user plan if created/found.
 */
export async function ensureCustomerForUser(userId, customerEmail = null) {
  if (!isStripeEnabled() || !stripe || !userId) return null;
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const { updateUserPlan } = await import('./usage.mjs');
    let plan = await UserPlan.findOne({ user_id: String(userId) }).lean();
    if (plan?.stripe_customer_id) {
      return String(plan.stripe_customer_id);
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

/**
 * Return true if the customer has a default payment method (card) set.
 */
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

/**
 * Check if Stripe is properly configured
 */
export function isStripeEnabled() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
}

/**
 * Get Stripe publishable key
 */
export function getStripePublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY;
}

/**
 * Ensure only one active subscription exists for a customer.
 * Any other active/trialing/past_due/unpaid subscriptions (except keepId) are set to cancel at period end.
 * Incomplete or incomplete_expired subs are canceled immediately to avoid clutter.
 */
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

/**
 * Create a Stripe checkout session for plan subscription
 */
export async function createCheckoutSession(userId, planName, customerEmail = null, priceId = null, promoCode = null) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }

  // Get plan details
  const planDetails = getPlanDetails(planName);
  if (!planDetails) {
    throw new Error('Invalid plan name');
  }

  // Skip checkout for free plan
  if (planName === 'free') {
    return { url: null, planName: 'free' };
  }

  try {
    // Create or retrieve Stripe customer (prefer stored customer id when available)
    let customerId = null;
    try {
      const { UserPlan } = await import('../schemas/mongodb.mjs');
      const up = await UserPlan.findOne({ user_id: String(userId) }).select('stripe_customer_id').lean();
      if (up?.stripe_customer_id) customerId = String(up.stripe_customer_id);
    } catch {}
    if (!customerId && customerEmail) {
      const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const customer = await stripe.customers.create({ email: customerEmail, metadata: { user_id: userId } });
        customerId = customer.id;
      }
    }

    // Allow env-configured Prices per plan. Falls back to STRIPE_PRICE_ID (single price) if set.
    try {
      const envKey = `STRIPE_PRICE_ID_${String(planName || '').toUpperCase()}`;
      const sanitize = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
      const priceFromEnv = sanitize(process.env[envKey] || process.env.STRIPE_PRICE_ID || '');
      if (!priceId && priceFromEnv) priceId = priceFromEnv;
    } catch {}

    // If a specific price_id is provided, try to validate it in the current account/mode.
    // If not found, fall back to inline price_data so checkout can still proceed.
    let currency = String(process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
    // Prepare optional discounts from a promotion code
    let discountsArray = undefined;
    if (promoCode) {
      try {
        const list = await stripe.promotionCodes.list({ code: String(promoCode).trim(), limit: 1 });
        const pc = list?.data?.[0];
        if (pc?.id && !pc?.expired && pc?.active !== false) {
          discountsArray = [{ promotion_code: pc.id }];
        } else {
          // If code is invalid, we still allow checkout but without discount
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
          const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [ { price: priceObj.id, quantity: 1 } ],
            mode: 'subscription',
            allow_promotion_codes: true,
            ...(discountsArray ? { discounts: discountsArray } : {}),
            success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?canceled=true`,
            metadata: { user_id: userId, plan_name: planName, price_id: priceObj.id }
          }, { idempotencyKey: `cs_${userId}_${Date.now()}` });
          return { url: session.url, sessionId: session.id, planName };
        }
      } catch (e) {
        // Known case: resource_missing -> fallback to price_data
        const msg = e?.raw?.message || e?.message || '';
        console.warn('Stripe price validation failed; falling back to price_data:', msg);
      }
    }

    // Determine currency: match existing active subscription currency if present; else from env (default usd)
    try {
      if (customerId) {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
        const existingCurrency = subs?.data?.[0]?.items?.data?.[0]?.price?.currency || subs?.data?.[0]?.plan?.currency;
        if (existingCurrency) currency = existingCurrency.toLowerCase();
      }
    } catch {}

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `${planDetails.name} Plan`,
              description: planDetails.features.join(', ')
            },
            unit_amount: planDetails.price * 100, // Convert to cents
            recurring: {
              interval: 'month'
            }
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      allow_promotion_codes: true,
      ...(discountsArray ? { discounts: discountsArray } : {}),
      success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?canceled=true`,
      metadata: {
        user_id: userId,
        plan_name: planName
      }
    }, { idempotencyKey: `cs_${userId}_${Date.now()}` });

    return { url: session.url, sessionId: session.id, planName };
  } catch (error) {
    console.error('Stripe checkout session creation failed:', error);
    throw new Error('Failed to create checkout session');
  }
}

/**
 * Create a Checkout session in "setup" mode to collect a default payment method
 * for future off-session PAYG charges.
 */
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
      // Collect a new default payment method
      payment_method_collection: 'always',
      success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?success=true`,
      cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?canceled=true`,
      metadata: { user_id: String(userId), purpose: 'payg_setup' }
    });
    return { url: session?.url || null, sessionId: session?.id || null };
  } catch (e) {
    console.error('Failed to create PAYG setup session:', e?.message || e);
    throw new Error('Failed to create setup session');
  }
}

/**
 * Charge PAYG amount for one or more usage units (e.g., messages) off-session.
 * Will be a no-op if PAYG not enabled or no payment method is available.
 */
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
      // Card might require authentication or be missing; do not block usage here
      console.warn('PAYG charge failed:', e?.message || e);
      return { charged: false, reason: 'payment_failed' };
    }
  } catch (e) {
    console.error('chargePayAsYouGo error:', e?.message || e);
    return { charged: false, reason: 'internal_error' };
  }
}

/**
 * Retrieve a checkout session
 */
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

/**
 * When a setup-mode Checkout session completes for PAYG, ensure the payment method
 * is set as default and enable PAYG on the user plan.
 */
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

/**
 * Cancel a subscription
 */
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

/**
 * Get subscription details
 */
export async function getSubscription(subscriptionId) {
  if (!isStripeEnabled() || !stripe) {
    throw new Error('Stripe is not configured');
  }

  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    console.error('Failed to retrieve subscription:', error);
    throw new Error('Failed to retrieve subscription');
  }
}

/**
 * Get subscription schedule (expanded with price objects) for a subscription.
 */
export async function getSubscriptionScheduleForSubscription(subscriptionId) {
  if (!isStripeEnabled() || !stripe) {
    return null;
  }
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['schedule'] });
    let scheduleId = null;
    try { scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null; } catch {}
    if (!scheduleId) {
      const list = await stripe.subscriptionSchedules.list({ subscription: subscriptionId, limit: 1 });
      scheduleId = list?.data?.[0]?.id || null;
    }
    if (!scheduleId) return null;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ['phases.items.price'] });
    return schedule || null;
  } catch (e) {
    console.warn('Failed to load subscription schedule:', e?.message || e);
    return null;
  }
}

/**
 * Get plan details
 */
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
      price: 29,
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

/**
 * Handle successful payment webhook
 */
export async function handleSuccessfulPayment(session) {
  const userId = session.metadata?.user_id;
  const planName = session.metadata?.plan_name;
  
  if (!userId || !planName) {
    console.error('Missing metadata in Stripe session:', session.id);
    return;
  }

  // Update user plan in database
  const { updateUserPlan } = await import('./usage.mjs');
  const { getPlanPricing } = await import('./usage.mjs');
  
  const pricing = getPlanPricing();
  const planDetails = pricing[planName];
  
  if (planDetails) {
    updateUserPlan(userId, {
      plan_name: planName,
      monthly_limit: planDetails.monthly_limit,
      whatsapp_numbers: planDetails.whatsapp_numbers,
      billing_cycle_start: Math.floor(Date.now() / 1000),
      stripe_subscription_id: session.subscription || null,
      stripe_customer_id: session.customer || null
    });
    
    console.log(`User ${userId} successfully subscribed to ${planName} plan`);

    // Ensure only one active subscription remains for this customer
    try { await ensureSingleActiveSubscription(session.customer, session.subscription); } catch (e) { console.warn('Single sub enforcement failed:', e?.message || e); }

    // Send receipt email (best-effort)
    try {
      const { sendPaymentReceiptEmail } = await import('./email.mjs');
      const amountCents = typeof session.amount_total === 'number' ? session.amount_total : planDetails.price * 100;
      await sendPaymentReceiptEmail(userId, {
        amountCents,
        currency: session.currency || (process.env.STRIPE_CURRENCY || 'usd'),
        planName,
        invoiceUrl: session?.invoice ? undefined : undefined // Checkout session may not provide invoice URL immediately
      });
    } catch (e) {
      console.error('Failed to send payment receipt email:', e?.message || e);
    }
  }
}

/**
 * Handle subscription cancellation webhook
 */
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

/**
 * Handle subscription.updated events to reflect cancel_at_period_end and schedule downgrades at period end.
 */
export async function handleSubscriptionUpdated(subscription) {
  try {
    const { UserPlan } = await import('../schemas/mongodb.mjs');
    const plan = await UserPlan.findOne({ stripe_subscription_id: subscription.id }).lean();
    if (!plan?.user_id) return;

    const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
    const currentPeriodEnd = subscription.current_period_end ? Math.floor(subscription.current_period_end) : Math.floor(Date.now()/1000);

    const { updateUserPlan } = await import('./usage.mjs');
    await updateUserPlan(plan.user_id, {
      // keep current paid plan active until the end of period
      plan_name: plan.plan_name,
      monthly_limit: plan.monthly_limit,
      whatsapp_numbers: plan.whatsapp_numbers,
      billing_cycle_start: plan.billing_cycle_start,
      stripe_customer_id: subscription.customer || plan.stripe_customer_id || null,
      stripe_subscription_id: subscription.id
    });

    if (cancelAtPeriodEnd) {
      // We don’t downgrade immediately; we mark and a background job (future) could enforce at period end.
      console.log(`Subscription ${subscription.id} set to cancel at period end (${currentPeriodEnd}). User ${plan.user_id} will be downgraded then.`);
    }
  } catch (e) {
    console.error('Failed to handle subscription update:', e?.message || e);
  }
}

/**
 * Handle invoice payment state; on failure we keep access but can flag the account, on success we ensure active status.
 */
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
      // Mark as past_due but do not downgrade yet; Stripe will retry.
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