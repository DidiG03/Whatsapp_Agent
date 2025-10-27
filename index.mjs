/**
 * Server bootstrap: creates the app and starts listening.
 */
import { createApp } from "./src/app.mjs";
import { PORT } from "./src/config.mjs";
import { startNotificationsScheduler } from "./src/jobs/notifications.mjs";
import { logHelpers } from "./src/monitoring/logger.mjs";
import { createServer } from "http";
import { initTelemetry } from "./src/monitoring/otel.mjs";

// Initialize server with scalability features
async function startServer() {
  try {
    logHelpers.logBusinessEvent('server_startup_initiated');
    await initTelemetry();
    
    // Create app with scalability features
    const { app, initializeSocketIO } = await createApp();
    
    // Create HTTP server
    const server = createServer(app);
    
    // Initialize Socket.IO
    initializeSocketIO(server);
    
    // Start notifications scheduler
    const stop = startNotificationsScheduler();
    
    // Start server
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
    
    // Store server reference for graceful shutdown
    global.server = server;
    
    // Enhanced shutdown handling
    function gracefulShutdown(signal) {
      logHelpers.logBusinessEvent('server_shutdown_initiated', { signal });
      
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      
      // Stop accepting new connections
      server.close(() => {
        logHelpers.logBusinessEvent('server_shutdown_completed');
        console.log('✅ Server closed');
        
        // Stop notifications scheduler
        try {
          if (typeof stop === 'function') stop();
        } catch (error) {
          console.error('Error stopping notifications scheduler:', error);
        }
        
        process.exit(0);
      });
      
      // Force shutdown after 30 seconds
      setTimeout(() => {
        console.log('⚠️  Forcing shutdown after timeout');
        process.exit(1);
      }, 30000);
    }
    
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logHelpers.logError(error, { component: 'server', operation: 'uncaught_exception' });
      console.error('💥 Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });
    
    // Handle unhandled promise rejections
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

// Start the server
startServer();

