/**
 * Stripe service for handling payments and subscriptions
 */
import Stripe from 'stripe';

// Initialize Stripe (only if API key is provided)
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

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