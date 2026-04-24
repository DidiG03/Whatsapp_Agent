
import express from "express";
import cookieParser from "cookie-parser";
import { STATIC_DIR } from "./config.mjs";
import { initClerk } from "./middleware/auth.mjs";
import { securityHeaders, createRateLimiters, sanitizeInput } from "./middleware/security.mjs";
import { errorHandler, requestLogger, notFoundHandler } from "./middleware/errors.mjs";
import { csrfProtection, attachCsrfToken } from "./middleware/csrf.mjs";
import { initSentry } from "./monitoring/sentry.mjs";
import { loggingMiddleware } from "./monitoring/logger.mjs";
import { healthCheckMiddleware, startHealthCheckScheduler } from "./monitoring/health.mjs";
import { metricsMiddleware, startMetricsCollection } from "./monitoring/metrics.mjs";
import { initVercelAnalytics, createAnalyticsMiddleware } from "./monitoring/analytics.mjs";
import { scalabilityManager, createPerformanceMiddleware, scalabilityHealthCheck } from "./scalability/index.mjs";
import { initMongoDB, isMongoConnected } from "./db-mongodb.mjs";
import registerHomeRoutes from "./routes/home.mjs";
import registerAuthRoutes from "./routes/auth.mjs";
import registerDashboardRoutes from "./routes/dashboard.mjs";
import registerInboxRoutes from "./routes/inbox.mjs";
import registerSettingsRoutes from "./routes/settings.mjs";
import registerKbRoutes from "./routes/kb.mjs";
import registerCampaignRoutes from "./routes/campaigns.mjs";
import registerBookingsTab from "./routes/bookings.mjs";
import registerWebhookRoutes from "./routes/webhook.mjs";
import registerMiscRoutes from "./routes/misc.mjs";
import registerBookingRoutes from "./routes/booking.mjs";
import registerAssistantRoutes from "./routes/assistant.mjs";
import registerGuideRoutes from "./routes/guide.mjs";
import registerNotificationRoutes from "./routes/notifications.mjs";
import registerPlanRoutes from "./routes/plan.mjs";
import registerStripeRoutes from "./routes/stripe.mjs";
import registerPaymentRoutes from "./routes/payments.mjs";
import registerRealtimeRoutes from "./routes/realtime.mjs";
import registerMonitoringRoutes from "./routes/monitoring.mjs";
import { signMediaPath } from "./utils.mjs";
import registerMetricsRoutes from "./routes/metrics.mjs";
import registerGoogleRoutes from "./routes/google.mjs";
import registerUsageRoutes from "./routes/usage.mjs";
import registerShopifyRoutes from "./routes/shopify.mjs";
import { initOutboundQueue } from "./jobs/outboundQueue.mjs";

