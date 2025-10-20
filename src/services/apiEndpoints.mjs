/**
 * Custom API Endpoints System
 * Provides enterprise-grade API endpoints for external integrations
 */

import { db } from '../db.mjs';
import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';
import { ensureAuthed, getCurrentUserId } from '../middleware/auth.mjs';

// API endpoint types
export const API_ENDPOINT_TYPES = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH'
};

// API endpoint categories
export const API_CATEGORIES = {
  MESSAGES: 'messages',
  CONTACTS: 'contacts',
  CONVERSATIONS: 'conversations',
  APPOINTMENTS: 'appointments',
  ANALYTICS: 'analytics',
  WEBHOOKS: 'webhooks',
  SETTINGS: 'settings',
  USAGE: 'usage'
};

// Initialize API endpoint tables
export function initApiEndpointTables() {
  // API endpoint configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      query_params TEXT, -- JSON schema for query parameters
      request_body_schema TEXT, -- JSON schema for request body
      response_schema TEXT, -- JSON schema for response
      handler_function TEXT NOT NULL, -- Function name to handle the request
      authentication_required BOOLEAN DEFAULT 1,
      rate_limit_per_minute INTEGER DEFAULT 60,
      is_active BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, path, method)
    );
    CREATE INDEX IF NOT EXISTS idx_api_endpoints_user ON api_endpoints(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_endpoints_path ON api_endpoints(path);
    CREATE INDEX IF NOT EXISTS idx_api_endpoints_active ON api_endpoints(is_active);
  `);

  // API usage tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      endpoint_id INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      request_size INTEGER,
      response_size INTEGER,
      response_time_ms INTEGER,
      status_code INTEGER,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(endpoint_id) REFERENCES api_endpoints(id)
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage(endpoint_id);
    CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
  `);

  // API keys for authentication
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      permissions TEXT, -- JSON array of allowed endpoints
      rate_limit_per_minute INTEGER DEFAULT 60,
      expires_at INTEGER, -- Unix timestamp, NULL for no expiration
      last_used_at INTEGER,
      is_active BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);
  `);

  logHelpers.logBusinessEvent('api_endpoint_tables_initialized');
}

// Create a new API endpoint
export function createApiEndpoint(userId, endpointConfig) {
  const {
    name,
    path,
    method,
    category,
    description,
    queryParams = {},
    requestBodySchema = {},
    responseSchema = {},
    handlerFunction,
    authenticationRequired = true,
    rateLimitPerMinute = 60
  } = endpointConfig;

  // Validate method
  if (!Object.values(API_ENDPOINT_TYPES).includes(method)) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }

  // Validate category
  if (!Object.values(API_CATEGORIES).includes(category)) {
    throw new Error(`Invalid category: ${category}`);
  }

  // Validate path format
  if (!path.startsWith('/api/')) {
    throw new Error('API path must start with /api/');
  }

  const stmt = db.prepare(`
    INSERT INTO api_endpoints 
    (user_id, name, path, method, category, description, query_params, request_body_schema, response_schema, handler_function, authentication_required, rate_limit_per_minute)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    userId,
    name,
    path,
    method,
    category,
    description || null,
    JSON.stringify(queryParams),
    JSON.stringify(requestBodySchema),
    JSON.stringify(responseSchema),
    handlerFunction,
    authenticationRequired ? 1 : 0,
    rateLimitPerMinute
  );

  logHelpers.logBusinessEvent('api_endpoint_created', {
    userId,
    endpointId: result.lastInsertRowid,
    name,
    path,
    method,
    category
  });

  return result.lastInsertRowid;
}

// Get API endpoints for a user
export function getApiEndpoints(userId, category = null, activeOnly = true) {
  let query = 'SELECT * FROM api_endpoints WHERE user_id = ?';
  const params = [userId];

  if (activeOnly) {
    query += ' AND is_active = 1';
  }

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  const endpoints = stmt.all(...params);

  return endpoints.map(endpoint => ({
    ...endpoint,
    query_params: JSON.parse(endpoint.query_params || '{}'),
    request_body_schema: JSON.parse(endpoint.request_body_schema || '{}'),
    response_schema: JSON.parse(endpoint.response_schema || '{}'),
    authentication_required: Boolean(endpoint.authentication_required),
    is_active: Boolean(endpoint.is_active)
  }));
}

// Get a specific API endpoint
export function getApiEndpoint(endpointId, userId = null) {
  let query = 'SELECT * FROM api_endpoints WHERE id = ?';
  const params = [endpointId];

  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }

  const stmt = db.prepare(query);
  const endpoint = stmt.get(...params);

  if (!endpoint) return null;

  return {
    ...endpoint,
    query_params: JSON.parse(endpoint.query_params || '{}'),
    request_body_schema: JSON.parse(endpoint.request_body_schema || '{}'),
    response_schema: JSON.parse(endpoint.response_schema || '{}'),
    authentication_required: Boolean(endpoint.authentication_required),
    is_active: Boolean(endpoint.is_active)
  };
}

