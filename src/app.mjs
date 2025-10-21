/**
 * App factory: constructs and configures the Express application.
 * Mounts logging, body parsers, static assets, Clerk auth, security middleware, and all routes.
 */
import express from "express";
import { STATIC_DIR } from "./config.mjs";
import { initClerk } from "./middleware/auth.mjs";
import { securityHeaders, createRateLimiters, sanitizeInput } from "./middleware/security.mjs";
import { errorHandler, requestLogger } from "./middleware/errors.mjs";

// Monitoring and Logging
import { initSentry } from "./monitoring/sentry.mjs";
import { loggingMiddleware } from "./monitoring/logger.mjs";
import { healthCheckMiddleware, startHealthCheckScheduler } from "./monitoring/health.mjs";
import { metricsMiddleware, startMetricsCollection } from "./monitoring/metrics.mjs";

// Scalability and Performance
import { scalabilityManager, createPerformanceMiddleware, scalabilityHealthCheck } from "./scalability/index.mjs";

// Ensure DB side-effects are applied by importing db module
import "./db.mjs";

// Routes
import registerHomeRoutes from "./routes/home.mjs";
import registerAuthRoutes from "./routes/auth.mjs";
import registerDashboardRoutes from "./routes/dashboard.mjs";
import registerInboxRoutes from "./routes/inbox.mjs";
import registerSettingsRoutes from "./routes/settings.mjs";
import registerKbRoutes from "./routes/kb.mjs";
import registerWebhookRoutes from "./routes/webhook.mjs";
import registerMiscRoutes from "./routes/misc.mjs";
import registerBookingRoutes from "./routes/booking.mjs";
import registerAssistantRoutes from "./routes/assistant.mjs";
import registerGuideRoutes from "./routes/guide.mjs";
import registerNotificationRoutes from "./routes/notifications.mjs";
import registerPlanRoutes from "./routes/plan.mjs";
import registerStripeRoutes from "./routes/stripe.mjs";
import registerOnboardingRoutes from "./routes/onboarding.mjs";
import registerRealtimeRoutes, { initializeSocketIO } from "./routes/realtime.mjs";
import registerMonitoringRoutes from "./routes/monitoring.mjs";
import registerMetricsRoutes from "./routes/metrics.mjs";
/**
 * Create and configure an Express app instance.
 * @returns {import('express').Express}
 */
export async function createApp() {
  const app = express();
  
  // Initialize scalability systems first
  await scalabilityManager.init();
  
  // Initialize monitoring systems
  initSentry();
  
  // Trust proxy for accurate IP addresses
  app.set('trust proxy', 1);
  
  // Security middleware
  app.use(securityHeaders);
  
  // Performance middleware
  const performanceMiddleware = createPerformanceMiddleware();
  performanceMiddleware.forEach(middleware => app.use(middleware));
  
  // Monitoring middleware (before other middleware)
  app.use(loggingMiddleware());
  app.use(metricsMiddleware());
  
  // Rate limiting
  const { generalLimiter, strictLimiter, webhookLimiter } = createRateLimiters();
  app.use(generalLimiter);
  
  // Request size limits to prevent DoS attacks
  app.use(express.json({ 
    limit: '10mb', // Limit JSON payloads to 10MB
    verify: (req, _res, buf) => { req.rawBody = buf; } 
  }));
  app.use(express.urlencoded({ 
    limit: '10mb', // Limit URL-encoded payloads to 10MB
    extended: true 
  }));

  // Input sanitization to prevent XSS attacks
  app.use(sanitizeInput);

  // Static file serving with security headers
  app.use(express.static(STATIC_DIR));
  app.use('/uploads', express.static('uploads'));

  // Clerk (if configured)
  initClerk(app);

  // Additional security headers
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // X-Frame-Options disabled as requested
    next();
  });
  
  // Health check middleware (before rate limiting)
  app.use(healthCheckMiddleware());
  
  // Scalability health check endpoint
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

  // Block access to disabled features
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

  // Block access to contacts routes
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

  // Block access to contacts API routes
  app.use('/api/contacts', (req, res) => {
    res.status(403).json({
      error: 'Contacts feature disabled',
      message: 'This feature is currently under development and has been temporarily disabled.',
      code: 'FEATURE_DISABLED'
    });
  });

  // Register routes
  registerHomeRoutes(app);
  registerAuthRoutes(app);
  registerDashboardRoutes(app);
  registerInboxRoutes(app);
  registerSettingsRoutes(app);
  registerGuideRoutes(app);
  registerKbRoutes(app);
  registerBookingRoutes(app);
  registerAssistantRoutes(app);
  registerOnboardingRoutes(app);
  registerNotificationRoutes(app);
  registerPlanRoutes(app);
  registerStripeRoutes(app);
  registerRealtimeRoutes(app);
  registerMonitoringRoutes(app);
  registerMetricsRoutes(app);
  registerWebhookRoutes(app);
  registerMiscRoutes(app);
  
  // Apply specific rate limits to sensitive endpoints
  app.use('/webhook', webhookLimiter);
  
  // Start monitoring services
  startHealthCheckScheduler(300000); // Check every 5 minutes (reduced frequency)
  startMetricsCollection(60000); // Collect metrics every minute (reduced frequency)
  
  // Global error handler (must be last)
  app.use(errorHandler);

  // Return app and Socket.IO initializer
  return { app, initializeSocketIO };
}

