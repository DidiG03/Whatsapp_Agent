import "../config.mjs";
import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { createCheckoutSession, getCheckoutSession, handleSuccessfulPayment, handleSubscriptionCanceled, isStripeEnabled } from "../services/stripe.mjs";
import { getUserPlan } from "../services/usage.mjs";
import { handleCheckoutSessionEvent as handleAgentCheckoutSessionEvent, handlePaymentIntentEvent as handleAgentPaymentIntentEvent } from "../services/agentPayments.mjs";
import { updateUserPlan } from "../services/usage.mjs";
import { renderSidebar, renderTopbar } from "../utils.mjs";
import Stripe from 'stripe';
import crypto from 'node:crypto';

function cleanEnv(v) {
  if (v === undefined || v === null) return v;
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  return s;
}
const STRIPE_SECRET_KEY = cleanEnv(process.env.STRIPE_SECRET_KEY);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

export default function registerStripeRoutes(app) {
  app.post("/stripe/create-checkout", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { plan_name, price_id, promo_code } = req.body;
    const email = await getSignedInEmail(req);
    
    if (!plan_name || !['free', 'starter'].includes(plan_name)) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }
    
    try {
      const currentPlan = await getUserPlan(userId);
      const subId = currentPlan?.stripe_subscription_id;
      if (subId && stripe) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const status = String(sub?.status || '');
          if (status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid') {
            return res.status(409).json({
              error: 'You already have an active subscription. You can change plans after the current period ends.',
              current_period_end: sub?.current_period_end || null,
              cancel_at_period_end: !!sub?.cancel_at_period_end
            });
          }
        } catch (e) {
        }
      }

      const result = await createCheckoutSession(userId, plan_name, email, price_id, promo_code);
      
      if (plan_name === 'free') {
        updateUserPlan(userId, {
          plan_name: 'free',
          monthly_limit: 100,
          whatsapp_numbers: 1,
          billing_cycle_start: Math.floor(Date.now() / 1000)
        });
        
        return res.json({ success: true, message: 'Plan updated to Free' });
      }
      
      return res.json({ 
        success: true, 
        checkout_url: result.url,
        session_id: result.sessionId 
      });
    } catch (error) {
      console.error('Checkout session creation failed:', {
        message: error?.message,
        type: error?.type,
        code: error?.code,
        statusCode: error?.statusCode,
        raw: error?.raw,
        stack: error?.stack,
        userId,
        plan_name,
        price_id,
        has_secret: !!process.env.STRIPE_SECRET_KEY,
        has_publishable: !!process.env.STRIPE_PUBLISHABLE_KEY,
        configured_price_env: process.env[`STRIPE_PRICE_ID_${String(plan_name || '').toUpperCase()}`] || process.env.STRIPE_PRICE_ID || null
      });
      const stripeMsg = error?.raw?.message || error?.message || 'Unknown error';
      const code = error?.code || error?.type || null;
      return res.status(500).json({
        error: 'Failed to create checkout session',
        detail: stripeMsg,
        code
      });
    }
  });
  app.post("/stripe/cancel-scheduled-change", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!stripe || !isStripeEnabled()) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    try {
      const currentPlan = await getUserPlan(userId);
      const subId = currentPlan?.stripe_subscription_id;
      if (!subId) return res.status(400).json({ error: 'No active subscription found' });
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ['schedule'] });
      let scheduleId = null;
      try { scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null; } catch {}
      if (!scheduleId) {
        const list = await stripe.subscriptionSchedules.list({ subscription: subId, limit: 1 });
        scheduleId = list?.data?.[0]?.id || null;
      }
      if (!scheduleId) {
        return res.json({ success: true, message: 'No schedule found' });
      }
      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ['phases.items.price'] });
      const nowTs = Math.floor(Date.now() / 1000);
      const existingPhases = Array.isArray(schedule.phases) ? schedule.phases : [];
      const currentPhase = existingPhases.find(p => !p.end_date || Number(p.end_date) > nowTs) || existingPhases[0];
      if (!currentPhase) {
        try { await stripe.subscriptionSchedules.release(scheduleId); } catch {}
        return res.json({ success: true, released: true });
      }
      const hasFuture = existingPhases.some(p => Number(p.start_date || 0) > nowTs);
      if (!hasFuture) {
        try { await stripe.subscriptionSchedules.release(scheduleId); } catch {}
        return res.json({ success: true, released: true });
      }
      const preserved = {
        items: (currentPhase.items || []).map(it => ({ price: (typeof it.price === 'string' ? it.price : it.price?.id), quantity: Number(it.quantity || 1) || 1 })),
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date || sub?.current_period_end || undefined
      };
      const upd = await stripe.subscriptionSchedules.update(scheduleId, { phases: [preserved], end_behavior: 'release' });
      return res.json({ success: true, message: 'Scheduled change canceled', schedule_id: upd?.id || scheduleId });
    } catch (error) {
      console.error('Failed to cancel scheduled change:', error);
      return res.status(500).json({ error: 'Failed to cancel scheduled change' });
    }
  });
  app.post("/stripe/schedule-plan-change", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { target_interval, plan_name } = req.body || {};
    if (!stripe || !isStripeEnabled()) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    if (!target_interval || !['month','year'].includes(String(target_interval))) {
      return res.status(400).json({ error: 'Invalid target interval' });
    }
    const targetInterval = String(target_interval);
    const planName = String(plan_name || 'starter');
    if (!['starter'].includes(planName)) {
      return res.status(400).json({ error: 'Unsupported plan for scheduled changes' });
    }
    try {
      const currentPlan = await getUserPlan(userId);
      const subId = currentPlan?.stripe_subscription_id;
      if (!subId) {
        return res.status(400).json({ error: 'No active subscription found' });
      }
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
      const currentItem = sub?.items?.data?.[0];
      const currentPriceId = currentItem?.price?.id;
      const currentInterval = currentItem?.price?.recurring?.interval || null;
      if (!currentPriceId || !currentInterval) {
        return res.status(400).json({ error: 'Could not determine current subscription price' });
      }
      if (currentInterval === targetInterval) {
        return res.status(400).json({ error: 'Already on requested interval' });
      }
      function sanitize(v){ return String(v || '').trim().replace(/^['"]|['"]$/g,''); }
      const monthlyPrice = sanitize(process.env.STRIPE_PRICE_ID_STARTER_MONTHLY || process.env.STRIPE_PRICE_ID_STARTER || process.env.STRIPE_PRICE_ID || '');
      const yearlyPrice = sanitize(process.env.STRIPE_PRICE_ID_STARTER_YEARLY || process.env.STRIPE_PRICE_ID_STARTER_ANNUAL || process.env.STRIPE_PRICE_ID_STARTER_YEAR || '');
      const targetPriceId = targetInterval === 'year' ? yearlyPrice : monthlyPrice;
      if (!targetPriceId) {
        return res.status(500).json({ error: 'Target price is not configured in environment' });
      }
      let schedule = null;
      let scheduleId = null;
      try {
        scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null;
      } catch {}
      if (!scheduleId) {
        try {
          const existing = await stripe.subscriptionSchedules.list({ subscription: subId, limit: 1 });
          scheduleId = existing?.data?.[0]?.id || null;
          schedule = existing?.data?.[0] || null;
        } catch {}
      } else {
        try { schedule = await stripe.subscriptionSchedules.retrieve(scheduleId); } catch {}
      }
      const nowTs = Math.floor(Date.now() / 1000);
      let phases;
      if (schedule) {
        const existingPhases = Array.isArray(schedule.phases) ? schedule.phases : [];
        const currentPhase = existingPhases.find(p => !p.end_date || Number(p.end_date) > nowTs) || existingPhases[existingPhases.length - 1];
        const preserved = currentPhase ? {
          items: (currentPhase.items || []).map(it => ({ price: (typeof it.price === 'string' ? it.price : it.price?.id), quantity: Number(it.quantity || 1) || 1 })),
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date || sub?.current_period_end || undefined
        } : {
          items: [ { price: currentPriceId, quantity: 1 } ],
          start_date: nowTs,
          end_date: sub?.current_period_end || undefined
        };
        phases = [
          preserved,
          { items: [ { price: targetPriceId, quantity: 1 } ] }
        ];
      } else {
        let currentEnd = Number(sub?.current_period_end || 0) || nowTs;
        if (currentEnd <= nowTs) currentEnd = nowTs + 1;        phases = [
          { items: [ { price: currentPriceId, quantity: 1 } ], start_date: nowTs, end_date: currentEnd },
          { items: [ { price: targetPriceId, quantity: 1 } ] }
        ];
      }
      if (!scheduleId) {
        schedule = await stripe.subscriptionSchedules.create({ from_subscription: subId });
        scheduleId = schedule?.id;
      }
      schedule = await stripe.subscriptionSchedules.update(scheduleId, { phases });
      return res.json({
        success: true,
        message: 'Plan change scheduled for next billing period',
        current_interval: currentInterval,
        target_interval: targetInterval,
        current_period_end: sub?.current_period_end || null,
        schedule_id: schedule?.id || null
      });
    } catch (error) {
      console.error('Failed to schedule plan change:', error);
      return res.status(500).json({ error: 'Failed to schedule plan change' });
    }
  });
  app.get("/stripe/success", ensureAuthed, async (req, res) => {
    const { session_id } = req.query;
    
    if (!session_id) {
      return res.redirect('/plan?error=no_session_id');
    }
    
    try {
      const session = await getCheckoutSession(session_id);
      
      if (session.payment_status === 'paid') {
        await handleSuccessfulPayment(session);
        return res.redirect('/plan?success=true');
      } else {
        return res.redirect('/plan?error=payment_not_completed');
      }
    } catch (error) {
      console.error('Failed to process successful payment:', error);
      return res.redirect('/plan?error=processing_failed');
    }
  });
  app.get("/stripe/cancel", ensureAuthed, async (req, res) => {
    return res.redirect('/plan?canceled=true');
  });
  app.post("/stripe/customer-portal", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!isStripeEnabled() || !stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    try {
      const { getUserPlan, updateUserPlan } = await import("../services/usage.mjs");
      const plan = await getUserPlan(userId);
      let customerId = plan?.stripe_customer_id || null;
      if (!customerId && plan?.stripe_subscription_id) {
        try {
          const sub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
          customerId = sub?.customer || null;
          if (customerId) {
            try { await updateUserPlan(userId, { stripe_customer_id: String(customerId) }); } catch {}
          }
        } catch {}
      }
      if (!customerId) {
        return res.status(400).json({ error: 'No Stripe customer found for this account' });
      }
      const returnUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan`;
      const session = await stripe.billingPortal.sessions.create({
        customer: String(customerId),
        return_url: returnUrl
      });
      return res.json({ success: true, url: session?.url || null });
    } catch (error) {
      console.error('Failed to create billing portal session:', error?.message || error);
      return res.status(500).json({ error: 'Failed to create billing portal session' });
    }
  });
  app.post("/stripe/webhook", async (req, res) => {
    if (!isStripeEnabled() || !stripe) {
      console.error('Stripe is not configured');
      return res.status(400).send('Stripe not configured');
    }
    
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!endpointSecret) {
      console.error('Stripe webhook secret not configured');
      return res.status(400).send('Webhook secret not configured');
    }

    let event;
    
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        if (session.metadata?.payment_request_id) {
          try { await handleAgentCheckoutSessionEvent(session, 'completed'); } catch (err) { console.error('Agent payment complete handler failed:', err?.message || err); }
        } else if (session.mode === 'subscription') {
          await handleSuccessfulPayment(session);
        } else if (session.mode === 'setup' && session.metadata?.purpose === 'payg_setup') {
          try {
            const { handlePayAsYouGoSetupCompleted } = await import('../services/stripe.mjs');
            await handlePayAsYouGoSetupCompleted(session);
          } catch (e) {
            console.error('PAYG setup completion handler failed:', e?.message || e);
          }
        }
        break;
      case 'checkout.session.expired':
        try { await handleAgentCheckoutSessionEvent(event.data.object, 'expired'); } catch (err) { console.error('Agent payment expired handler failed:', err?.message || err); }
        break;
      case 'checkout.session.async_payment_failed':
        try { await handleAgentCheckoutSessionEvent(event.data.object, 'async_payment_failed'); } catch (err) { console.error('Agent payment async failure handler failed:', err?.message || err); }
        break;
        
      case 'customer.subscription.updated':
        try {
          const { handleSubscriptionUpdated } = await import('../services/stripe.mjs');
          await handleSubscriptionUpdated(event.data.object);
        } catch (e) {
          console.error('Failed to handle subscription.updated:', e?.message || e);
        }
        break;
        
      case 'customer.subscription.deleted':
        try {
          const subscriptionDeleted = event.data.object;
          await handleSubscriptionCanceled(subscriptionDeleted);
        } catch (e) {
          console.error('Failed to handle subscription.deleted:', e?.message || e);
        }
        break;
        
      case 'invoice.payment_succeeded':
        try {
          const { handleInvoicePaymentState } = await import('../services/stripe.mjs');
          await handleInvoicePaymentState(event.data.object, true);
        } catch (e) {
          console.error('Failed to handle invoice.payment_succeeded:', e?.message || e);
        }
        break;
        
      case 'invoice.payment_failed':
        try {
          const { handleInvoicePaymentState } = await import('../services/stripe.mjs');
          await handleInvoicePaymentState(event.data.object, false);
        } catch (e) {
          console.error('Failed to handle invoice.payment_failed:', e?.message || e);
        }
        break;
      case 'payment_intent.succeeded':
        try { await handleAgentPaymentIntentEvent(event.data.object, 'succeeded'); } catch (err) { console.error('Agent payment intent success handler failed:', err?.message || err); }
        break;
      case 'payment_intent.payment_failed':
        try { await handleAgentPaymentIntentEvent(event.data.object, 'payment_failed'); } catch (err) { console.error('Agent payment intent failure handler failed:', err?.message || err); }
        break;
        
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  });
  app.post("/stripe/cancel-subscription", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { subscription_id } = req.body;
    
    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID required' });
    }
    
    try {
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
      }
      const sub = await stripe.subscriptions.retrieve(subscription_id, { expand: ['schedule'] });
      let scheduleId = null;
      try { scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null; } catch {}
      if (!scheduleId) {
        const list = await stripe.subscriptionSchedules.list({ subscription: subscription_id, limit: 1 });
        scheduleId = list?.data?.[0]?.id || null;
      }
      if (scheduleId) {
        const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ['phases.items.price'] });
        const nowTs = Math.floor(Date.now()/1000);
        const existingPhases = Array.isArray(schedule.phases) ? schedule.phases : [];
        const currentPhase = existingPhases.find(p => !p.end_date || Number(p.end_date) > nowTs) || existingPhases[0];
        const preserved = {
          items: (currentPhase?.items || []).map(it => ({ price: (typeof it.price === 'string' ? it.price : it.price?.id), quantity: Number(it.quantity || 1) || 1 })),
          start_date: currentPhase?.start_date || nowTs,
          end_date: (currentPhase?.end_date || sub?.current_period_end || (nowTs + 1))
        };
        await stripe.subscriptionSchedules.update(scheduleId, { phases: [preserved], end_behavior: 'cancel' });
        return res.json({
          success: true,
          message: 'Your subscription will not renew. You will keep access until the period ends.',
          cancel_at_period_end: true,
          current_period_end: sub?.current_period_end || preserved.end_date || null
        });
      } else {
        const updated = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: true });
        try {
          updateUserPlan(userId, {
            status: 'active',
            stripe_subscription_id: updated?.id || subscription_id
          });
        } catch {}
        return res.json({ 
          success: true, 
          message: 'Your subscription will not renew. You will keep access until the period ends.',
          cancel_at_period_end: !!updated?.cancel_at_period_end,
          current_period_end: updated?.current_period_end || null
        });
      }
    } catch (error) {
      console.error('Failed to cancel subscription:', error);
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });
  app.post("/stripe/resume-subscription", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { subscription_id } = req.body || {};
    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID required' });
    }
    try {
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
      }
      const sub = await stripe.subscriptions.retrieve(subscription_id, { expand: ['schedule'] });
      let scheduleId = null;
      try { scheduleId = (sub?.schedule && (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id)) || null; } catch {}
      if (!scheduleId) {
        const list = await stripe.subscriptionSchedules.list({ subscription: subscription_id, limit: 1 });
        scheduleId = list?.data?.[0]?.id || null;
      }
      if (scheduleId) {
        const updatedSchedule = await stripe.subscriptionSchedules.update(scheduleId, { end_behavior: 'release' });
        return res.json({
          success: true,
          message: 'Subscription will continue after the current period.',
          current_period_end: sub?.current_period_end || null
        });
      } else {
        const updated = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: false });
        return res.json({
          success: true,
          message: 'Subscription will continue after the current period.',
          current_period_end: updated?.current_period_end || null
        });
      }
    } catch (error) {
      console.error('Failed to resume subscription:', error);
      return res.status(500).json({ error: 'Failed to resume subscription' });
    }
  });
}