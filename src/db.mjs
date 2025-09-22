/**
 * SQLite database initialization and schema management.
 * - Creates core tables if absent
 * - Ensures multi-tenant support columns and indexes
 * - Adds normalized digit columns for faster phone lookups
 * - Adds AI settings columns idempotently
 */
import Database from "better-sqlite3";
import path from "node:path";
/** Singleton database connection used across the app. */
const DB_Path = process.env.DB_PATH || path.resolve("./data.sqlite");
export const db = new Database(DB_Path);
db.pragma("journal_mode = WAL");

// Core schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    from_id TEXT,
    to_id TEXT,
    type TEXT,
    text_body TEXT,
    timestamp INTEGER,
    raw JSON
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);

  CREATE TABLE IF NOT EXISTS message_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    recipient_id TEXT,
    timestamp INTEGER,
    error_code INTEGER,
    error_title TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_status_message_id ON message_statuses(message_id);

  CREATE TABLE IF NOT EXISTS kb_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT DEFAULT 'default',
    title TEXT,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS handoff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT UNIQUE,
    is_human BOOLEAN NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone_number_id TEXT,
    whatsapp_token TEXT,
    verify_token TEXT,
    app_secret TEXT,
    business_phone TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS settings_multi (
    user_id TEXT PRIMARY KEY,
    phone_number_id TEXT,
    whatsapp_token TEXT,
    verify_token TEXT,
    app_secret TEXT,
    business_phone TEXT,
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
`);

/**
 * Ensure multi-tenant support columns and indexes exist.
 * Adds a nullable user_id column to relevant tables, plus indexes.
 */
export function ensureUserScopedColumns() {
  try {
    const tables = ["messages", "message_statuses", "kb_items", "handoff"];
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      const hasUser = cols.some(c => c.name === "user_id");
      if (!hasUser) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`).run();
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_status_user ON message_statuses(user_id);
      CREATE INDEX IF NOT EXISTS idx_kb_user ON kb_items(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_handoff_contact_user ON handoff(contact_id, user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_user_title ON kb_items(user_id, title);
    `);
  } catch {}
}

/**
 * Ensure normalized phone digit columns exist on messages for faster lookups
 * and backfill existing rows once. Also adds supporting indexes.
 */
export function ensureDigitColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(messages)').all();
    const needFrom = !cols.some(c => c.name === 'from_digits');
    const needTo = !cols.some(c => c.name === 'to_digits');
    if (needFrom) db.prepare('ALTER TABLE messages ADD COLUMN from_digits TEXT').run();
    if (needTo) db.prepare('ALTER TABLE messages ADD COLUMN to_digits TEXT').run();
    if (needFrom || needTo) {
      const rows = db.prepare('SELECT id, from_id, to_id FROM messages').all();
      const upd = db.prepare('UPDATE messages SET from_digits = ?, to_digits = ? WHERE id = ?');
      for (const r of rows) {
        const fd = (r.from_id || '').replace(/[^0-9]/g, '') || null;
        const td = (r.to_id || '').replace(/[^0-9]/g, '') || null;
        try { upd.run(fd, td, r.id); } catch {}
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_from_digits ON messages(from_digits);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_to_digits ON messages(to_digits);');
    }
  } catch {}
}

/**
 * Ensure AI-related settings columns exist on settings_multi (idempotent).
 */
export function ensureAiSettingsColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(settings_multi)').all();
    const need = (n) => !cols.some(c => c.name === n);
    if (need('website_url')) db.prepare('ALTER TABLE settings_multi ADD COLUMN website_url TEXT').run();
    if (need('ai_tone')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_tone TEXT').run();
    if (need('ai_blocked_topics')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_blocked_topics TEXT').run();
    if (need('ai_style')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_style TEXT').run();
    if (need('entry_greeting')) db.prepare('ALTER TABLE settings_multi ADD COLUMN entry_greeting TEXT').run();
  } catch {}
}

// Perform ensures on import
ensureUserScopedColumns();
ensureDigitColumns();
ensureAiSettingsColumns();

