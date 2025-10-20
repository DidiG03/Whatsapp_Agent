/**
 * Basic Metrics Collection System
 * Provides application metrics, performance tracking, and business analytics
 */

import { logHelpers } from './logger.mjs';
import { sentryHelpers } from './sentry.mjs';

// In-memory metrics store (in production, use Redis or a proper metrics DB)
const metrics = {
  counters: new Map(),
  gauges: new Map(),
  histograms: new Map(),
  timers: new Map(),
  last_reset: new Date().toISOString()
};

// Counter metrics (incremental values)
export const counters = {
  // HTTP metrics
  http_requests_total: 'Total HTTP requests',
  http_requests_by_status: 'HTTP requests by status code',
  http_requests_by_endpoint: 'HTTP requests by endpoint',
  
  // WhatsApp metrics
  whatsapp_messages_sent: 'WhatsApp messages sent',
  whatsapp_messages_received: 'WhatsApp messages received',
  whatsapp_templates_sent: 'WhatsApp templates sent',
  whatsapp_api_errors: 'WhatsApp API errors',
  
  // AI metrics
  ai_requests_total: 'AI requests total',
  ai_requests_successful: 'AI requests successful',
  ai_requests_failed: 'AI requests failed',
  
  // Database metrics
  database_queries_total: 'Database queries total',
  database_queries_by_table: 'Database queries by table',
  database_errors: 'Database errors',
  
  // Business metrics
  users_active: 'Active users',
  conversations_started: 'Conversations started',
  conversations_completed: 'Conversations completed',
  kb_items_created: 'Knowledge base items created',
  
  // Error metrics
  errors_total: 'Total errors',
  errors_by_type: 'Errors by type',
  errors_by_component: 'Errors by component'
};

// Gauge metrics (current values)
export const gauges = {
  // System metrics
  memory_usage_mb: 'Memory usage in MB',
  cpu_usage_percent: 'CPU usage percentage',
  active_connections: 'Active connections',
  
  // Application metrics
  queue_size: 'Queue size',
  cache_hit_rate: 'Cache hit rate',
  response_time_avg: 'Average response time',
  
  // Business metrics
  total_users: 'Total users',
  total_conversations: 'Total conversations',
  total_messages: 'Total messages'
};

// Histogram metrics (distribution of values)
export const histograms = {
  response_time: 'Response time distribution',
  message_processing_time: 'Message processing time',
  ai_response_time: 'AI response time',
  database_query_time: 'Database query time'
};

// Timer metrics (duration tracking)
export const timers = {
  request_duration: 'Request duration',
  message_processing: 'Message processing duration',
  ai_generation: 'AI generation duration',
  database_operation: 'Database operation duration'
};

// Counter operations
export function incrementCounter(name, value = 1, labels = {}) {
  const key = `${name}${Object.keys(labels).length ? ':' + JSON.stringify(labels) : ''}`;
  const current = metrics.counters.get(key) || 0;
  metrics.counters.set(key, current + value);
  
  // Log significant counter increments
  if (value > 10 || name.includes('error')) {
    logHelpers.logBusinessEvent('metric_counter_increment', {
      counter: name,
      value,
      labels,
      total: current + value
    });
  }
}

// Gauge operations
export function setGauge(name, value, labels = {}) {
  const key = `${name}${Object.keys(labels).length ? ':' + JSON.stringify(labels) : ''}`;
  metrics.gauges.set(key, { value, timestamp: Date.now() });
}

export function incrementGauge(name, value = 1, labels = {}) {
  const key = `${name}${Object.keys(labels).length ? ':' + JSON.stringify(labels) : ''}`;
  const current = metrics.gauges.get(key) || { value: 0 };
  metrics.gauges.set(key, { value: current.value + value, timestamp: Date.now() });
}

// Histogram operations
export function recordHistogram(name, value, labels = {}) {
  const key = `${name}${Object.keys(labels).length ? ':' + JSON.stringify(labels) : ''}`;
  const current = metrics.histograms.get(key) || [];
  current.push({ value, timestamp: Date.now() });
  
  // Keep only last 1000 values to prevent memory issues
  if (current.length > 1000) {
    current.splice(0, current.length - 1000);
  }
  
  metrics.histograms.set(key, current);
}

// Timer operations
export function startTimer(name, labels = {}) {
  const key = `${name}${Object.keys(labels).length ? ':' + JSON.stringify(labels) : ''}`;
  const timerId = `${key}:${Date.now()}:${Math.random()}`;
  
  return {
    end: () => {
      const duration = Date.now() - parseInt(timerId.split(':')[1]);
      recordHistogram(name, duration, labels);
      return duration;
    }
  };
}

// Timer decorator for functions
export function withTimer(timerName, labels = {}) {
  return function(target, propertyName, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const timer = startTimer(timerName, labels);
      try {
        const result = await originalMethod.apply(this, args);
        timer.end();
        return result;
      } catch (error) {
        timer.end();
        throw error;
      }
    };
    
    return descriptor;
  };
}

