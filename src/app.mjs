/**
 * App factory: constructs and configures the Express application.
 * Mounts logging, body parsers, static assets, Clerk auth, security middleware, and all routes.
 */
import express from "express";
import { httpLogger } from "./logger.mjs";
import { STATIC_DIR } from "./config.mjs";
import { initClerk } from "./middleware/auth.mjs";
import { securityHeaders, createRateLimiters } from "./middleware/security.mjs";
import { errorHandler, requestLogger } from "./middleware/errors.mjs";
import { runHealthChecks, collectMetrics } from "./middleware/health.mjs";

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
import registerAdminRoutes from "./routes/admin.mjs";
import registerRealtimeRoutes from "./routes/realtime.mjs";
import registerContactRoutes from "./routes/contacts.mjs";
/**
 * Create and configure an Express app instance.
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();
  
  // Trust proxy for accurate IP addresses
  app.set('trust proxy', 1);
  
  // Security middleware
  app.use(securityHeaders);
  
  // Rate limiting
  const { generalLimiter, strictLimiter, webhookLimiter } = createRateLimiters();
  app.use(generalLimiter);
  
  // Request logging
  // app.use(requestLogger);
  
  // rawBody capture for signature verification
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));

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
  
  // Health check endpoints (before rate limiting)
  app.get('/health', async (req, res) => {
    const health = await runHealthChecks();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
  });
  
  app.get('/metrics', (req, res) => {
    const metrics = collectMetrics();
    res.json(metrics);
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
  registerAdminRoutes(app);
  registerRealtimeRoutes(app);
  registerContactRoutes(app);
  registerWebhookRoutes(app);
  registerMiscRoutes(app);
  
  // Apply specific rate limits to sensitive endpoints
  app.use('/admin', strictLimiter);
  app.use('/webhook', webhookLimiter);
  
  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}

