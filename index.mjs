
import { createApp } from "./src/app.mjs";
import { PORT } from "./src/config.mjs";
import { startNotificationsScheduler } from "./src/jobs/notifications.mjs";
import { logHelpers } from "./src/monitoring/logger.mjs";
import { createServer } from "http";
import { initTelemetry } from "./src/monitoring/otel.mjs";
import { closeMongoDB } from "./src/db-mongodb.mjs";
import { closeRedis } from "./src/scalability/redis.mjs";
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
    function gracefulShutdown(signal) {
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
    process.on('uncaughtException', (error) => {
      logHelpers.logError(error, { component: 'server', operation: 'uncaught_exception' });
      console.error('💥 Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason, promise) => {
      logHelpers.logError(new Error('Unhandled Promise Rejection'), { 
        component: 'server', 
        operation: 'unhandled_rejection',
        reason: reason?.toString(),
        promise: promise?.toString()
      });
      console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      gracefulShutdown('unhandledRejection');
    });
    
  } catch (error) {
    logHelpers.logError(error, { component: 'server', operation: 'startup' });
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}
startServer();

