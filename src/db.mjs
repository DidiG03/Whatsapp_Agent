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

  -- FTS5 virtual table for KB search (title+content). Uses external content table.
  CREATE VIRTUAL TABLE IF NOT EXISTS kb_items_fts USING fts5(
    title,
    content,
    content='kb_items',
    content_rowid='id'
  );

  -- Triggers to keep FTS index in sync with kb_items
  CREATE TRIGGER IF NOT EXISTS kb_items_ai AFTER INSERT ON kb_items BEGIN
    INSERT INTO kb_items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS kb_items_ad AFTER DELETE ON kb_items BEGIN
    INSERT INTO kb_items_fts(kb_items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS kb_items_au AFTER UPDATE ON kb_items BEGIN
    INSERT INTO kb_items_fts(kb_items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO kb_items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;

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

  -- Calendars, Staff, Appointments for scheduling/booking
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
    notify_1h_sent INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(staff_id) REFERENCES staff(id)
  );
  CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments(user_id);
  CREATE INDEX IF NOT EXISTS idx_appt_staff ON appointments(staff_id);
  CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_ts);
  
  -- Temporary booking sessions (collecting user details via WhatsApp)
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

  -- Lightweight per-contact state (e.g., last greeting time) to throttle replies
  CREATE TABLE IF NOT EXISTS contact_state (
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    last_greet_ts INTEGER,
    PRIMARY KEY (user_id, contact_id)
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
 * Ensure KB supports optional file attachments (e.g., PDF menus).
 */
function ensureKbFileColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(kb_items)').all();
    const needUrl = !cols.some(c => c.name === 'file_url');
    const needMime = !cols.some(c => c.name === 'file_mime');
    if (needUrl) db.prepare('ALTER TABLE kb_items ADD COLUMN file_url TEXT').run();
    if (needMime) db.prepare('ALTER TABLE kb_items ADD COLUMN file_mime TEXT').run();
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
    if (need('business_name')) db.prepare('ALTER TABLE settings_multi ADD COLUMN business_name TEXT').run();
    if (need('website_url')) db.prepare('ALTER TABLE settings_multi ADD COLUMN website_url TEXT').run();
    if (need('ai_tone')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_tone TEXT').run();
    if (need('ai_blocked_topics')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_blocked_topics TEXT').run();
    if (need('ai_style')) db.prepare('ALTER TABLE settings_multi ADD COLUMN ai_style TEXT').run();
    if (need('entry_greeting')) db.prepare('ALTER TABLE settings_multi ADD COLUMN entry_greeting TEXT').run();
    if (need('bookings_enabled')) db.prepare('ALTER TABLE settings_multi ADD COLUMN bookings_enabled INTEGER DEFAULT 0').run();
    if (need('booking_questions_json')) db.prepare('ALTER TABLE settings_multi ADD COLUMN booking_questions_json TEXT').run();
    if (need('reschedule_min_lead_minutes')) db.prepare('ALTER TABLE settings_multi ADD COLUMN reschedule_min_lead_minutes INTEGER DEFAULT 60').run();
    if (need('cancel_min_lead_minutes')) db.prepare('ALTER TABLE settings_multi ADD COLUMN cancel_min_lead_minutes INTEGER DEFAULT 60').run();
    if (need('reminders_enabled')) db.prepare('ALTER TABLE settings_multi ADD COLUMN reminders_enabled INTEGER DEFAULT 0').run();
    if (need('reminder_windows')) db.prepare("ALTER TABLE settings_multi ADD COLUMN reminder_windows TEXT").run();
  } catch {}
}

// Perform ensures on import
ensureUserScopedColumns();
ensureDigitColumns();
ensureAiSettingsColumns();
ensureKbFileColumns();

/**
 * Ensure booking_sessions has latest columns for dynamic Q&A.
 */
function ensureBookingSessionColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info(booking_sessions)").all();
    if (!cols || !cols.length) return; // table might not exist yet
    const need = (n) => !cols.some(c => c.name === n);
    if (need('question_index')) db.prepare("ALTER TABLE booking_sessions ADD COLUMN question_index INTEGER DEFAULT 0").run();
    if (need('answers_json')) db.prepare("ALTER TABLE booking_sessions ADD COLUMN answers_json TEXT").run();
    // Normalize legacy step values to 'pending'
    try { db.prepare("UPDATE booking_sessions SET step = 'pending' WHERE step NOT IN ('pending')").run(); } catch {}
  } catch {}
}

ensureBookingSessionColumns();

