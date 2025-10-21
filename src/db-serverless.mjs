/**
 * Serverless Database Configuration for Vercel
 * This module provides database configuration optimized for serverless environments
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "fs";

// For serverless environments, we need to handle database persistence differently
function getServerlessDbPath() {
  // In Vercel, we use /tmp for temporary storage
  // Note: This data will be lost between function invocations
  const tmpDir = "/tmp";
  
  // Ensure tmp directory exists
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  
  return path.join(tmpDir, "whatsapp-agent.sqlite");
}

// Use environment-specific database path
const DB_PATH = process.env.VERCEL 
  ? getServerlessDbPath() 
  : (process.env.DB_PATH || path.resolve("./data.sqlite"));

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// For serverless, we need to ensure the database is initialized on each cold start
// This is a simplified version of the original schema for serverless compatibility
const SERVERLESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    from_id TEXT,
    to_id TEXT,
    type TEXT,
    text_body TEXT,
    timestamp INTEGER,
    raw JSON,
    user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS message_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    recipient_id TEXT,
    timestamp INTEGER,
    error_code INTEGER,
    error_title TEXT,
    error_message TEXT,
    user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS kb_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS handoff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT,
    is_human BOOLEAN NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    user_id TEXT
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

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    dashboard_preferences TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_from_digits ON messages(from_digits);
  CREATE INDEX IF NOT EXISTS idx_messages_to_digits ON messages(to_digits);
  CREATE INDEX IF NOT EXISTS idx_status_user ON message_statuses(user_id);
  CREATE INDEX IF NOT EXISTS idx_kb_user ON kb_items(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_handoff_contact_user ON handoff(contact_id, user_id);
`;

// Initialize schema for serverless environment
if (process.env.VERCEL) {
  try {
    db.exec(SERVERLESS_SCHEMA);
    console.log('Serverless database schema initialized');
  } catch (error) {
    console.error('Error initializing serverless database:', error);
  }
}

// Export the same interface as the original db.mjs
export { db as default };
