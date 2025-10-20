/**
 * PostgreSQL Database Adapter with Connection Pooling
 * Provides enterprise-grade database support with connection pooling and migrations
 */

import pg from 'pg';
import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';

const { Pool } = pg;

// Database configuration
const dbConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'whatsapp_agent',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'password',
  // Connection pool settings
  max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20'),
  min: parseInt(process.env.POSTGRES_MIN_CONNECTIONS || '5'),
  idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT || '10000'),
  // SSL configuration
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Application name for monitoring
  application_name: 'whatsapp-agent'
};

// Create connection pool
let pool = null;
let isConnected = false;

export function initPostgreSQL() {
  try {
    pool = new Pool(dbConfig);
    
    pool.on('connect', (client) => {
      isConnected = true;
      logHelpers.logBusinessEvent('postgres_connected', { 
        host: dbConfig.host, 
        port: dbConfig.port,
        database: dbConfig.database 
      });
    });
    
    pool.on('error', (error) => {
      isConnected = false;
      logHelpers.logError(error, { component: 'postgres', operation: 'pool_error' });
    });
    
    pool.on('remove', (client) => {
      logHelpers.logBusinessEvent('postgres_client_removed');
    });
    
    return pool;
  } catch (error) {
    logHelpers.logError(error, { component: 'postgres', operation: 'initialization' });
    return null;
  }
}

// Get database pool
export function getPool() {
  if (!pool) {
    pool = initPostgreSQL();
  }
  return pool;
}

// Check if database is connected
export function isPostgreSQLConnected() {
  return isConnected && pool && !pool.ended;
}

// Database operations with performance tracking
export const db = {
  // Execute query with performance tracking
  async query(text, params = []) {
    const startTime = Date.now();
    
    if (!isPostgreSQLConnected()) {
      throw new Error('Database not connected');
    }
    
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - startTime;
      
      // Track database metrics
      businessMetrics.trackDatabaseQuery(
        this.extractTableName(text),
        this.extractOperation(text),
        duration,
        true
      );
      
      logHelpers.logDatabase(
        this.extractOperation(text),
        this.extractTableName(text),
        duration,
        { rowCount: result.rowCount }
      );
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      businessMetrics.trackDatabaseQuery(
        this.extractTableName(text),
        this.extractOperation(text),
        duration,
        false
      );
      
      logHelpers.logError(error, { 
        component: 'postgres', 
        operation: 'query',
        query: text.substring(0, 100),
        params: params.length
      });
      
      throw error;
    }
  },
  
  // Get a client from the pool for transactions
  async getClient() {
    if (!isPostgreSQLConnected()) {
      throw new Error('Database not connected');
    }
    
    return await pool.connect();
  },
  
  // Execute transaction
  async transaction(callback) {
    const client = await this.getClient();
    const startTime = Date.now();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      
      const duration = Date.now() - startTime;
      logHelpers.logDatabase('transaction', 'multiple', duration, { success: true });
      
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      
      const duration = Date.now() - startTime;
      logHelpers.logDatabase('transaction', 'multiple', duration, { success: false });
      
      logHelpers.logError(error, { component: 'postgres', operation: 'transaction' });
      throw error;
    } finally {
      client.release();
    }
  },
  
  // Helper methods
  extractTableName(query) {
    const match = query.match(/FROM\s+(\w+)/i) || query.match(/UPDATE\s+(\w+)/i) || query.match(/INSERT\s+INTO\s+(\w+)/i);
    return match ? match[1] : 'unknown';
  },
  
  extractOperation(query) {
    const trimmed = query.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'select';
    if (trimmed.startsWith('INSERT')) return 'insert';
    if (trimmed.startsWith('UPDATE')) return 'update';
    if (trimmed.startsWith('DELETE')) return 'delete';
    if (trimmed.startsWith('CREATE')) return 'create';
    if (trimmed.startsWith('DROP')) return 'drop';
    if (trimmed.startsWith('ALTER')) return 'alter';
    return 'other';
  },
  
  // Health check
  async healthCheck() {
    try {
      const result = await this.query('SELECT NOW() as current_time, version() as version');
      return {
        connected: true,
        currentTime: result.rows[0].current_time,
        version: result.rows[0].version,
        poolStats: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount
        }
      };
    } catch (error) {
      return {
        connected: false,
        error: error.message
      };
    }
  }
};

