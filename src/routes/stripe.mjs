import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { createCheckoutSession, getCheckoutSession, handleSuccessfulPayment, handleSubscriptionCanceled, isStripeEnabled } from "../services/stripe.mjs";
import { handleCheckoutSessionEvent as handleAgentCheckoutSessionEvent, handlePaymentIntentEvent as handleAgentPaymentIntentEvent } from "../services/agentPayments.mjs";
import { updateUserPlan } from "../services/usage.mjs";
import { renderSidebar, renderTopbar } from "../utils.mjs";
import Stripe from 'stripe';
import crypto from 'node:crypto';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export default function registerStripeRoutes(app) {
  // Create checkout session for plan upgrade
  app.post("/stripe/create-checkout", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { plan_name, price_id } = req.body;
    const email = await getSignedInEmail(req);
    
    if (!plan_name || !['free', 'starter'].includes(plan_name)) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }
    
    try {
      const result = await createCheckoutSession(userId, plan_name, email, price_id);
      
      if (plan_name === 'free') {
        // Handle free plan upgrade immediately
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
      console.error('Checkout session creation failed:', error);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // Handle successful checkout
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

  // Handle canceled checkout
  app.get("/stripe/cancel", ensureAuthed, async (req, res) => {
    return res.redirect('/plan?canceled=true');
  });

  // Stripe webhook endpoint
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

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        if (session.metadata?.payment_request_id) {
          try { await handleAgentCheckoutSessionEvent(session, 'completed'); } catch (err) { console.error('Agent payment complete handler failed:', err?.message || err); }
        } else if (session.mode === 'subscription') {
          await handleSuccessfulPayment(session);
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

  // Cancel subscription endpoint
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
      
      await stripe.subscriptions.cancel(subscription_id);
      
      // Update user plan to free
      updateUserPlan(userId, {
        plan_name: 'free',
        monthly_limit: 100,
        whatsapp_numbers: 1,
        billing_cycle_start: Math.floor(Date.now() / 1000),
        stripe_subscription_id: null
      });
      
      return res.json({ success: true, message: 'Subscription canceled successfully' });
    } catch (error) {
      console.error('Failed to cancel subscription:', error);
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });
}