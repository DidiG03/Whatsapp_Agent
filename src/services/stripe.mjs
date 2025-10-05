/**
 * Stripe service for handling payments and subscriptions
 */
import Stripe from 'stripe';

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
 * Create a Stripe checkout session for plan subscription
 */
export async function createCheckoutSession(userId, planName, customerEmail = null) {
  if (!isStripeEnabled()) {
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
    // Create or retrieve Stripe customer
    let customerId;
    if (customerEmail) {
      const customers = await stripe.customers.list({
        email: customerEmail,
        limit: 1
      });
      
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: customerEmail,
          metadata: {
            user_id: userId
          }
        });
        customerId = customer.id;
      }
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
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
      success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/plan?canceled=true`,
      metadata: {
        user_id: userId,
        plan_name: planName
      }
    });

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
  if (!isStripeEnabled()) {
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
  if (!isStripeEnabled()) {
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
  if (!isStripeEnabled()) {
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
      stripe_subscription_id: session.subscription || null
    });
    
    console.log(`User ${userId} successfully subscribed to ${planName} plan`);
  }
}

/**
 * Handle subscription cancellation webhook
 */
export async function handleSubscriptionCanceled(subscription) {
  const customerId = subscription.customer;
  
  // Find user by customer ID
  const { db } = await import('../db.mjs');
  const userPlan = db.prepare(`
    SELECT user_id FROM user_plans 
    WHERE stripe_subscription_id = ? OR stripe_customer_id = ?
  `).get(subscription.id, customerId);
  
  if (userPlan) {
    // Downgrade to free plan
    const { updateUserPlan } = await import('./usage.mjs');
    updateUserPlan(userPlan.user_id, {
      plan_name: 'free',
      monthly_limit: 100,
      whatsapp_numbers: 1,
      billing_cycle_start: Math.floor(Date.now() / 1000),
      stripe_subscription_id: null
    });
    
    console.log(`User ${userPlan.user_id} subscription canceled, downgraded to free plan`);
  }
}