export async function createApp() {
  const app = express();
  app.use(cookieParser());
  try { await initMongoDB(); } catch {}
  app.use(async (_req, res, next) => {
    if (!isMongoConnected()) {
      try { await initMongoDB(); } catch {
        return res.status(503).json({ error: 'Database temporarily unavailable' });
      }
    }
    next();
  });
  await scalabilityManager.init();
  initSentry();
  initVercelAnalytics();
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  const performanceMiddleware = createPerformanceMiddleware();
  performanceMiddleware.forEach(middleware => app.use(middleware));
  app.use(loggingMiddleware());
  app.use(metricsMiddleware());
  app.use(createAnalyticsMiddleware());
  try {
    if (process.env.VERCEL) {
      initOutboundQueue()
        .then((queueReady) => {
          if (!queueReady) {
            console.info('[Queue] Outbound queue not ready; falling back to direct sends until Redis is available.');
          }
        })
        .catch((error) => {
          console.error('[Queue] Failed to initialize outbound queue (async):', error?.message || error);
        });
    } else {
    const queueReady = await initOutboundQueue();
    if (!queueReady) {
      console.info('[Queue] Outbound queue not ready; falling back to direct sends until Redis is available.');
      }
    }
  } catch (error) {
    console.error('[Queue] Failed to initialize outbound queue:', error?.message || error);
  }
  const { generalLimiter, strictLimiter, webhookLimiter } = createRateLimiters();
  app.use(generalLimiter);
  app.use(express.json({ 
    limit: '10mb',    verify: (req, _res, buf) => { req.rawBody = buf; } 
  }));
  app.use(express.urlencoded({ 
    limit: '10mb',    extended: true 
  }));
  app.use(sanitizeInput);
  app.use(express.static(STATIC_DIR, {
    setHeaders: (res, path) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }));
  app.get('/favicon.ico', (_req, res) => {
    res.redirect(302, '/logo-icon.png');
  });
  app.use('/uploads', (req, res, next) => {
    if (process.env.MEDIA_SIGNING_DISABLED === '1') return next();
    const urlPath = `${req.baseUrl}${req.path}`;    const exp = parseInt((req.query.exp || '0').toString(), 10);
    const sig = (req.query.sig || '').toString();
    try {
      const secret = process.env.MEDIA_SIGN_SECRET || process.env.SESSION_TOKEN_SECRET || 'dev-media-secret';
      const expected = require('node:crypto').createHmac('sha256', secret).update(`${urlPath}|${exp}`).digest('hex');
      const now = Math.floor(Date.now()/1000);
      if (!exp || !sig || exp < now || sig !== expected) {
        return res.status(403).send('Invalid or expired media link');
      }
    } catch { return res.status(403).send('Invalid media link'); }
    next();
  });
  app.use('/uploads', express.static('uploads', { setHeaders: (res)=> res.setHeader('Cache-Control','public, max-age=604800') }));
  initClerk(app);
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(healthCheckMiddleware());
  app.get('/health/scalability', async (req, res) => {
    try {
      const health = await scalabilityHealthCheck();
      res.status(health.overall === 'healthy' ? 200 : 503).json(health);
    } catch (error) {
      res.status(503).json({
        overall: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
  app.use('/webhooks', (req, res) => {
    res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Feature Disabled - WhatsApp Agent</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; background: #f8fafc; }
          .container { max-width: 500px; margin: 0 auto; text-align: center; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .lock-icon { font-size: 48px; color: #f59e0b; margin-bottom: 20px; }
          h1 { color: #1f2937; margin-bottom: 16px; }
          p { color: #6b7280; margin-bottom: 24px; line-height: 1.6; }
          .btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
          .btn:hover { background: #2563eb; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="lock-icon">🔒</div>
          <h1>Webhooks Feature Disabled</h1>
          <p>This feature is currently under development and has been temporarily disabled. It will be available in a future update.</p>
          <a href="/dashboard" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  });

  app.use('/api-management', (req, res) => {
    res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Feature Disabled - WhatsApp Agent</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; background: #f8fafc; }
          .container { max-width: 500px; margin: 0 auto; text-align: center; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .lock-icon { font-size: 48px; color: #f59e0b; margin-bottom: 20px; }
          h1 { color: #1f2937; margin-bottom: 16px; }
          p { color: #6b7280; margin-bottom: 24px; line-height: 1.6; }
          .btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
          .btn:hover { background: #2563eb; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="lock-icon">🔒</div>
          <h1>API Management Feature Disabled</h1>
          <p>This feature is currently under development and has been temporarily disabled. It will be available in a future update.</p>
          <a href="/dashboard" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  });
  app.use('/contacts', (req, res) => {
    res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Feature Disabled - WhatsApp Agent</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; background: #f8fafc; }
          .container { max-width: 500px; margin: 0 auto; text-align: center; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .lock-icon { font-size: 48px; color: #f59e0b; margin-bottom: 20px; }
          h1 { color: #1f2937; margin-bottom: 16px; }
          p { color: #6b7280; margin-bottom: 24px; line-height: 1.6; }
          .btn { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
          .btn:hover { background: #2563eb; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="lock-icon">🔒</div>
          <h1>Contacts Feature Disabled</h1>
          <p>This feature is currently under development and has been temporarily disabled. It will be available in a future update.</p>
          <a href="/dashboard" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  });
  app.use('/api/contacts', (req, res) => {
    res.status(403).json({
      error: 'Contacts feature disabled',
      message: 'This feature is currently under development and has been temporarily disabled.',
      code: 'FEATURE_DISABLED'
    });
  });
  registerHomeRoutes(app);
  registerAuthRoutes(app);
  registerDashboardRoutes(app);
  registerInboxRoutes(app);
  registerSettingsRoutes(app, { csrfProtection, csrfTokenMiddleware: attachCsrfToken });
  registerGuideRoutes(app);
  registerKbRoutes(app);
  registerCampaignRoutes(app);
  registerBookingsTab(app);
  registerBookingRoutes(app);
  registerAssistantRoutes(app);
  registerNotificationRoutes(app);
  registerPlanRoutes(app);
  registerStripeRoutes(app);
  registerPaymentRoutes(app);
  registerRealtimeRoutes(app);
  registerMonitoringRoutes(app);
  registerMetricsRoutes(app);
  registerGoogleRoutes(app);
  registerUsageRoutes(app);
  registerShopifyRoutes(app);
  registerWebhookRoutes(app);
  registerMiscRoutes(app);
  app.use('/webhook', webhookLimiter);
  startHealthCheckScheduler(300000);  startMetricsCollection(60000);  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app };
}