// Update API endpoint
export function updateApiEndpoint(endpointId, userId, updates) {
  const allowedFields = ['name', 'path', 'method', 'category', 'description', 'query_params', 'request_body_schema', 'response_schema', 'handler_function', 'authentication_required', 'rate_limit_per_minute', 'is_active'];
  const updateFields = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      updateFields.push(`${key} = ?`);
      if (['query_params', 'request_body_schema', 'response_schema'].includes(key)) {
        params.push(JSON.stringify(value));
      } else if (key === 'authentication_required' || key === 'is_active') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value);
      }
    }
  }

  if (updateFields.length === 0) {
    throw new Error('No valid fields to update');
  }

  updateFields.push('updated_at = (strftime(\'%s\',\'now\'))');
  params.push(endpointId, userId);

  const stmt = db.prepare(`
    UPDATE api_endpoints 
    SET ${updateFields.join(', ')}
    WHERE id = ? AND user_id = ?
  `);

  const result = stmt.run(...params);

  if (result.changes === 0) {
    throw new Error('API endpoint not found or not authorized');
  }

  logHelpers.logBusinessEvent('api_endpoint_updated', {
    userId,
    endpointId,
    updatedFields: Object.keys(updates)
  });

  return result.changes;
}

// Delete API endpoint
export function deleteApiEndpoint(endpointId, userId) {
  const stmt = db.prepare('DELETE FROM api_endpoints WHERE id = ? AND user_id = ?');
  const result = stmt.run(endpointId, userId);

  if (result.changes === 0) {
    throw new Error('API endpoint not found or not authorized');
  }

  logHelpers.logBusinessEvent('api_endpoint_deleted', {
    userId,
    endpointId
  });

  return result.changes;
}

// Create API key
export function createApiKey(userId, keyConfig) {
  const {
    name,
    permissions = [],
    rateLimitPerMinute = 60,
    expiresAt = null
  } = keyConfig;

  // Generate API key
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);

  const stmt = db.prepare(`
    INSERT INTO api_keys 
    (user_id, name, key_hash, permissions, rate_limit_per_minute, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    userId,
    name,
    keyHash,
    JSON.stringify(permissions),
    rateLimitPerMinute,
    expiresAt
  );

  logHelpers.logBusinessEvent('api_key_created', {
    userId,
    keyId: result.lastInsertRowid,
    name
  });

  return {
    id: result.lastInsertRowid,
    key: apiKey
  };
}

// Generate API key
function generateApiKey() {
  const prefix = 'wa_';
  const randomPart = require('crypto').randomBytes(32).toString('hex');
  return `${prefix}${randomPart}`;
}

// Hash API key for storage
function hashApiKey(apiKey) {
  return require('crypto').createHash('sha256').update(apiKey).digest('hex');
}

// Validate API key
export function validateApiKey(apiKey) {
  const keyHash = hashApiKey(apiKey);
  
  const stmt = db.prepare(`
    SELECT ak.*, u.id as user_id 
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ? AND ak.is_active = 1
  `);
  
  const keyData = stmt.get(keyHash);

  if (!keyData) {
    return null;
  }

  // Check expiration
  if (keyData.expires_at && keyData.expires_at < Math.floor(Date.now() / 1000)) {
    return null;
  }

  // Update last used timestamp
  const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
  updateStmt.run(Math.floor(Date.now() / 1000), keyData.id);

  return {
    userId: keyData.user_id,
    keyId: keyData.id,
    name: keyData.name,
    permissions: JSON.parse(keyData.permissions || '[]'),
    rateLimitPerMinute: keyData.rate_limit_per_minute
  };
}

// Get API keys for a user
export function getApiKeys(userId, activeOnly = true) {
  let query = 'SELECT * FROM api_keys WHERE user_id = ?';
  const params = [userId];

  if (activeOnly) {
    query += ' AND is_active = 1';
  }

  query += ' ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  const keys = stmt.all(...params);

  return keys.map(key => ({
    ...key,
    permissions: JSON.parse(key.permissions || '[]'),
    is_active: Boolean(key.is_active)
  }));
}

// Revoke API key
export function revokeApiKey(keyId, userId) {
  const stmt = db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?');
  const result = stmt.run(keyId, userId);

  if (result.changes === 0) {
    throw new Error('API key not found or not authorized');
  }

  logHelpers.logBusinessEvent('api_key_revoked', {
    userId,
    keyId
  });

  return result.changes;
}

// Log API usage
export function logApiUsage(userId, endpointId, usageData) {
  const {
    ipAddress,
    userAgent,
    requestSize = 0,
    responseSize = 0,
    responseTimeMs = 0,
    statusCode,
    errorMessage = null
  } = usageData;

  const stmt = db.prepare(`
    INSERT INTO api_usage 
    (user_id, endpoint_id, ip_address, user_agent, request_size, response_size, response_time_ms, status_code, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    userId,
    endpointId,
    ipAddress,
    userAgent,
    requestSize,
    responseSize,
    responseTimeMs,
    statusCode,
    errorMessage
  );

  // Update metrics
  businessMetrics.incrementCounter('api_requests_total', {
    endpointId,
    statusCode,
    userId
  });

  businessMetrics.observeHistogram('api_response_time_ms', {
    endpointId,
    userId
  }, responseTimeMs);
}