// Database schema and migrations
export const migrations = {
  // Create tables if they don't exist
  async createTables() {
    const tables = [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        clerk_user_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        metadata JSONB DEFAULT '{}'
      )`,
      
      // Settings table
      `CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        phone_number_id VARCHAR(255),
        whatsapp_token TEXT,
        verify_token VARCHAR(255),
        app_secret VARCHAR(255),
        business_phone VARCHAR(50),
        business_name VARCHAR(255),
        website_url VARCHAR(500),
        ai_tone VARCHAR(50) DEFAULT 'friendly',
        ai_blocked_topics TEXT,
        ai_style VARCHAR(50) DEFAULT 'concise',
        entry_greeting TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      )`,
      
      // Messages table
      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message_id VARCHAR(255) UNIQUE NOT NULL,
        direction VARCHAR(20) NOT NULL,
        from_id VARCHAR(50) NOT NULL,
        to_id VARCHAR(50) NOT NULL,
        type VARCHAR(50) NOT NULL,
        text_body TEXT,
        media_url VARCHAR(1000),
        media_type VARCHAR(50),
        timestamp BIGINT NOT NULL,
        status VARCHAR(50) DEFAULT 'sent',
        raw JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Customers table
      `CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        contact_id VARCHAR(50) NOT NULL,
        display_name VARCHAR(255),
        notes TEXT,
        tags TEXT[],
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, contact_id)
      )`,
      
      // Knowledge base table
      `CREATE TABLE IF NOT EXISTS kb_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(100),
        tags TEXT[],
        is_active BOOLEAN DEFAULT true,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Conversations table
      `CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        contact_id VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        last_message_at TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, contact_id)
      )`,
      
      // Usage tracking table
      `CREATE TABLE IF NOT EXISTS usage_tracking (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        messages_sent INTEGER DEFAULT 0,
        messages_received INTEGER DEFAULT 0,
        ai_requests INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      )`
    ];
    
    for (const table of tables) {
      await db.query(table);
    }
    
    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_messages_from_id ON messages(from_id)',
      'CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_kb_items_user_id ON kb_items(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id)',
      'CREATE INDEX IF NOT EXISTS idx_usage_tracking_user_date ON usage_tracking(user_id, date)'
    ];
    
    for (const index of indexes) {
      await db.query(index);
    }
    
    logHelpers.logBusinessEvent('postgres_tables_created');
  },
  
  // Run migrations
  async runMigrations() {
    try {
      await this.createTables();
      logHelpers.logBusinessEvent('postgres_migrations_completed');
    } catch (error) {
      logHelpers.logError(error, { component: 'postgres', operation: 'migrations' });
      throw error;
    }
  }
};

// Database adapter that can work with both SQLite and PostgreSQL
export const databaseAdapter = {
  // Initialize database based on configuration
  async init() {
    if (process.env.DATABASE_TYPE === 'postgresql') {
      await initPostgreSQL();
      await migrations.runMigrations();
      return 'postgresql';
    } else {
      // Fallback to SQLite
      logHelpers.logBusinessEvent('database_fallback_sqlite');
      return 'sqlite';
    }
  },
  
  // Get appropriate database instance
  getInstance() {
    if (process.env.DATABASE_TYPE === 'postgresql' && isPostgreSQLConnected()) {
      return db;
    } else {
      // Return SQLite instance (from existing db.mjs)
      const { db: sqliteDb } = require('../db.mjs');
      return sqliteDb;
    }
  },
  
  // Health check
  async healthCheck() {
    if (process.env.DATABASE_TYPE === 'postgresql') {
      return await db.healthCheck();
    } else {
      // SQLite health check
      try {
        const sqliteDb = this.getInstance();
        sqliteDb.prepare('SELECT 1').get();
        return { connected: true, type: 'sqlite' };
      } catch (error) {
        return { connected: false, error: error.message, type: 'sqlite' };
      }
    }
  }
};

// Initialize PostgreSQL on module load
if (process.env.DATABASE_TYPE === 'postgresql') {
  initPostgreSQL();
}

export default {
  db,
  migrations,
  databaseAdapter,
  isPostgreSQLConnected,
  getPool
};
