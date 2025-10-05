# Stripe Integration Setup

This document explains how to set up Stripe payment processing for the WhatsApp Agent application.

## 🔧 Environment Variables

Add the following environment variables to your `.env` file:

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...  # Your Stripe secret key (test or live)
STRIPE_PUBLISHABLE_KEY=pk_test_...  # Your Stripe publishable key (test or live)
STRIPE_WEBHOOK_SECRET=whsec_...  # Your Stripe webhook endpoint secret
PUBLIC_BASE_URL=http://localhost:3000  # Your application's base URL
```

## 🚀 Getting Started

### 1. Create a Stripe Account
1. Go to [https://stripe.com](https://stripe.com) and create an account
2. Complete the account setup process

### 2. Get Your API Keys
1. In the Stripe Dashboard, go to **Developers** → **API Keys**
2. Copy your **Publishable key** and **Secret key**
3. For testing, use the **Test** keys (they start with `pk_test_` and `sk_test_`)

### 3. Set Up Webhooks
1. In the Stripe Dashboard, go to **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Set the endpoint URL to: `https://yourdomain.com/stripe/webhook`
4. Select these events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Copy the **Signing secret** (starts with `whsec_`)

### 4. Configure Environment Variables
```bash
# Test mode (for development)
STRIPE_SECRET_KEY=sk_test_your_test_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_test_publishable_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
PUBLIC_BASE_URL=http://localhost:3000

# Live mode (for production)
STRIPE_SECRET_KEY=sk_live_your_live_secret_key
STRIPE_PUBLISHABLE_KEY=pk_live_your_live_publishable_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
PUBLIC_BASE_URL=https://yourdomain.com
```

## 💳 How It Works

### Plan Structure
- **Free Plan**: $0/month - 100 messages
- **Starter Plan**: $29/month - 1,000 messages

### Payment Flow
1. User clicks "Subscribe to Starter" on the Plan page
2. Application creates a Stripe checkout session
3. User is redirected to Stripe Checkout
4. After successful payment, Stripe sends a webhook
5. Application updates user's plan in the database
6. User is redirected back to the Plan page with success message

### Subscription Management
- Users can cancel subscriptions from the Plan page
- Cancellations are handled via Stripe API
- Canceled users are automatically downgraded to Free plan

## 🔍 Testing

### Test Cards
Use these test card numbers in Stripe's test mode:

```
Success: 4242 4242 4242 4242
Decline: 4000 0000 0000 0002
Requires authentication: 4000 0025 0000 3155
```

Use any future expiry date and any 3-digit CVC.

### Test Webhooks
1. Install Stripe CLI: `stripe listen --forward-to localhost:3000/stripe/webhook`
2. This will give you a webhook secret for local testing
3. Use this secret in your `.env` file for local development

## 🚀 Going Live

### 1. Switch to Live Mode
1. In Stripe Dashboard, toggle **Test mode** off
2. Update your environment variables with live keys
3. Update webhook endpoint URL to production domain

### 2. Verify Webhook Endpoint
1. In Stripe Dashboard, go to your webhook endpoint
2. Send a test webhook to verify it's working
3. Check your application logs for successful webhook processing

### 3. Test Live Payments
1. Use real payment methods (start with small amounts)
2. Verify subscription creation and billing
3. Test cancellation flow

## 🔒 Security Considerations

1. **Never commit API keys** to version control
2. **Use HTTPS** in production for webhook endpoints
3. **Verify webhook signatures** (already implemented)
4. **Use environment variables** for all sensitive configuration
5. **Monitor webhook logs** for failed deliveries

## 📊 Monitoring

### Stripe Dashboard
- Monitor payments, subscriptions, and failures
- Set up alerts for failed payments
- Review webhook delivery logs

### Application Logs
- Check for webhook processing errors
- Monitor subscription status changes
- Track plan upgrades/downgrades

## 🛠️ Troubleshooting

### Common Issues

1. **Webhook signature verification failed**
   - Check that `STRIPE_WEBHOOK_SECRET` is correct
   - Ensure webhook endpoint URL is accessible

2. **Checkout session creation failed**
   - Verify `STRIPE_SECRET_KEY` is correct
   - Check that `PUBLIC_BASE_URL` is properly set

3. **Subscription not updating**
   - Check webhook endpoint is receiving events
   - Verify database connection
   - Review application logs for errors

### Debug Mode
Enable debug logging by setting:
```bash
LOG_LEVEL=debug
```

This will show detailed Stripe API interactions in the logs.

## 📝 API Endpoints

The following endpoints are available for Stripe integration:

- `POST /stripe/create-checkout` - Create checkout session
- `GET /stripe/success` - Handle successful checkout
- `GET /stripe/cancel` - Handle canceled checkout
- `POST /stripe/webhook` - Handle Stripe webhooks
- `POST /stripe/cancel-subscription` - Cancel subscription

## 🔄 Webhook Events

The application handles these Stripe webhook events:

- `checkout.session.completed` - Process successful subscription
- `customer.subscription.updated` - Update subscription status
- `customer.subscription.deleted` - Downgrade to free plan
- `invoice.payment_succeeded` - Handle successful billing
- `invoice.payment_failed` - Handle failed billing

## 📞 Support

For Stripe-related issues:
1. Check Stripe Dashboard for transaction details
2. Review application logs for errors
3. Consult [Stripe Documentation](https://stripe.com/docs)
4. Contact Stripe Support if needed
