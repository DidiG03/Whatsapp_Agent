

import Redis from 'ioredis';
import { logHelpers } from '../monitoring/logger.mjs';
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0'),
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  keepAlive: 30000,
  connectTimeout: 10000,
  commandTimeout: 5000,
  ...(String(process.env.REDIS_TLS || '').toLowerCase() === 'true' ? { tls: {} } : {}),
  family: 4,
  maxmemoryPolicy: 'allkeys-lru'
};
let redisClient = null;
let isConnected = false;

export function initRedis() {
  try {
    redisClient = new Redis(redisConfig);
    try {
      const shouldConnectEagerly = String(process.env.REDIS_ENABLED || '').toLowerCase() === 'true';
      if (shouldConnectEagerly && typeof redisClient.connect === 'function') {
        redisClient.connect().catch(() => {});
      }
    } catch {}
    
    redisClient.on('connect', () => {
      isConnected = true;
      logHelpers.logBusinessEvent('redis_connected', { 
        host: redisConfig.host, 
        port: redisConfig.port 
      });
    });
    
    redisClient.on('error', (error) => {
      isConnected = false;
      logHelpers.logError(error, { component: 'redis', operation: 'connection' });
    });
    
    redisClient.on('close', () => {
      isConnected = false;
      logHelpers.logBusinessEvent('redis_disconnected');
    });
    
    redisClient.on('reconnecting', () => {
      logHelpers.logBusinessEvent('redis_reconnecting');
    });
    
    return redisClient;
  } catch (error) {
    logHelpers.logError(error, { component: 'redis', operation: 'initialization' });
    return null;
  }
}

