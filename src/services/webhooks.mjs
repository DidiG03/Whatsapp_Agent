/**
 * Advanced Webhook System
 * Provides enterprise-grade webhook management with retry logic, signature verification, and event filtering
 */

import crypto from 'crypto';
import axios from 'axios';
import cron from 'node-cron';
import { db } from '../db.mjs';
import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';

// Webhook event types
export const WEBHOOK_EVENTS = {
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.updated',
  CONVERSATION_STARTED: 'conversation.started',
  CONVERSATION_ENDED: 'conversation.ended',
  HUMAN_HANDOFF: 'human.handoff',
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_REMINDER: 'appointment.reminder',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  PLAN_CHANGED: 'plan.changed',
  USAGE_LIMIT_REACHED: 'usage.limit_reached',
};

// Webhook statuses
export const WEBHOOK_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
};

// Delivery statuses
export const DELIVERY_STATUS = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  RETRYING: 'retrying',
};

// Initialize webhook tables
export function initWebhookTables() {
  // Webhook configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT NOT NULL, -- JSON array of event types
      status TEXT NOT NULL DEFAULT 'active',
      retry_count INTEGER DEFAULT 3,
      timeout_ms INTEGER DEFAULT 30000,
      headers TEXT, -- JSON object for custom headers
      filters TEXT, -- JSON object for event filtering
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_configs_user ON webhook_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_configs_status ON webhook_configs(status);
  `);

  // Webhook delivery attempts
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL, -- JSON payload
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      last_attempt_at INTEGER,
      next_retry_at INTEGER,
      response_status INTEGER,
      response_body TEXT,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(webhook_config_id) REFERENCES webhook_configs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_config ON webhook_deliveries(webhook_config_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at);
  `);

  // Webhook delivery logs for audit trail
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      delivery_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      request_url TEXT NOT NULL,
      request_headers TEXT, -- JSON
      request_body TEXT, -- JSON
      response_status INTEGER,
      response_headers TEXT, -- JSON
      response_body TEXT,
      response_time_ms INTEGER,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(webhook_config_id) REFERENCES webhook_configs(id),
      FOREIGN KEY(delivery_id) REFERENCES webhook_deliveries(id)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_delivery ON webhook_logs(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_config ON webhook_logs(webhook_config_id);
  `);

  logHelpers.logBusinessEvent('webhook_tables_initialized');
}

// Create a new webhook configuration
export function createWebhookConfig(userId, config) {
  const {
    name,
    url,
    secret,
    events,
    retryCount = 3,
    timeoutMs = 30000,
    headers = {},
    filters = {}
  } = config;

  // Validate URL
  try {
    new URL(url);
  } catch (error) {
    throw new Error('Invalid webhook URL');
  }

  // Validate events
  const validEvents = Object.values(WEBHOOK_EVENTS);
  const invalidEvents = events.filter(event => !validEvents.includes(event));
  if (invalidEvents.length > 0) {
    throw new Error(`Invalid events: ${invalidEvents.join(', ')}`);
  }

  const stmt = db.prepare(`
    INSERT INTO webhook_configs 
    (user_id, name, url, secret, events, retry_count, timeout_ms, headers, filters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    userId,
    name,
    url,
    secret || null,
    JSON.stringify(events),
    retryCount,
    timeoutMs,
    JSON.stringify(headers),
    JSON.stringify(filters)
  );

  logHelpers.logBusinessEvent('webhook_config_created', {
    userId,
    webhookId: result.lastInsertRowid,
    name,
    url,
    events: events.length
  });

  return result.lastInsertRowid;
}

// Get webhook configurations for a user
export function getWebhookConfigs(userId, status = null) {
  let query = 'SELECT * FROM webhook_configs WHERE user_id = ?';
  const params = [userId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  const configs = stmt.all(...params);

  return configs.map(config => ({
    ...config,
    events: JSON.parse(config.events),
    headers: JSON.parse(config.headers || '{}'),
    filters: JSON.parse(config.filters || '{}')
  }));
}

// Get a specific webhook configuration
export function getWebhookConfig(webhookId, userId = null) {
  let query = 'SELECT * FROM webhook_configs WHERE id = ?';
  const params = [webhookId];

  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }

  const stmt = db.prepare(query);
  const config = stmt.get(...params);

  if (!config) return null;

  return {
    ...config,
    events: JSON.parse(config.events),
    headers: JSON.parse(config.headers || '{}'),
    filters: JSON.parse(config.filters || '{}')
  };
}

