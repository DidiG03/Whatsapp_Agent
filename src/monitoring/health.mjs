

import { getDB, isMongoConnected } from '../db-mongodb.mjs';
import { logHelpers } from './logger.mjs';
import { sentryHelpers } from './sentry.mjs';
import fs from 'fs';
const healthChecks = {
  database: null,
  external_apis: null,
  memory: null,
  disk_space: null,
  last_check: null
};
async function checkDatabase() {
  try {
    const startTime = Date.now();
    if (!isMongoConnected()) throw new Error('MongoDB not connected');

    const mongoDb = getDB();
    await mongoDb.command({ ping: 1 });
    const duration = Date.now() - startTime;
    const tableCounts = {};
    const tables = ['messages', 'customers', 'kb_items', 'settings_multi'];
    let tableErrors = 0;
    for (const name of tables) {
      try {
        const count = await mongoDb.collection(name).estimatedDocumentCount();
        tableCounts[name] = count;
      } catch (error) {
        tableCounts[name] = 'error';
        tableErrors++;
        logHelpers.logError(error, { component: 'health_check', check: 'database_collection', collection: name });
      }
    }

    const criticalTables = ['messages', 'customers'];
    const criticalTableErrors = criticalTables.filter(t => tableCounts[t] === 'error').length;

    healthChecks.database = {
      status: criticalTableErrors === 0 ? 'healthy' : 'degraded',
      response_time: duration,
      table_counts: tableCounts,
      table_errors: tableErrors,
      critical_table_errors: criticalTableErrors,
      last_check: new Date().toISOString()
    };

    return true;
  } catch (error) {
    healthChecks.database = {
      status: 'unhealthy',
      error: error.message,
      last_check: new Date().toISOString()
    };
    
    logHelpers.logError(error, { component: 'health_check', check: 'database' });
    sentryHelpers.captureException(error, { tags: { component: 'health_check', check: 'database' } });
    
    return false;
  }
}
async function checkExternalAPIs() {
  const checks = {
    whatsapp_api: false,
    openai_api: false,
    stripe_api: false
  };
  
  try {
    if (process.env.WHATSAPP_TOKEN) {
      try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}`, {
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        });
        checks.whatsapp_api = response.ok;
      } catch (error) {
        checks.whatsapp_api = false;
      }
    }
    if (process.env.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          }
        });
        checks.openai_api = response.ok;
      } catch (error) {
        checks.openai_api = false;
      }
    }
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const response = await fetch('https://api.stripe.com/v1/account', {
          headers: {
            'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
          }
        });
        checks.stripe_api = response.ok;
      } catch (error) {
        checks.stripe_api = false;
      }
    }
    const configuredAPIs = {
      whatsapp_api: !!(process.env.WHATSAPP_TOKEN && process.env.PHONE_NUMBER_ID),
      openai_api: !!process.env.OPENAI_API_KEY,
      stripe_api: !!process.env.STRIPE_SECRET_KEY
    };
    const configuredChecks = Object.keys(checks).filter(api => configuredAPIs[api]);
    const configuredHealthy = configuredChecks.every(api => checks[api] === true);
    const anyConfiguredHealthy = configuredChecks.some(api => checks[api] === true);
    
    let status = 'healthy';
    if (configuredChecks.length === 0) {
      status = 'healthy';    } else if (!configuredHealthy) {
      status = 'degraded';    }
    
    healthChecks.external_apis = {
      status,
      checks,
      configured_apis: configuredAPIs,
      configured_count: configuredChecks.length,
      last_check: new Date().toISOString()
    };
    
    return configuredChecks.length === 0 || configuredHealthy;
  } catch (error) {
    healthChecks.external_apis = {
      status: 'unhealthy',
      error: error.message,
      last_check: new Date().toISOString()
    };
    
    logHelpers.logError(error, { component: 'health_check', check: 'external_apis' });
    return false;
  }
}
function checkMemory() {
  try {
    const memUsage = process.memoryUsage();
    const totalMem = memUsage.heapTotal;
    const usedMem = memUsage.heapUsed;
    const externalMem = memUsage.external;
    const rssMem = memUsage.rss;
    
    const usagePercentage = (usedMem / totalMem) * 100;
    const isHealthy = usagePercentage < 95;    const isWarning = usagePercentage >= 95 && usagePercentage < 98;    if (usagePercentage > 98 && global.gc) {
      global.gc();
      const newMemUsage = process.memoryUsage();
      const newUsagePercentage = (newMemUsage.heapUsed / newMemUsage.heapTotal) * 100;
      
      healthChecks.memory = {
        status: newUsagePercentage < 95 ? 'healthy' : (newUsagePercentage < 98 ? 'warning' : 'unhealthy'),
        heap_total: Math.round(newMemUsage.heapTotal / 1024 / 1024),        heap_used: Math.round(newMemUsage.heapUsed / 1024 / 1024),        heap_external: Math.round(newMemUsage.external / 1024 / 1024),        rss: Math.round(newMemUsage.rss / 1024 / 1024),        usage_percentage: Math.round(newUsagePercentage * 100) / 100,
        garbage_collected: true,
        last_check: new Date().toISOString()
      };
      
      if (newUsagePercentage > 95) {
        logHelpers.logError(new Error('High memory usage after GC'), {
          component: 'health_check',
          check: 'memory',
          usage_percentage: newUsagePercentage,
          gc_performed: true
        });
      }
      
      return newUsagePercentage < 90;
    }
    
    healthChecks.memory = {
      status: isHealthy ? 'healthy' : (isWarning ? 'warning' : 'unhealthy'),
      heap_total: Math.round(totalMem / 1024 / 1024),      heap_used: Math.round(usedMem / 1024 / 1024),      heap_external: Math.round(externalMem / 1024 / 1024),      rss: Math.round(rssMem / 1024 / 1024),      usage_percentage: Math.round(usagePercentage * 100) / 100,
      last_check: new Date().toISOString()
    };
    
    if (!isHealthy) {
      logHelpers.logError(new Error('High memory usage'), {
        component: 'health_check',
        check: 'memory',
        usage_percentage: usagePercentage
      });
    }
    
    return isHealthy;
  } catch (error) {
    healthChecks.memory = {
      status: 'unhealthy',
      error: error.message,
      last_check: new Date().toISOString()
    };
    
    return false;
  }
}
function checkDiskSpace() {
  try {
    const stats = fs.statSync('.');
    healthChecks.disk_space = {
      status: 'healthy',      last_check: new Date().toISOString(),
      note: 'Disk space check simplified - implement proper disk monitoring'
    };
    
    return true;
  } catch (error) {
    healthChecks.disk_space = {
      status: 'unhealthy',
      error: error.message,
      last_check: new Date().toISOString()
    };
    
    return false;
  }
}
export async function runHealthChecks() {
  const startTime = Date.now();
  
  try {
    logHelpers.logBusinessEvent('health_check_started');
    const [dbHealthy, apisHealthy, memHealthy, diskHealthy] = await Promise.all([
      checkDatabase(),
      checkExternalAPIs(),
      Promise.resolve(checkMemory()),
      Promise.resolve(checkDiskSpace())
    ]);
    
    const overallHealthy = dbHealthy && memHealthy && diskHealthy;
    const duration = Date.now() - startTime;
    let overallStatus = 'healthy';
    if (!dbHealthy || !diskHealthy) {
      overallStatus = 'unhealthy';    } else if (!memHealthy || !apisHealthy) {
      overallStatus = 'degraded';    }
    
    healthChecks.last_check = new Date().toISOString();
    healthChecks.overall_status = overallStatus;
    healthChecks.check_duration = duration;
    
    logHelpers.logBusinessEvent('health_check_completed', {
      overall_status: healthChecks.overall_status,
      duration,
      checks: Object.keys(healthChecks).filter(key => key !== 'last_check' && key !== 'overall_status' && key !== 'check_duration')
    });
    
    return healthChecks;
  } catch (error) {
    logHelpers.logError(error, { component: 'health_check', check: 'overall' });
    sentryHelpers.captureException(error, { tags: { component: 'health_check', check: 'overall' } });
    
    return {
      ...healthChecks,
      overall_status: 'unhealthy',
      error: error.message,
      last_check: new Date().toISOString()
    };
  }
}
export function getHealthStatus() {
  return healthChecks;
}
export function healthCheckMiddleware() {
  return async (req, res, next) => {
    if (req.path === '/health' || req.path === '/health/detailed') {
      try {
        const healthStatus = await runHealthChecks();
        
        if (req.path === '/health/detailed') {
          res.json({
            status: healthStatus.overall_status,
            timestamp: new Date().toISOString(),
            checks: healthStatus
          });
        } else {
          res.status(healthStatus.overall_status === 'healthy' ? 200 : 503).json({
            status: healthStatus.overall_status,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logHelpers.logError(error, { component: 'health_check', endpoint: req.path });
        
        res.status(503).json({
          status: 'unhealthy',
          error: 'Health check failed',
          timestamp: new Date().toISOString()
        });
      }
    } else {
      next();
    }
  };
}
export function startHealthCheckScheduler(intervalMs = 300000) {  if (global.healthCheckInterval) {
    clearInterval(global.healthCheckInterval);
  }
  
  global.healthCheckInterval = setInterval(async () => {
    try {
      await runHealthChecks();
      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      logHelpers.logError(error, { component: 'health_check', operation: 'scheduled_check' });
    }
  }, intervalMs);
  
  logHelpers.logBusinessEvent('health_check_scheduler_started', { interval_ms: intervalMs });
}

export default {
  runHealthChecks,
  getHealthStatus,
  healthCheckMiddleware,
  startHealthCheckScheduler
};
