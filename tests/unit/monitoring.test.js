/**
 * Monitoring System Test
 * Tests the basic functionality of our monitoring and logging system
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { getAllMetrics, incrementCounter, setGauge, resetMetrics } from '../../src/monitoring/metrics.mjs';
import { createRequestLogger, generateCorrelationId } from '../../src/monitoring/logger.mjs';
import { getHealthStatus } from '../../src/monitoring/health.mjs';

describe('Monitoring System', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('Metrics Collection', () => {
    test('should increment counters', () => {
      incrementCounter('test_counter', 5);
      incrementCounter('test_counter', 3);
      
      const metrics = getAllMetrics();
      expect(metrics.counters['test_counter']).toBe(8);
    });

    test('should set gauges', () => {
      setGauge('test_gauge', 42);
      
      const metrics = getAllMetrics();
      expect(metrics.gauges['test_gauge']).toBe(42);
    });

    test('should reset metrics', () => {
      incrementCounter('test_counter', 5);
      setGauge('test_gauge', 42);
      
      resetMetrics();
      
      const metrics = getAllMetrics();
      expect(metrics.counters).toEqual({});
      expect(metrics.gauges).toEqual({});
    });

    test('should include metadata', () => {
      const metrics = getAllMetrics();
      
      expect(metrics.metadata).toBeDefined();
      expect(metrics.metadata.timestamp).toBeDefined();
      expect(metrics.metadata.uptime).toBeDefined();
      expect(typeof metrics.metadata.uptime).toBe('number');
    });
  });

  describe('Logging System', () => {
    test('should generate correlation IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
    });

    test('should create request logger', () => {
      const correlationId = generateCorrelationId();
      const logger = createRequestLogger(correlationId, 'test-user');
      
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
    });
  });

  describe('Health Checks', () => {
    test('should return health status', () => {
      const health = getHealthStatus();
      
      expect(health).toBeDefined();
      expect(typeof health).toBe('object');
    });
  });
});
