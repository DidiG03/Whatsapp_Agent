
import { createApp } from "./src/app.mjs";
import { PORT } from "./src/config.mjs";
import { startNotificationsScheduler } from "./src/jobs/notifications.mjs";
import { logHelpers } from "./src/monitoring/logger.mjs";
import { createServer } from "http";
import { initTelemetry } from "./src/monitoring/otel.mjs";
import { closeMongoDB } from "./src/db-mongodb.mjs";
import { closeRedis } from "./src/scalability/redis.mjs";
import { sentryHelpers } from "./src/monitoring/sentry.mjs";
async function startServer() {
  try {
    logHelpers.logBusinessEvent('server_startup_initiated');
    await initTelemetry();
    const { app } = await createApp();
    const server = createServer(app);
    const stop = startNotificationsScheduler();
    server.listen(PORT, () => {
      logHelpers.logBusinessEvent('server_started', { 
        port: PORT,
        pid: process.pid,
        nodeVersion: process.version
      });
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📊 Monitoring dashboard: http://localhost:${PORT}/monitoring`);
      console.log(`🏥 Health check: http://localhost:${PORT}/health`);
      console.log(`⚡ Scalability health: http://localhost:${PORT}/health/scalability`);
    });
    global.server = server;
    let shuttingDown = false;
    function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      logHelpers.logBusinessEvent('server_shutdown_initiated', { signal });
      
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      server.close(() => {
        logHelpers.logBusinessEvent('server_shutdown_completed');
        console.log('✅ Server closed');
        try {
          if (typeof stop === 'function') stop();
        } catch (error) {
          console.error('Error stopping notifications scheduler:', error);
        }
        Promise.allSettled([
          (async () => { try { await closeMongoDB(); } catch {} })(),
          (async () => { try { await closeRedis(); } catch {} })()
        ]).finally(() => {
          process.exit(0);
        });
      });
      setTimeout(() => {
        console.log('⚠️  Forcing shutdown after timeout');
        process.exit(1);
      }, 30000);
    }
    
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    // An uncaught exception leaves the process in an undefined state, so we log,
    // report, and shut down so a process manager can restart cleanly.
    process.on('uncaughtException', (error) => {
      logHelpers.logError(error, { component: 'server', operation: 'uncaught_exception' });
      try { sentryHelpers.captureException(error, { tags: { handler: 'uncaughtException' } }); } catch {}
      console.error('💥 Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });
    // An unhandled promise rejection is NOT necessarily fatal (e.g. a single
    // failed OpenAI/WhatsApp/Mongo call that wasn't awaited). Log and report it,
    // but keep the server running so one stray rejection can't cause downtime.
    process.on('unhandledRejection', (reason) => {
      const error = reason instanceof Error ? reason : new Error(`Unhandled Promise Rejection: ${reason}`);
      logHelpers.logError(error, {
        component: 'server',
        operation: 'unhandled_rejection',
        reason: reason?.toString?.() || String(reason),
      });
      try { sentryHelpers.captureException(error, { tags: { handler: 'unhandledRejection' } }); } catch {}
      console.error('⚠️  Unhandled Rejection (continuing):', reason);
    });
    
  } catch (error) {
    logHelpers.logError(error, { component: 'server', operation: 'startup' });
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}
startServer();

