/**
 * Scalability Configuration and Management
 * Central configuration for all scalability features
 */

import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';

// Scalability configuration
export const scalabilityConfig = {
  // Database configuration
  database: {
    type: process.env.DATABASE_TYPE || 'sqlite', // sqlite, postgresql
    connectionPool: {
      min: parseInt(process.env.DB_POOL_MIN || '5'),
      max: parseInt(process.env.DB_POOL_MAX || '20'),
      idleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000')
    },
    migration: {
      autoRun: process.env.DB_AUTO_MIGRATE === 'true',
      backupBeforeMigrate: process.env.DB_BACKUP_MIGRATE === 'true'
    }
  },
  
  // Redis configuration
  redis: {
    enabled: process.env.REDIS_ENABLED === 'true',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0'),
    ttl: {
      session: parseInt(process.env.REDIS_SESSION_TTL || '86400'), // 24 hours
      cache: parseInt(process.env.REDIS_CACHE_TTL || '3600'), // 1 hour
      rateLimit: parseInt(process.env.REDIS_RATE_LIMIT_TTL || '3600') // 1 hour
    }
  },
  
  // CDN configuration
  cdn: {
    enabled: process.env.CDN_ENABLED === 'true',
    provider: process.env.CDN_PROVIDER || 'cloudflare',
    domain: process.env.CDN_DOMAIN || '',
    optimization: {
      images: process.env.CDN_OPTIMIZE_IMAGES === 'true',
      compression: process.env.CDN_COMPRESSION === 'true',
      minification: process.env.CDN_MINIFICATION === 'true'
    }
  },
  
  // Clustering configuration
  cluster: {
    enabled: process.env.CLUSTER_ENABLED === 'true',
    workers: parseInt(process.env.CLUSTER_WORKERS || '0'), // 0 = auto-detect
    loadBalancing: {
      algorithm: process.env.LB_ALGORITHM || 'round_robin',
      healthCheck: process.env.LB_HEALTH_CHECK === 'true',
      stickySessions: process.env.LB_STICKY_SESSIONS === 'true'
    }
  },
  
  // Performance configuration
  performance: {
    compression: {
      enabled: process.env.COMPRESSION_ENABLED === 'true',
      level: parseInt(process.env.COMPRESSION_LEVEL || '6'),
      threshold: parseInt(process.env.COMPRESSION_THRESHOLD || '1024')
    },
    caching: {
      staticAssets: process.env.CACHE_STATIC === 'true',
      apiResponses: process.env.CACHE_API === 'true',
      databaseQueries: process.env.CACHE_DB === 'true'
    },
    rateLimiting: {
      enabled: process.env.RATE_LIMITING_ENABLED === 'true',
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000'), // 15 minutes
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100')
    }
  },
  
  // Monitoring configuration
  monitoring: {
    metrics: {
      enabled: process.env.METRICS_ENABLED === 'true',
      interval: parseInt(process.env.METRICS_INTERVAL || '30000'),
      retention: parseInt(process.env.METRICS_RETENTION || '86400') // 24 hours
    },
    healthChecks: {
      enabled: process.env.HEALTH_CHECKS_ENABLED === 'true',
      interval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000'),
      timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000')
    }
  }
};