// Update webhook configuration
export function updateWebhookConfig(webhookId, userId, updates) {
  const allowedFields = ['name', 'url', 'secret', 'events', 'status', 'retry_count', 'timeout_ms', 'headers', 'filters'];
  const updateFields = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      updateFields.push(`${key} = ?`);
      if (key === 'events' || key === 'headers' || key === 'filters') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value);
      }
    }
  }

  if (updateFields.length === 0) {
    throw new Error('No valid fields to update');
  }

  updateFields.push('updated_at = (strftime(\'%s\',\'now\'))');
  params.push(webhookId, userId);

  const stmt = db.prepare(`
    UPDATE webhook_configs 
    SET ${updateFields.join(', ')}
    WHERE id = ? AND user_id = ?
  `);

  const result = stmt.run(...params);

  if (result.changes === 0) {
    throw new Error('Webhook configuration not found or not authorized');
  }

  logHelpers.logBusinessEvent('webhook_config_updated', {
    userId,
    webhookId,
    updatedFields: Object.keys(updates)
  });

  return result.changes;
}

// Delete webhook configuration
export function deleteWebhookConfig(webhookId, userId) {
  const stmt = db.prepare('DELETE FROM webhook_configs WHERE id = ? AND user_id = ?');
  const result = stmt.run(webhookId, userId);

  if (result.changes === 0) {
    throw new Error('Webhook configuration not found or not authorized');
  }

  logHelpers.logBusinessEvent('webhook_config_deleted', {
    userId,
    webhookId
  });

  return result.changes;
}

// Generate webhook signature
function generateSignature(payload, secret) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Send webhook event
export async function sendWebhookEvent(userId, eventType, eventData) {
  const configs = getWebhookConfigs(userId, WEBHOOK_STATUS.ACTIVE);
  
  if (configs.length === 0) {
    logHelpers.logBusinessEvent('no_active_webhooks', { userId, eventType });
    return;
  }

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: eventData,
    userId: userId
  };

  const payloadString = JSON.stringify(payload);

  for (const config of configs) {
    // Check if this webhook is interested in this event type
    if (!config.events.includes(eventType)) {
      continue;
    }

    // Apply event filters
    if (!passesEventFilters(eventData, config.filters)) {
      continue;
    }

    // Create delivery record
    const deliveryId = createWebhookDelivery(config.id, eventType, payloadString);

    // Send immediately
    await processWebhookDelivery(deliveryId);
  }

  businessMetrics.incrementCounter('webhook_events_sent', { eventType, userId });
}

