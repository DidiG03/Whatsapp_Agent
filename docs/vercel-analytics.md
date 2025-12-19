# Vercel Web Analytics Integration

This document describes the Vercel Web Analytics integration for the WhatsApp Agent application.

## Overview

Vercel Web Analytics is integrated into the WhatsApp Agent to provide monitoring and usage analytics when the application is deployed to Vercel. The analytics system tracks:

- Application performance metrics
- Server-side events
- Custom tracking events
- Page views and user interactions

## Setup

### Prerequisites

- A Vercel account (sign up at https://vercel.com/signup)
- A Vercel project for WhatsApp Agent
- The `@vercel/analytics` package (already included: v1.6.1)

### Enable Analytics on Vercel Dashboard

1. Go to the [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your WhatsApp Agent project
3. Click the **Analytics** tab
4. Click **Enable** to enable Web Analytics

> **Note:** Enabling Web Analytics will add new routes (scoped at `/_vercel/insights/*`) after your next deployment.

### Package Installation

The `@vercel/analytics` package is already included in `package.json`:

```bash
pnpm install  # or npm install / yarn install / bun install
```

## Architecture

### Integration Points

The Vercel Web Analytics integration is implemented in the following files:

#### 1. **src/monitoring/analytics.mjs**
Main analytics module providing:
- `initVercelAnalytics()` - Initialize analytics on server startup
- `createAnalyticsMiddleware()` - Express middleware for tracking
- `trackEvent()` - Track custom business events
- `isAnalyticsInitialized()` - Check initialization status

#### 2. **src/app.mjs**
Express application configuration that:
- Imports the analytics module
- Initializes analytics during app creation
- Adds analytics middleware to the express pipeline

#### 3. **index.mjs**
Server bootstrap that:
- Creates and starts the app (which initializes analytics)
- Handles graceful shutdown with proper cleanup

### Middleware Integration

Analytics middleware is added to the Express pipeline at initialization:

```javascript
app.use(createAnalyticsMiddleware());
```

This middleware provides analytics tracking capabilities to all routes through `req.analytics` object:

```javascript
req.analytics.trackEvent(eventName, eventData);
req.analytics.trackPageView(pageName);
```

## Deployment

### Deploying to Vercel

Deploy your application using the Vercel CLI:

```bash
vercel deploy
```

Or connect your Git repository for automatic deployments:

1. Push changes to your main branch
2. Vercel automatically deploys the latest commit
3. Analytics begins collecting data immediately

### Verification

After deployment, verify analytics is working:

1. Visit your deployed application at https://your-project.vercel.app
2. Open your browser's Network tab
3. Look for requests to `/_vercel/insights/view` and `/_vercel/insights/script.js`
4. These requests indicate analytics is active

## Monitoring Analytics Data

### Viewing Analytics Dashboard

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your WhatsApp Agent project
3. Click the **Analytics** tab
4. Explore the analytics panels to view:
   - Page views
   - Unique visitors
   - Core Web Vitals
   - Response times
   - Error rates

### Analytics Panels Available

After a few days of user traffic, the following analytics panels become available:

- **Page Views**: Track page visit patterns
- **Visitors**: Monitor unique users and sessions
- **Core Web Vitals**: LCP, FID, CLS metrics
- **Response Times**: Server response performance
- **Status Codes**: HTTP response distribution
- **Custom Events**: Business-specific tracking (Pro/Enterprise plans)

## Custom Event Tracking

### Pro and Enterprise Plans

Users on Pro and Enterprise plans can track custom events:

```javascript
// In your route handlers or middleware
req.analytics.trackEvent('user_signup', {
  plan: 'pro',
  source: 'landing_page'
});

req.analytics.trackEvent('message_sent', {
  type: 'text',
  recipients: 5
});
```

### Debug Mode

Enable debug logging for analytics events:

```bash
DEBUG_ANALYTICS=1 npm run dev
```

This will log all analytics events to the console.

## Privacy and Compliance

Vercel Web Analytics follows strict privacy and compliance standards:

- **GDPR Compliant**: Data collection respects GDPR requirements
- **No Cookies**: Analytics work without setting cookies
- **Privacy-First**: User IP addresses are not stored
- **CCPA Compliant**: Meets California Consumer Privacy Act requirements

For detailed privacy information, see:
https://vercel.com/analytics/privacy

## Troubleshooting

### Analytics Not Working

1. **Verify Deployment**: Ensure app is deployed to Vercel
   ```bash
   vercel --version
   vercel deploy
   ```

2. **Enable Analytics**: Check that Analytics is enabled in Vercel Dashboard
   - Project → Analytics tab → Verify "Enable" button is active

3. **Check Network Requests**: Open browser DevTools and verify requests to `/_vercel/insights/`

4. **Wait for Data**: Analytics data collection takes a few minutes
   - Check back after 5-10 minutes of traffic

5. **Review Logs**: Check deployment logs for errors
   ```bash
   vercel logs
   ```

### Configuration Issues

If you encounter issues:

1. Verify `@vercel/analytics` is installed:
   ```bash
   npm list @vercel/analytics
   ```

2. Check package.json includes `@vercel/analytics` in dependencies

3. Ensure Node.js version compatibility (14.0.0 or higher)

4. Rebuild and redeploy:
   ```bash
   npm install
   vercel deploy --prod
   ```

## Performance Impact

The analytics integration has minimal performance impact:

- **Script Size**: ~3-4 KB gzipped
- **Network Overhead**: One analytics request per page view (~100 bytes)
- **CPU Impact**: Negligible (< 1ms per request)
- **Memory Impact**: < 1 MB

## Next Steps

1. **Deploy to Vercel**: Push your changes to deploy
2. **Enable Analytics**: Turn on analytics in Vercel Dashboard
3. **Monitor Data**: Check dashboard after 5-10 minutes
4. **Set Up Alerts**: (Pro plan) Create alerts for key metrics
5. **Custom Events**: (Pro/Enterprise) Implement business-specific tracking

## Resources

- [Vercel Analytics Documentation](https://vercel.com/docs/analytics)
- [Vercel Dashboard](https://vercel.com/dashboard)
- [Analytics Package Docs](https://www.npmjs.com/package/@vercel/analytics)
- [Privacy Policy](https://vercel.com/analytics/privacy-policy)
- [Limits and Pricing](https://vercel.com/docs/analytics/limits-and-pricing)

## Support

For issues or questions about Vercel Web Analytics:

1. Check [Vercel Analytics Troubleshooting](https://vercel.com/docs/analytics/troubleshooting)
2. Review [Vercel Support Documentation](https://vercel.com/support)
3. Contact Vercel Support through your dashboard
