/**
 * App factory: constructs and configures the Express application.
 * Mounts logging, body parsers, static assets, Clerk auth, and all routes.
 */
import express from "express";
import bodyParser from "body-parser";
import { httpLogger } from "./logger.mjs";
import { STATIC_DIR } from "./config.mjs";
import { initClerk } from "./middleware/auth.mjs";

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
/**
 * Create and configure an Express app instance.
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();
  // rawBody capture for signature verification
  app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // HTTP request logging

  app.use(express.static(STATIC_DIR));

  // Clerk (if configured)
  initClerk(app);

  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
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
  registerNotificationRoutes(app);
  registerWebhookRoutes(app);
  registerMiscRoutes(app);

  return app;
}