// Create webhook delivery record
function createWebhookDelivery(webhookConfigId, eventType, eventData) {
  const stmt = db.prepare(`
    INSERT INTO webhook_deliveries 
    (webhook_config_id, event_type, event_data, next_retry_at)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(
    webhookConfigId,
    eventType,
    eventData,
    Math.floor(Date.now() / 1000) // Retry immediately
  );

  return result.lastInsertRowid;
}

// Process webhook delivery
export async function processWebhookDelivery(deliveryId) {
  const deliveryStmt = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?');
  const delivery = deliveryStmt.get(deliveryId);

  if (!delivery) {
    logHelpers.logError(new Error('Webhook delivery not found'), { deliveryId });
    return;
  }

  const configStmt = db.prepare('SELECT * FROM webhook_configs WHERE id = ?');
  const config = configStmt.get(delivery.webhook_config_id);

  if (!config) {
    logHelpers.logError(new Error('Webhook configuration not found'), { deliveryId });
    return;
  }

  const configData = {
    ...config,
    events: JSON.parse(config.events),
    headers: JSON.parse(config.headers || '{}'),
    filters: JSON.parse(config.filters || '{}')
  };

  // Update attempt count
  const updateAttemptStmt = db.prepare(`
    UPDATE webhook_deliveries 
    SET attempt_count = attempt_count + 1, last_attempt_at = ?
    WHERE id = ?
  `);
  updateAttemptStmt.run(Math.floor(Date.now() / 1000), deliveryId);

  const startTime = Date.now();
  let success = false;
  let responseStatus = null;
  let responseBody = null;
  let errorMessage = null;

  try {
    // Prepare headers
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'WhatsApp-Agent-Webhook/1.0',
      ...configData.headers
    };

    // Add signature if secret is provided
    if (configData.secret) {
      const signature = generateSignature(delivery.event_data, configData.secret);
      headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    // Send webhook
    const response = await axios.post(configData.url, delivery.event_data, {
      headers,
      timeout: configData.timeout_ms,
      validateStatus: () => true // Don't throw on HTTP error status codes
    });

    responseStatus = response.status;
    responseBody = response.data;
    success = response.status >= 200 && response.status < 300;

    if (!success) {
      errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    }

  } catch (error) {
    errorMessage = error.message;
    logHelpers.logError(error, { 
      component: 'webhook_delivery', 
      deliveryId, 
      webhookUrl: configData.url 
    });
  }

  const responseTime = Date.now() - startTime;

  // Log the delivery attempt
  logWebhookDeliveryAttempt(deliveryId, configData.url, headers, delivery.event_data, responseStatus, responseBody, responseTime, errorMessage);

  // Update delivery status
  if (success) {
    const successStmt = db.prepare(`
      UPDATE webhook_deliveries 
      SET status = ?, response_status = ?, response_body = ?, updated_at = ?
      WHERE id = ?
    `);
    successStmt.run(DELIVERY_STATUS.DELIVERED, responseStatus, JSON.stringify(responseBody), Math.floor(Date.now() / 1000), deliveryId);

    businessMetrics.incrementCounter('webhook_deliveries_success', { 
      webhookId: configData.id, 
      eventType: delivery.event_type 
    });
  } else {
    // Check if we should retry
    const shouldRetry = delivery.attempt_count < configData.retry_count;
    
    if (shouldRetry) {
      // Calculate next retry time (exponential backoff)
      const retryDelay = Math.min(1000 * Math.pow(2, delivery.attempt_count), 300000); // Max 5 minutes
      const nextRetryAt = Math.floor(Date.now() / 1000) + Math.floor(retryDelay / 1000);

      const retryStmt = db.prepare(`
        UPDATE webhook_deliveries 
        SET status = ?, response_status = ?, response_body = ?, error_message = ?, next_retry_at = ?, updated_at = ?
        WHERE id = ?
      `);
      retryStmt.run(DELIVERY_STATUS.RETRYING, responseStatus, JSON.stringify(responseBody), errorMessage, nextRetryAt, Math.floor(Date.now() / 1000), deliveryId);

      businessMetrics.incrementCounter('webhook_deliveries_retry', { 
        webhookId: configData.id, 
        eventType: delivery.event_type,
        attempt: delivery.attempt_count + 1
      });
    } else {
      // Mark as failed
      const failedStmt = db.prepare(`
        UPDATE webhook_deliveries 
        SET status = ?, response_status = ?, response_body = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `);
      failedStmt.run(DELIVERY_STATUS.FAILED, responseStatus, JSON.stringify(responseBody), errorMessage, Math.floor(Date.now() / 1000), deliveryId);

      businessMetrics.incrementCounter('webhook_deliveries_failed', { 
        webhookId: configData.id, 
        eventType: delivery.event_type 
      });
    }
  }

  return { success, responseStatus, responseBody, errorMessage };
}

// Log webhook delivery attempt
function logWebhookDeliveryAttempt(deliveryId, url, headers, requestBody, responseStatus, responseBody, responseTime, errorMessage) {
  const stmt = db.prepare(`
    INSERT INTO webhook_logs 
    (webhook_config_id, delivery_id, attempt_number, request_url, request_headers, request_body, response_status, response_body, response_time_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deliveryStmt = db.prepare('SELECT webhook_config_id, attempt_count FROM webhook_deliveries WHERE id = ?');
  const delivery = deliveryStmt.get(deliveryId);

  stmt.run(
    delivery.webhook_config_id,
    deliveryId,
    delivery.attempt_count,
    url,
    JSON.stringify(headers),
    requestBody,
    responseStatus,
    JSON.stringify(responseBody),
    responseTime,
    errorMessage
  );
}

// Check if event data passes filters
function passesEventFilters(eventData, filters) {
  if (!filters || Object.keys(filters).length === 0) {
    return true;
  }

  for (const [key, expectedValue] of Object.entries(filters)) {
    const actualValue = getNestedValue(eventData, key);
    
    if (Array.isArray(expectedValue)) {
      if (!expectedValue.includes(actualValue)) {
        return false;
      }
    } else if (actualValue !== expectedValue) {
      return false;
    }
  }

  return true;
}

// Get nested value from object using dot notation
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// Process failed webhook deliveries (retry logic)
export async function processFailedWebhookDeliveries() {
  const stmt = db.prepare(`
    SELECT id FROM webhook_deliveries 
    WHERE status = ? AND next_retry_at <= ?
  `);
  
  const now = Math.floor(Date.now() / 1000);
  const failedDeliveries = stmt.all(DELIVERY_STATUS.RETRYING, now);

  logHelpers.logBusinessEvent('processing_failed_webhook_deliveries', { count: failedDeliveries.length });

  for (const delivery of failedDeliveries) {
    await processWebhookDelivery(delivery.id);
  }

  return failedDeliveries.length;
}

// Get webhook delivery statistics
export function getWebhookStats(userId, webhookId = null) {
  let query = `
    SELECT 
      wc.id,
      wc.name,
      wc.url,
      wc.status,
      COUNT(wd.id) as total_deliveries,
      SUM(CASE WHEN wd.status = 'delivered' THEN 1 ELSE 0 END) as successful_deliveries,
      SUM(CASE WHEN wd.status = 'failed' THEN 1 ELSE 0 END) as failed_deliveries,
      SUM(CASE WHEN wd.status = 'retrying' THEN 1 ELSE 0 END) as retrying_deliveries,
      AVG(wl.response_time_ms) as avg_response_time_ms
    FROM webhook_configs wc
    LEFT JOIN webhook_deliveries wd ON wc.id = wd.webhook_config_id
    LEFT JOIN webhook_logs wl ON wd.id = wl.delivery_id
    WHERE wc.user_id = ?
  `;
  
  const params = [userId];

  if (webhookId) {
    query += ' AND wc.id = ?';
    params.push(webhookId);
  }

  query += ' GROUP BY wc.id ORDER BY wc.created_at DESC';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

// Test webhook configuration
export async function testWebhookConfig(webhookId, userId) {
  const config = getWebhookConfig(webhookId, userId);
  
  if (!config) {
    throw new Error('Webhook configuration not found');
  }

  const testPayload = {
    event: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from WhatsApp Agent',
      testId: crypto.randomUUID()
    },
    userId: userId
  };

  const payloadString = JSON.stringify(testPayload);
  const deliveryId = createWebhookDelivery(webhookId, 'webhook.test', payloadString);
  
  const result = await processWebhookDelivery(deliveryId);
  
  return {
    success: result.success,
    responseStatus: result.responseStatus,
    responseBody: result.responseBody,
    errorMessage: result.errorMessage
  };
}

// Initialize webhook retry scheduler
export function startWebhookRetryScheduler() {
  // Run every minute to process failed webhook deliveries
  cron.schedule('* * * * *', async () => {
    try {
      const processedCount = await processFailedWebhookDeliveries();
      if (processedCount > 0) {
        logHelpers.logBusinessEvent('processed_failed_webhook_deliveries', { count: processedCount });
      }
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_retry_scheduler' });
    }
  });

  logHelpers.logBusinessEvent('webhook_retry_scheduler_started');
}

// Initialize webhook system
export function initWebhookSystem() {
  initWebhookTables();
  startWebhookRetryScheduler();
  logHelpers.logBusinessEvent('webhook_system_initialized');
}
