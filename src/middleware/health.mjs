/**
 * Health check middleware and metrics collection utilities.
 */

/**
 * Run health checks for the application
 */
export async function runHealthChecks() {
  const checks = {
    database: await checkDatabase(),
    timestamp: new Date().toISOString()
  };
  
  const allHealthy = Object.values(checks).every(check => 
    typeof check === 'object' ? check.status === 'healthy' : true
  );
  
  return {
    status: allHealthy ? 'healthy' : 'unhealthy',
    checks
  };
}

/**
 * Check database connectivity
 */
async function checkDatabase() {
  try {
    // Import db here to avoid circular dependencies
    const { db } = await import('../db.mjs');
    // Simple query to test database connection
    db.prepare('SELECT 1').get();
    return { status: 'healthy', message: 'Database connection OK' };
  } catch (error) {
    return { 
      status: 'unhealthy', 
      message: 'Database connection failed',
      error: error.message 
    };
  }
}

/**
 * Collect basic application metrics
 */
export function collectMetrics() {
  const memUsage = process.memoryUsage();
  
  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
    },
    version: process.version,
    platform: process.platform
  };
}