// Scalability manager
export const scalabilityManager = {
  // Initialize all scalability features
  async init() {
    logHelpers.logBusinessEvent('scalability_init_started');
    
    const results = {
      database: false,
      redis: false,
      cdn: false,
      cluster: false,
      performance: false
    };
    
    try {
      // Initialize database
      if (scalabilityConfig.database.type === 'postgresql') {
        const { databaseAdapter } = await import('./postgres.mjs');
        await databaseAdapter.init();
        results.database = true;
        logHelpers.logBusinessEvent('scalability_database_initialized', { 
          type: scalabilityConfig.database.type 
        });
      }
      
      // Initialize Redis
      if (scalabilityConfig.redis.enabled) {
        const { initRedis } = await import('./redis.mjs');
        initRedis();
        results.redis = true;
        logHelpers.logBusinessEvent('scalability_redis_initialized');
      }
      
      // Initialize CDN
      if (scalabilityConfig.cdn.enabled) {
        const { cdn } = await import('./cdn.mjs');
        // CDN doesn't need initialization, just configuration
        results.cdn = true;
        logHelpers.logBusinessEvent('scalability_cdn_initialized', { 
          provider: scalabilityConfig.cdn.provider 
        });
      }
      
      // Initialize clustering
      if (scalabilityConfig.cluster.enabled) {
        const { clusterManager } = await import('./cluster.mjs');
        clusterManager.init();
        results.cluster = true;
        logHelpers.logBusinessEvent('scalability_cluster_initialized', { 
          workers: scalabilityConfig.cluster.workers 
        });
      }
      
      // Initialize performance optimizations
      results.performance = this.initPerformanceOptimizations();
      
      logHelpers.logBusinessEvent('scalability_init_completed', results);
      
      return results;
    } catch (error) {
      logHelpers.logError(error, { component: 'scalability_manager', operation: 'init' });
      throw error;
    }
  },
  
  // Initialize performance optimizations
  initPerformanceOptimizations() {
    try {
      // Enable compression if configured
      if (scalabilityConfig.performance.compression.enabled) {
        logHelpers.logBusinessEvent('scalability_compression_enabled', {
          level: scalabilityConfig.performance.compression.level,
          threshold: scalabilityConfig.performance.compression.threshold
        });
      }
      
      // Enable caching if configured
      if (scalabilityConfig.performance.caching.staticAssets) {
        logHelpers.logBusinessEvent('scalability_static_caching_enabled');
      }
      
      if (scalabilityConfig.performance.caching.apiResponses) {
        logHelpers.logBusinessEvent('scalability_api_caching_enabled');
      }
      
      if (scalabilityConfig.performance.caching.databaseQueries) {
        logHelpers.logBusinessEvent('scalability_db_caching_enabled');
      }
      
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'scalability_manager', operation: 'performance_init' });
      return false;
    }
  },
  
  // Get scalability status
  getStatus() {
    return {
      config: scalabilityConfig,
      features: {
        database: scalabilityConfig.database.type !== 'sqlite',
        redis: scalabilityConfig.redis.enabled,
        cdn: scalabilityConfig.cdn.enabled,
        cluster: scalabilityConfig.cluster.enabled,
        performance: scalabilityConfig.performance.compression.enabled
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        platform: process.platform,
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
      }
    };
  },
  
  // Validate configuration
  validateConfig() {
    const issues = [];
    
    // Check database configuration
    if (scalabilityConfig.database.type === 'postgresql') {
      if (!process.env.POSTGRES_HOST) {
        issues.push('POSTGRES_HOST is required for PostgreSQL');
      }
      if (!process.env.POSTGRES_DB) {
        issues.push('POSTGRES_DB is required for PostgreSQL');
      }
    }
    
    // Check Redis configuration
    if (scalabilityConfig.redis.enabled) {
      if (!process.env.REDIS_HOST) {
        issues.push('REDIS_HOST is required when Redis is enabled');
      }
    }
    
    // Check CDN configuration
    if (scalabilityConfig.cdn.enabled) {
      if (!process.env.CDN_DOMAIN) {
        issues.push('CDN_DOMAIN is required when CDN is enabled');
      }
    }
    
    // Check cluster configuration
    if (scalabilityConfig.cluster.enabled) {
      if (scalabilityConfig.cluster.workers === 0) {
        issues.push('CLUSTER_WORKERS must be specified when clustering is enabled');
      }
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
};

// Performance middleware factory
export function createPerformanceMiddleware() {
  const middleware = [];
  
  // Compression middleware
  if (scalabilityConfig.performance.compression.enabled) {
    const compression = require('compression');
    middleware.push(compression({
      level: scalabilityConfig.performance.compression.level,
      threshold: scalabilityConfig.performance.compression.threshold
    }));
  }
  
  // Rate limiting middleware
  if (scalabilityConfig.performance.rateLimiting.enabled) {
    const rateLimit = require('express-rate-limit');
    middleware.push(rateLimit({
      windowMs: scalabilityConfig.performance.rateLimiting.windowMs,
      max: scalabilityConfig.performance.rateLimiting.maxRequests,
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false
    }));
  }
  
  return middleware;
}

// Health check for scalability features
export async function scalabilityHealthCheck() {
  const health = {
    overall: 'healthy',
    features: {},
    timestamp: new Date().toISOString()
  };
  
  try {
    // Check database
    if (scalabilityConfig.database.type === 'postgresql') {
      const { databaseAdapter } = await import('./postgres.mjs');
      const dbHealth = await databaseAdapter.healthCheck();
      health.features.database = dbHealth;
    } else {
      health.features.database = { connected: true, type: 'sqlite' };
    }
    
    // Check Redis
    if (scalabilityConfig.redis.enabled) {
      const { isRedisConnected } = await import('./redis.mjs');
      health.features.redis = { connected: isRedisConnected() };
    } else {
      health.features.redis = { enabled: false };
    }
    
    // Check CDN
    if (scalabilityConfig.cdn.enabled) {
      const { cdn } = await import('./cdn.mjs');
      const cdnStats = await cdn.getStats();
      health.features.cdn = cdnStats;
    } else {
      health.features.cdn = { enabled: false };
    }
    
    // Check cluster
    if (scalabilityConfig.cluster.enabled) {
      const { clusterManager } = await import('./cluster.mjs');
      const clusterStats = clusterManager.getStats();
      health.features.cluster = clusterStats;
    } else {
      health.features.cluster = { enabled: false };
    }
    
    // Determine overall health
    const unhealthyFeatures = Object.values(health.features)
      .filter(feature => feature.connected === false || feature.enabled === false);
    
    if (unhealthyFeatures.length > 0) {
      health.overall = 'degraded';
    }
    
    return health;
  } catch (error) {
    logHelpers.logError(error, { component: 'scalability_manager', operation: 'health_check' });
    return {
      overall: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

export default {
  scalabilityConfig,
  scalabilityManager,
  createPerformanceMiddleware,
  scalabilityHealthCheck
};
