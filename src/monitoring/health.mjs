
import v8 from 'v8';
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

const isProduction = process.env.NODE_ENV === 'production';
const RSS_WARN_MB = Number(process.env.MEMORY_RSS_WARN_MB || (isProduction ? 768 : 512));
const RSS_CRITICAL_MB = Number(process.env.MEMORY_RSS_CRITICAL_MB || (isProduction ? 1200 : 900));
const HEAP_LIMIT_WARN_PCT = Number(process.env.MEMORY_HEAP_LIMIT_WARN_PCT || 85);
const HEAP_LIMIT_CRITICAL_PCT = Number(process.env.MEMORY_HEAP_LIMIT_CRITICAL_PCT || 92);
const CHECK_EXTERNAL_APIS = process.env.HEALTH_CHECK_EXTERNAL_APIS === '1'
  || (isProduction && process.env.HEALTH_CHECK_EXTERNAL_APIS !== '0');

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
  if (!CHECK_EXTERNAL_APIS) {
    healthChecks.external_apis = {
      status: 'healthy',
      skipped: true,
      reason: 'disabled_in_development',
      last_check: new Date().toISOString()
    };
    return true;
  }

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
      } catch {
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
      } catch {
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
      } catch {
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

    let status = 'healthy';
    if (configuredChecks.length > 0 && !configuredHealthy) {
      status = 'degraded';
    }

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
    const heapStats = v8.getHeapStatistics();

    const rssMb = memUsage.rss / 1024 / 1024;
    const heapUsedMb = memUsage.heapUsed / 1024 / 1024;
    const heapTotalMb = memUsage.heapTotal / 1024 / 1024;
    const heapLimitMb = heapStats.heap_size_limit / 1024 / 1024;
    const externalMb = memUsage.external / 1024 / 1024;

    // heapUsed / heapTotal is misleading — V8 grows heapTotal on demand.
    // Use RSS and heapUsed vs V8 heap_size_limit instead.
    const heapUtilizationPct = (memUsage.heapUsed / heapStats.heap_size_limit) * 100;
    const heapCommittedPct = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    let status = 'healthy';
    if (rssMb >= RSS_CRITICAL_MB || heapUtilizationPct >= HEAP_LIMIT_CRITICAL_PCT) {
      status = 'unhealthy';
    } else if (rssMb >= RSS_WARN_MB || heapUtilizationPct >= HEAP_LIMIT_WARN_PCT) {
      status = 'warning';
    }

    if (status === 'unhealthy' && typeof global.gc === 'function') {
      global.gc();
      const after = process.memoryUsage();
      const afterHeap = v8.getHeapStatistics();
      const afterRssMb = after.rss / 1024 / 1024;
      const afterHeapUtil = (after.heapUsed / afterHeap.heap_size_limit) * 100;
      if (afterRssMb < RSS_CRITICAL_MB && afterHeapUtil < HEAP_LIMIT_CRITICAL_PCT) {
        status = afterRssMb >= RSS_WARN_MB || afterHeapUtil >= HEAP_LIMIT_WARN_PCT ? 'warning' : 'healthy';
      }
    }

    healthChecks.memory = {
      status,
      rss_mb: Math.round(rssMb),
      heap_used_mb: Math.round(heapUsedMb),
      heap_total_mb: Math.round(heapTotalMb),
      heap_limit_mb: Math.round(heapLimitMb),
      heap_external_mb: Math.round(externalMb),
      heap_utilization_pct: Math.round(heapUtilizationPct * 100) / 100,
      heap_committed_pct: Math.round(heapCommittedPct * 100) / 100,
      thresholds: {
        rss_warn_mb: RSS_WARN_MB,
        rss_critical_mb: RSS_CRITICAL_MB,
        heap_limit_warn_pct: HEAP_LIMIT_WARN_PCT,
        heap_limit_critical_pct: HEAP_LIMIT_CRITICAL_PCT,
      },
      last_check: new Date().toISOString()
    };

    if (status === 'unhealthy') {
      logHelpers.logError(new Error('High memory usage'), {
        component: 'health_check',
        check: 'memory',
        ...healthChecks.memory,
      });
    } else if (status === 'warning') {
      logHelpers.logBusinessEvent('memory_warning', {
        component: 'health_check',
        check: 'memory',
        ...healthChecks.memory,
      });
    }

    return status !== 'unhealthy';
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
    fs.statSync('.');
    healthChecks.disk_space = {
      status: 'healthy',
      last_check: new Date().toISOString(),
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
      overallStatus = 'unhealthy';
    } else if (!memHealthy || !apisHealthy) {
      overallStatus = 'degraded';
    }

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
        if (req.path === '/health/detailed') {
          const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL;
          const expected = String(process.env.HEALTH_DETAILED_SECRET || process.env.DIAG_SECRET || '').trim();
          const provided = String(req.headers['x-health-key'] || req.query.key || '').trim();
          if (isProd && (!expected || provided !== expected)) {
            return res.status(404).json({ error: 'not_found' });
          }
        }

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

export function startHealthCheckScheduler(intervalMs = 300000) {
  if (global.healthCheckInterval) {
    clearInterval(global.healthCheckInterval);
  }

  global.healthCheckInterval = setInterval(async () => {
    try {
      await runHealthChecks();
    } catch (error) {
      logHelpers.logError(error, { component: 'health_check', operation: 'scheduled_check' });
    }
  }, intervalMs);

  if (typeof global.healthCheckInterval.unref === 'function') {
    global.healthCheckInterval.unref();
  }

  logHelpers.logBusinessEvent('health_check_scheduler_started', { interval_ms: intervalMs });
}

export default {
  runHealthChecks,
  getHealthStatus,
  healthCheckMiddleware,
  startHealthCheckScheduler
};
