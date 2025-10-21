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
// This is the complete schema from db.mjs for serverless compatibility
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
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

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
  CREATE INDEX IF NOT EXISTS idx_status_message_id ON message_statuses(message_id);
  CREATE INDEX IF NOT EXISTS idx_status_user ON message_statuses(user_id);

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_user_id ON message_reactions(user_id);

  CREATE TABLE IF NOT EXISTS message_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_message_id TEXT NOT NULL,
    reply_message_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(original_message_id, reply_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_replies_original ON message_replies(original_message_id);
  CREATE INDEX IF NOT EXISTS idx_replies_reply ON message_replies(reply_message_id);

  CREATE TABLE IF NOT EXISTS kb_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    user_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_kb_user ON kb_items(user_id);

  CREATE TABLE IF NOT EXISTS handoff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT,
    is_human BOOLEAN NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    user_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_handoff_contact_user ON handoff(contact_id, user_id);

  CREATE TABLE IF NOT EXISTS ai_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    success BOOLEAN NOT NULL DEFAULT 1,
    response_time INTEGER,
    model TEXT DEFAULT 'gpt-3.5-turbo',
    tokens_used INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_requests_user_id ON ai_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_requests_created_at ON ai_requests(created_at);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    dashboard_preferences TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_settings_updated_at ON user_settings(updated_at);

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

  CREATE TABLE IF NOT EXISTS onboarding_state (
    user_id TEXT PRIMARY KEY,
    step INTEGER NOT NULL DEFAULT 0,
    transcript TEXT DEFAULT '',
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google',
    account_email TEXT,
    calendar_id TEXT,
    refresh_token TEXT,
    access_token TEXT,
    token_expiry INTEGER,
    timezone TEXT,
    display_name TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_calendars_user ON calendars(user_id);
  CREATE INDEX IF NOT EXISTS idx_calendars_calendar_id ON calendars(calendar_id);

  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    calendar_id INTEGER,
    timezone TEXT,
    slot_minutes INTEGER DEFAULT 30,
    working_hours_json TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(calendar_id) REFERENCES calendars(id)
  );
  CREATE INDEX IF NOT EXISTS idx_staff_user ON staff(user_id);
  CREATE INDEX IF NOT EXISTS idx_staff_calendar ON staff(calendar_id);

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    staff_id INTEGER NOT NULL,
    contact_phone TEXT,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    gcal_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    notes TEXT,
    notify_24h_sent INTEGER DEFAULT 0,
    notify_4h_sent INTEGER DEFAULT 0,
    notify_2h_sent INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(staff_id) REFERENCES staff(id)
  );
  CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments(user_id);
  CREATE INDEX IF NOT EXISTS idx_appt_staff ON appointments(staff_id);
  CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_ts);
  
  CREATE TABLE IF NOT EXISTS booking_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    staff_id INTEGER NOT NULL,
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    step TEXT NOT NULL DEFAULT 'pending',
    question_index INTEGER DEFAULT 0,
    answers_json TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_booking_session ON booking_sessions(user_id, contact_id);

  CREATE TABLE IF NOT EXISTS contact_state (
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    last_greet_ts INTEGER,
    PRIMARY KEY (user_id, contact_id)
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
  CREATE INDEX IF NOT EXISTS idx_customers_user_contact ON customers(user_id, contact_id);

  CREATE TABLE IF NOT EXISTS contact_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6',
    description TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_tags_user ON contact_tags(user_id);

  CREATE TABLE IF NOT EXISTS contact_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    interaction_type TEXT NOT NULL,
    interaction_data TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contact_interactions_user_contact ON contact_interactions(user_id, contact_id);
  CREATE INDEX IF NOT EXISTS idx_contact_interactions_type ON contact_interactions(user_id, interaction_type);

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
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);

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
  CREATE INDEX IF NOT EXISTS idx_usage_stats_user_month ON usage_stats(user_id, month_year);

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

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT DEFAULT 'General',
    display_order INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, text)
  );
`;

// Initialize schema for serverless environment
try {
  db.exec(SERVERLESS_SCHEMA);
  console.log('Serverless database schema initialized successfully');
} catch (error) {
  console.error('Error initializing serverless database:', error);
  // Don't throw - let the app continue without database if needed
}

// Export the same interface as the original db.mjs
export { db };
export default db;