// Get all metrics
export function getAllMetrics() {
  const now = Date.now();
  
  // Calculate histogram statistics
  const histogramStats = {};
  for (const [key, values] of metrics.histograms) {
    if (values.length > 0) {
      const sorted = values.map(v => v.value).sort((a, b) => a - b);
      histogramStats[key] = {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)]
      };
    }
  }
  
  // Filter gauges to only include recent values (last 5 minutes)
  const recentGauges = {};
  for (const [key, data] of metrics.gauges) {
    if (now - data.timestamp < 300000) { // 5 minutes
      recentGauges[key] = data.value;
    }
  }
  
  return {
    counters: Object.fromEntries(metrics.counters),
    gauges: recentGauges,
    histograms: histogramStats,
    metadata: {
      last_reset: metrics.last_reset,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    }
  };
}

// Reset metrics
export function resetMetrics() {
  metrics.counters.clear();
  metrics.gauges.clear();
  metrics.histograms.clear();
  metrics.timers.clear();
  metrics.last_reset = new Date().toISOString();
  
  logHelpers.logBusinessEvent('metrics_reset');
}

// Express middleware for automatic metrics collection
export function metricsMiddleware() {
  return (req, res, next) => {
    const startTime = Date.now();
    
    // Increment request counter
    incrementCounter('http_requests_total');
    incrementCounter('http_requests_by_endpoint', 1, { endpoint: req.path, method: req.method });
    
    // Track response
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      
      // Record response metrics
      incrementCounter('http_requests_by_status', 1, { status: res.statusCode });
      recordHistogram('response_time', duration, { endpoint: req.path, method: req.method, status: res.statusCode });
      
      // Log slow requests
      if (duration > 5000) { // 5 seconds
        logHelpers.logPerformance('slow_request', duration, {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          userAgent: req.headers['user-agent']
        });
      }
    });
    
    next();
  };
}

// Business metrics helpers
export const businessMetrics = {
  // Track user activity
  trackUserActivity: (userId, action, metadata = {}) => {
    incrementCounter('users_active', 1, { userId, action });
    logHelpers.logBusinessEvent('user_activity', { userId, action, ...metadata });
  },
  
  // Track conversation metrics
  trackConversationStart: (userId, contactId) => {
    incrementCounter('conversations_started', 1, { userId });
    logHelpers.logBusinessEvent('conversation_started', { userId, contactId });
  },
  
  trackConversationEnd: (userId, contactId, messageCount) => {
    incrementCounter('conversations_completed', 1, { userId });
    logHelpers.logBusinessEvent('conversation_completed', { userId, contactId, messageCount });
  },
  
  // Track WhatsApp metrics
  trackWhatsAppMessage: (direction, type, success = true) => {
    if (direction === 'sent') {
      incrementCounter('whatsapp_messages_sent', 1, { type });
    } else {
      incrementCounter('whatsapp_messages_received', 1, { type });
    }
    
    if (!success) {
      incrementCounter('whatsapp_api_errors', 1, { direction, type });
    }
  },
  
  // Track AI metrics
  trackAIRequest: (success, responseTime, model = 'gpt-3.5-turbo') => {
    incrementCounter('ai_requests_total', 1, { model });
    
    if (success) {
      incrementCounter('ai_requests_successful', 1, { model });
    } else {
      incrementCounter('ai_requests_failed', 1, { model });
    }
    
    recordHistogram('ai_response_time', responseTime, { model });
  },
  
  // Track database metrics
  trackDatabaseQuery: (table, operation, duration, success = true) => {
    incrementCounter('database_queries_total', 1, { table, operation });
    recordHistogram('database_query_time', duration, { table, operation });
    
    if (!success) {
      incrementCounter('database_errors', 1, { table, operation });
    }
  }
};

// Error tracking
export function trackError(error, context = {}) {
  incrementCounter('errors_total', 1, { type: error.name || 'Unknown' });
  incrementCounter('errors_by_component', 1, { component: context.component || 'unknown' });
  
  logHelpers.logError(error, context);
  sentryHelpers.captureException(error, context);
}

// System metrics collection
export function collectSystemMetrics() {
  const memUsage = process.memoryUsage();
  
  setGauge('memory_usage_mb', Math.round(memUsage.heapUsed / 1024 / 1024));
  setGauge('memory_heap_total_mb', Math.round(memUsage.heapTotal / 1024 / 1024));
  setGauge('memory_rss_mb', Math.round(memUsage.rss / 1024 / 1024));
  
  // CPU usage (simplified)
  const cpuUsage = process.cpuUsage();
  setGauge('cpu_usage_percent', Math.round((cpuUsage.user + cpuUsage.system) / 1000000));
}

// Start metrics collection
export function startMetricsCollection(intervalMs = 30000) { // Default 30 seconds
  setInterval(() => {
    collectSystemMetrics();
  }, intervalMs);
  
  logHelpers.logBusinessEvent('metrics_collection_started', { interval_ms: intervalMs });
}

export default {
  incrementCounter,
  setGauge,
  incrementGauge,
  recordHistogram,
  startTimer,
  getAllMetrics,
  resetMetrics,
  metricsMiddleware,
  businessMetrics,
  trackError,
  collectSystemMetrics,
  startMetricsCollection
};