export async function closeRedis() {
  try {
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
      isConnected = false;
    }
  } catch (error) {
    logHelpers.logError(error, { component: 'redis', operation: 'close' });
  }
}
export async function ensureRedisConnected(timeoutMs = 3000) {
  try {
    if (!redisClient) {
      redisClient = initRedis();
    }
    if (isRedisConnected()) return true;
    if (typeof redisClient?.connect === 'function') {
      try { await redisClient.connect(); } catch {}
    }
    if (isRedisConnected()) return true;
    const start = Date.now();
    while (Date.now() - start < Math.max(0, timeoutMs)) {
      if (isRedisConnected()) return true;
      await new Promise(r => setTimeout(r, 50));
    }
  } catch {}
  return isRedisConnected();
}
export function getRedisClient() {
  if (!redisClient) {
    redisClient = initRedis();
  }
  return redisClient;
}
export function isRedisConnected() {
  return isConnected && redisClient && redisClient.status === 'ready';
}
export const cache = {
  async set(key, value, ttlSeconds = 3600) {
    if (!isRedisConnected()) {
      logHelpers.logBusinessEvent('redis_cache_miss', { reason: 'not_connected', key });
      return false;
    }
    
    try {
      const serializedValue = JSON.stringify(value);
      await redisClient.setex(key, ttlSeconds, serializedValue);
      
      logHelpers.logBusinessEvent('redis_cache_set', { 
        key, 
        ttl: ttlSeconds,
        size: serializedValue.length 
      });
      
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'set', key });
      return false;
    }
  },
  async get(key) {
    if (!isRedisConnected()) {
      logHelpers.logBusinessEvent('redis_cache_miss', { reason: 'not_connected', key });
      return null;
    }
    
    try {
      const value = await redisClient.get(key);
      if (value === null) {
        logHelpers.logBusinessEvent('redis_cache_miss', { reason: 'not_found', key });
        return null;
      }
      
      const parsedValue = JSON.parse(value);
      logHelpers.logBusinessEvent('redis_cache_hit', { key });
      return parsedValue;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'get', key });
      return null;
    }
  },
  async del(key) {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      const result = await redisClient.del(key);
      logHelpers.logBusinessEvent('redis_cache_delete', { key, deleted: result > 0 });
      return result > 0;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'delete', key });
      return false;
    }
  },
  async exists(key) {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'exists', key });
      return false;
    }
  },
  async mset(keyValuePairs, ttlSeconds = 3600) {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      const pipeline = redisClient.pipeline();
      
      for (const [key, value] of Object.entries(keyValuePairs)) {
        const serializedValue = JSON.stringify(value);
        pipeline.setex(key, ttlSeconds, serializedValue);
      }
      
      await pipeline.exec();
      logHelpers.logBusinessEvent('redis_cache_mset', { 
        count: Object.keys(keyValuePairs).length,
        ttl: ttlSeconds 
      });
      
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'mset' });
      return false;
    }
  },
  async mget(keys) {
    if (!isRedisConnected()) {
      return {};
    }
    
    try {
      const values = await redisClient.mget(keys);
      const result = {};
      
      keys.forEach((key, index) => {
        if (values[index] !== null) {
          try {
            result[key] = JSON.parse(values[index]);
          } catch (parseError) {
            logHelpers.logError(parseError, { component: 'redis', operation: 'mget_parse', key });
          }
        }
      });
      
      logHelpers.logBusinessEvent('redis_cache_mget', { 
        requested: keys.length,
        found: Object.keys(result).length 
      });
      
      return result;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'mget' });
      return {};
    }
  },
  async incr(key, ttlSeconds = 3600) {
    if (!isRedisConnected()) {
      return 0;
    }
    
    try {
      const pipeline = redisClient.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, ttlSeconds);
      
      const results = await pipeline.exec();
      const count = results[0][1];
      
      logHelpers.logBusinessEvent('redis_cache_incr', { key, count });
      return count;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'incr', key });
      return 0;
    }
  },
  async getStats() {
    if (!isRedisConnected()) {
      return { connected: false };
    }
    
    try {
      const info = await redisClient.info('memory');
      const keyspace = await redisClient.info('keyspace');
      
      return {
        connected: true,
        memory: info,
        keyspace: keyspace,
        status: redisClient.status
      };
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'stats' });
      return { connected: false, error: error.message };
    }
  },
  async flush() {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      await redisClient.flushdb();
      logHelpers.logBusinessEvent('redis_cache_flush');
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'flush' });
      return false;
    }
  }
};
export const sessionCache = {
  async setSession(sessionId, sessionData, ttlSeconds = 86400) {    const key = `session:${sessionId}`;
    return await cache.set(key, sessionData, ttlSeconds);
  },
  async getSession(sessionId) {
    const key = `session:${sessionId}`;
    return await cache.get(key);
  },
  async deleteSession(sessionId) {
    const key = `session:${sessionId}`;
    return await cache.del(key);
  },
  async refreshSession(sessionId, ttlSeconds = 86400) {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      const key = `session:${sessionId}`;
      await redisClient.expire(key, ttlSeconds);
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'refresh_session', sessionId });
      return false;
    }
  }
};
export const dataCache = {
  async cacheUserData(userId, userData, ttlSeconds = 1800) {    const key = `user:${userId}`;
    return await cache.set(key, userData, ttlSeconds);
  },
  async getUserData(userId) {
    const key = `user:${userId}`;
    return await cache.get(key);
  },
  async cacheMessages(conversationId, messages, ttlSeconds = 3600) {    const key = `messages:${conversationId}`;
    return await cache.set(key, messages, ttlSeconds);
  },
  async getMessages(conversationId) {
    const key = `messages:${conversationId}`;
    return await cache.get(key);
  },
  async cacheAIResponse(promptHash, response, ttlSeconds = 7200) {    const key = `ai:${promptHash}`;
    return await cache.set(key, response, ttlSeconds);
  },
  async getAIResponse(promptHash) {
    const key = `ai:${promptHash}`;
    return await cache.get(key);
  },
  async cacheKBItems(userId, kbItems, ttlSeconds = 1800) {    const key = `kb:${userId}`;
    return await cache.set(key, kbItems, ttlSeconds);
  },
  async getKBItems(userId) {
    const key = `kb:${userId}`;
    return await cache.get(key);
  }
};
export const rateLimiter = {
  async checkLimit(identifier, limit, windowSeconds) {
    if (!isRedisConnected()) {
      return { allowed: true, remaining: limit, resetTime: Date.now() + windowSeconds * 1000 };
    }
    
    try {
      const key = `rate_limit:${identifier}`;
      const current = await redisClient.incr(key);
      
      if (current === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      
      const ttl = await redisClient.ttl(key);
      const remaining = Math.max(0, limit - current);
      const resetTime = Date.now() + ttl * 1000;
      
      return {
        allowed: current <= limit,
        remaining,
        resetTime,
        current
      };
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'rate_limit', identifier });
      return { allowed: true, remaining: limit, resetTime: Date.now() + windowSeconds * 1000 };
    }
  },
  async resetLimit(identifier) {
    if (!isRedisConnected()) {
      return false;
    }
    
    try {
      const key = `rate_limit:${identifier}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      logHelpers.logError(error, { component: 'redis', operation: 'reset_rate_limit', identifier });
      return false;
    }
  }
};
export function cacheMiddleware(ttlSeconds = 300, keyGenerator = null) {
  return async (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }
    
    const key = keyGenerator ? keyGenerator(req) : `cache:${req.originalUrl}`;
    const cachedResponse = await cache.get(key);
    
    if (cachedResponse) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', key);
      return res.json(cachedResponse);
    }
    const originalJson = res.json;
    
    res.json = function(data) {
      cache.set(key, data, ttlSeconds).catch(error => {
        logHelpers.logError(error, { component: 'redis', operation: 'cache_middleware', key });
      });
      
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', key);
      
      return originalJson.call(this, data);
    };
    
    next();
  };
}
initRedis();

export default {
  cache,
  sessionCache,
  dataCache,
  rateLimiter,
  cacheMiddleware,
  isRedisConnected,
  getRedisClient,
  closeRedis
};
