

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let testDb = null;
export function initTestDatabase(dbPath = ':memory:') {
  if (testDb) {
    testDb.close();
  }
  
  testDb = new Database(dbPath);
  testDb.pragma('journal_mode = WAL');
  createTestSchema(testDb);
  
  return testDb;
}
export function getTestDatabase() {
  if (!testDb) {
    return initTestDatabase();
  }
  return testDb;
}
export function cleanupTestDatabase() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
}
function createTestSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      direction TEXT NOT NULL,
      from_id TEXT,
      to_id TEXT,
      type TEXT,
      text_body TEXT,
      timestamp INTEGER,
      raw JSON
    );
    
    CREATE TABLE IF NOT EXISTS settings_multi (
      user_id TEXT PRIMARY KEY,
      phone_number_id TEXT,
      whatsapp_token TEXT,
      verify_token TEXT,
      app_secret TEXT,
      business_phone TEXT,
      business_name TEXT,
      website_url TEXT,
      ai_tone TEXT,
      ai_blocked_topics TEXT,
      ai_style TEXT,
      entry_greeting TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    
    CREATE TABLE IF NOT EXISTS kb_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, contact_id)
    );
    
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      link TEXT,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      metadata JSON
    );
    
    CREATE TABLE IF NOT EXISTS usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      month_year TEXT NOT NULL,
      inbound_messages INTEGER DEFAULT 0,
      outbound_messages INTEGER DEFAULT 0,
      template_messages INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, month_year)
    );
    
    CREATE TABLE IF NOT EXISTS user_plans (
      user_id TEXT PRIMARY KEY,
      plan_name TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      monthly_limit INTEGER DEFAULT 100,
      whatsapp_numbers INTEGER DEFAULT 1,
      billing_cycle_start INTEGER,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
}
export function seedTestDatabase(db, userId = 'test-user-id') {
  db.prepare(`
    INSERT OR REPLACE INTO settings_multi 
    (user_id, business_name, business_phone, ai_tone, entry_greeting)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, 'Test Business', '+1234567890', 'friendly', 'Hello! How can I help you?');
  db.prepare(`
    INSERT OR REPLACE INTO kb_items (user_id, title, content)
    VALUES (?, ?, ?)
  `).run(userId, 'Hours', 'We are open Monday-Friday 9AM-5PM');
  
  db.prepare(`
    INSERT OR REPLACE INTO kb_items (user_id, title, content)
    VALUES (?, ?, ?)
  `).run(userId, 'Location', 'We are located at 123 Main St, City, State');
  db.prepare(`
    INSERT OR REPLACE INTO customers (user_id, contact_id, display_name, notes)
    VALUES (?, ?, ?, ?)
  `).run(userId, '+1234567890', 'Test Customer', 'Test customer notes');
  db.prepare(`
    INSERT OR REPLACE INTO usage_stats (user_id, month_year, inbound_messages, outbound_messages)
    VALUES (?, ?, ?, ?)
  `).run(userId, '2024-01', 50, 30);
  db.prepare(`
    INSERT OR REPLACE INTO user_plans (user_id, plan_name, monthly_limit)
    VALUES (?, ?, ?)
  `).run(userId, 'free', 100);
}
export function clearTestDatabase(db) {
  const tables = [
    'messages', 'settings_multi', 'kb_items', 'customers', 
    'notifications', 'usage_stats', 'user_plans'
  ];
  
  tables.forEach(table => {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch (error) {
    }
  });
}
export function createTempTestDatabase() {
  const tempDir = path.join(process.cwd(), 'tests', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const dbPath = path.join(tempDir, `test-${Date.now()}.sqlite`);
  return dbPath;
}
export function cleanupTempTestDatabase(dbPath) {
  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  } catch (error) {
    console.warn('Failed to cleanup temp database:', error.message);
  }
}