// Get API usage statistics
export function getApiUsageStats(userId, endpointId = null, days = 30) {
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  let query = `
    SELECT 
      ae.id,
      ae.name,
      ae.path,
      ae.method,
      COUNT(au.id) as total_requests,
      SUM(CASE WHEN au.status_code >= 200 AND au.status_code < 300 THEN 1 ELSE 0 END) as successful_requests,
      SUM(CASE WHEN au.status_code >= 400 THEN 1 ELSE 0 END) as error_requests,
      AVG(au.response_time_ms) as avg_response_time_ms,
      SUM(au.request_size) as total_request_size,
      SUM(au.response_size) as total_response_size
    FROM api_endpoints ae
    LEFT JOIN api_usage au ON ae.id = au.endpoint_id AND au.created_at >= ?
    WHERE ae.user_id = ?
  `;

  const params = [since, userId];

  if (endpointId) {
    query += ' AND ae.id = ?';
    params.push(endpointId);
  }

  query += ' GROUP BY ae.id ORDER BY total_requests DESC';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

// Built-in API handlers
export const builtInHandlers = {
  // Messages API
  'get_messages': async (req, res, userId) => {
    const { limit = 50, offset = 0, contactId, direction } = req.query;
    
    let query = 'SELECT * FROM messages WHERE user_id = ?';
    const params = [userId];

    if (contactId) {
      query += ' AND (from_id = ? OR to_id = ?)';
      params.push(contactId, contactId);
    }

    if (direction) {
      query += ' AND direction = ?';
      params.push(direction);
    }

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const stmt = db.prepare(query);
    const messages = stmt.all(...params);

    return {
      messages,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: messages.length
      }
    };
  },

  'send_message': async (req, res, userId) => {
    const { to, message, type = 'text' } = req.body;

    if (!to || !message) {
      throw new Error('Missing required fields: to, message');
    }

    // This would integrate with your existing message sending logic
    // For now, we'll create a placeholder
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const stmt = db.prepare(`
      INSERT INTO messages (id, user_id, direction, to_id, type, text_body, timestamp)
      VALUES (?, ?, 'outbound', ?, ?, ?, ?)
    `);

    stmt.run(messageId, userId, to, type, message, Math.floor(Date.now() / 1000));

    return {
      messageId,
      status: 'queued',
      to,
      message,
      type
    };
  },

  // Contacts API
  'get_contacts': async (req, res, userId) => {
    const { limit = 50, offset = 0, search } = req.query;

    let query = 'SELECT * FROM customers WHERE user_id = ?';
    const params = [userId];

    if (search) {
      query += ' AND (display_name LIKE ? OR contact_id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const stmt = db.prepare(query);
    const contacts = stmt.all(...params);

    return {
      contacts,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: contacts.length
      }
    };
  },

  'create_contact': async (req, res, userId) => {
    const { contactId, displayName, notes } = req.body;

    if (!contactId || !displayName) {
      throw new Error('Missing required fields: contactId, displayName');
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO customers (user_id, contact_id, display_name, notes, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(userId, contactId, displayName, notes || null, Math.floor(Date.now() / 1000));

    return {
      contactId,
      displayName,
      notes,
      status: 'created'
    };
  },

  // Analytics API
  'get_analytics': async (req, res, userId) => {
    const { period = '30d' } = req.query;
    
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

    // Message statistics
    const messageStats = db.prepare(`
      SELECT 
        direction,
        COUNT(*) as count,
        COUNT(DISTINCT from_id) as unique_senders
      FROM messages 
      WHERE user_id = ? AND timestamp >= ?
      GROUP BY direction
    `).all(userId, since);

    // Contact statistics
    const contactStats = db.prepare(`
      SELECT COUNT(*) as total_contacts
      FROM customers 
      WHERE user_id = ?
    `).get(userId);

    return {
      period,
      messages: messageStats,
      contacts: contactStats,
      generated_at: new Date().toISOString()
    };
  },

  // Webhooks API
  'get_webhooks': async (req, res, userId) => {
    const { status } = req.query;
    
    // Import webhook functions
    const { getWebhookConfigs } = await import('./webhooks.mjs');
    return getWebhookConfigs(userId, status);
  },

  'create_webhook': async (req, res, userId) => {
    const webhookConfig = req.body;
    
    // Import webhook functions
    const { createWebhookConfig } = await import('./webhooks.mjs');
    const webhookId = createWebhookConfig(userId, webhookConfig);
    
    return {
      webhookId,
      status: 'created',
      config: webhookConfig
    };
  }
};

// Initialize API endpoint system
export function initApiEndpointSystem() {
  initApiEndpointTables();
  logHelpers.logBusinessEvent('api_endpoint_system_initialized');
}
