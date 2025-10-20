/**
 * Scalability System Test
 * Tests the scalability features and performance improvements
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { scalabilityManager, scalabilityConfig, createPerformanceMiddleware } from '../../src/scalability/index.mjs';
import { cache, sessionCache } from '../../src/scalability/redis.mjs';
import { cdn } from '../../src/scalability/cdn.mjs';

describe('Scalability System', () => {
  describe('Configuration', () => {
    test('should have valid configuration', () => {
      expect(scalabilityConfig).toBeDefined();
      expect(scalabilityConfig.database).toBeDefined();
      expect(scalabilityConfig.redis).toBeDefined();
      expect(scalabilityConfig.cdn).toBeDefined();
      expect(scalabilityConfig.cluster).toBeDefined();
      expect(scalabilityConfig.performance).toBeDefined();
    });

    test('should validate configuration', () => {
      const validation = scalabilityManager.validateConfig();
      expect(validation).toBeDefined();
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
    });

    test('should get scalability status', () => {
      const status = scalabilityManager.getStatus();
      expect(status).toBeDefined();
      expect(status.config).toBeDefined();
      expect(status.features).toBeDefined();
      expect(status.environment).toBeDefined();
    });
  });

  describe('Redis Caching', () => {
    test('should handle cache operations gracefully when Redis is disabled', async () => {
      // Test cache operations when Redis is not available
      const result = await cache.set('test-key', { test: 'data' });
      expect(typeof result).toBe('boolean');
      
      const cached = await cache.get('test-key');
      expect(cached).toBeNull(); // Should return null when Redis is disabled
    });

    test('should handle session cache operations', async () => {
      const sessionId = 'test-session-123';
      const sessionData = { userId: 'user-123', email: 'test@example.com' };
      
      const setResult = await sessionCache.setSession(sessionId, sessionData);
      expect(typeof setResult).toBe('boolean');
      
      const getResult = await sessionCache.getSession(sessionId);
      expect(getResult).toBeNull(); // Should return null when Redis is disabled
    });
  });

  describe('CDN Integration', () => {
    test('should generate asset URLs', () => {
      const url = cdn.generateAssetUrl('images/logo.png');
      expect(url).toBe('images/logo.png'); // Should return original path when CDN is disabled
    });

    test('should generate responsive image URLs', () => {
      const responsive = cdn.generateResponsiveImageUrls('images/hero.jpg');
      expect(responsive).toBeDefined();
      expect(responsive.srcset).toBeDefined();
      expect(responsive.src).toBeDefined();
    });

    test('should handle CDN operations gracefully when disabled', async () => {
      const purgeResult = await cdn.purgeCache(['test-url']);
      expect(typeof purgeResult).toBe('boolean');
      
      const stats = await cdn.getStats();
      expect(stats).toBeDefined();
      expect(stats.available).toBe(false);
    });
  });

  describe('Performance Features', () => {
    test('should create performance middleware', () => {
      const middleware = createPerformanceMiddleware();
      expect(Array.isArray(middleware)).toBe(true);
    });
  });
});
