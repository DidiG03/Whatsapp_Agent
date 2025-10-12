import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { createCheckoutSession, getCheckoutSession, handleSuccessfulPayment, handleSubscriptionCanceled, isStripeEnabled } from "../services/stripe.mjs";
import { updateUserPlan } from "../services/usage.mjs";
import { renderSidebar, renderTopbar } from "../utils.mjs";
import Stripe from 'stripe';
import crypto from 'node:crypto';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export default function registerStripeRoutes(app) {
  // Create checkout session for plan upgrade
  app.post("/stripe/create-checkout", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { plan_name } = req.body;
    const email = await getSignedInEmail(req);
    
    if (!plan_name || !['free', 'starter'].includes(plan_name)) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }
    
    try {
      const result = await createCheckoutSession(userId, plan_name, email);
      
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
    const email = await getSignedInEmail(req);
    
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
        if (session.mode === 'subscription') {
          await handleSuccessfulPayment(session);
        }
        break;
        
      case 'customer.subscription.updated':
        const subscriptionUpdated = event.data.object;
        console.log('Subscription updated:', subscriptionUpdated.id);
        break;
        
      case 'customer.subscription.deleted':
        const subscriptionDeleted = event.data.object;
        await handleSubscriptionCanceled(subscriptionDeleted);
        break;
        
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        console.log('Invoice payment succeeded:', invoice.id);
        break;
        
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        console.log('Invoice payment failed:', failedInvoice.id);
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