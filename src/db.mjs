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
    contact_id TEXT,
    is_human BOOLEAN NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

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

  -- Legacy 'settings' table removed in favor of settings_multi. Dropped at runtime if present.

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
    notify_4h_sent INTEGER DEFAULT 0,
    notify_2h_sent INTEGER DEFAULT 0,
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

  -- Enhanced customer profiles for contacts (per user)
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

  -- Contact tags for categorization
  CREATE TABLE IF NOT EXISTS contact_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6', -- Hex color for tag display
    description TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_tags_user ON contact_tags(user_id);

  -- Contact interaction history for analytics
  CREATE TABLE IF NOT EXISTS contact_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    interaction_type TEXT NOT NULL, -- message, call, meeting, note
    interaction_data TEXT, -- JSON field for interaction details
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contact_interactions_user_contact ON contact_interactions(user_id, contact_id);
  CREATE INDEX IF NOT EXISTS idx_contact_interactions_type ON contact_interactions(user_id, interaction_type);

  -- Notifications for web alerts
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

  -- Usage tracking for billing and plan limits
  CREATE TABLE IF NOT EXISTS usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    month_year TEXT NOT NULL, -- Format: "2024-01"
    inbound_messages INTEGER DEFAULT 0,
    outbound_messages INTEGER DEFAULT 0,
    template_messages INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, month_year)
  );
  CREATE INDEX IF NOT EXISTS idx_usage_stats_user_month ON usage_stats(user_id, month_year);

  -- User plans and billing
  CREATE TABLE IF NOT EXISTS user_plans (
    user_id TEXT PRIMARY KEY,
    plan_name TEXT NOT NULL DEFAULT 'free', -- free, starter, professional, business
    status TEXT NOT NULL DEFAULT 'active', -- active, cancelled, suspended
    monthly_limit INTEGER DEFAULT 100, -- Monthly message limit
    whatsapp_numbers INTEGER DEFAULT 1, -- Number of WhatsApp numbers allowed
    billing_cycle_start INTEGER, -- Unix timestamp of billing cycle start
    stripe_customer_id TEXT, -- Stripe customer ID
    stripe_subscription_id TEXT, -- Stripe subscription ID
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  -- Quick replies for users
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
 * Migrate existing customers table to enhanced structure
 */
export function migrateCustomersTable() {
  try {
    const cols = db.prepare(`PRAGMA table_info(customers)`).all();
    const existingColumns = cols.map(c => c.name);
    
    const newColumns = [
      'first_name', 'last_name', 'email', 'company', 'job_title',
      'profile_photo_url', 'phone_alternative', 'address', 'city', 'state',
      'country', 'postal_code', 'website', 'social_media', 'custom_fields',
      'tags', 'status', 'source', 'last_contacted', 'total_messages'
    ];
    
    for (const col of newColumns) {
      if (!existingColumns.includes(col)) {
        let colDef = 'TEXT';
        if (col === 'total_messages') colDef = 'INTEGER DEFAULT 0';
        if (col === 'status') colDef = "TEXT DEFAULT 'active'";
        if (col === 'last_contacted') colDef = 'INTEGER';
        
        try {
          db.prepare(`ALTER TABLE customers ADD COLUMN ${col} ${colDef}`).run();
        } catch (e) {
          console.log(`Column ${col} already exists or could not be added:`, e.message);
        }
      }
    }
    
    // Create new indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(user_id, email);
      CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(user_id, company);
      CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(user_id, status);
    `);
    
  } catch (e) {
    console.log('Error migrating customers table:', e.message);
  }
}

/**
 * Ensure KB supports optional file attachments (e.g., PDF menus).
 */
function ensureKbFileColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(kb_items)').all();
    const needUrl = !cols.some(c => c.name === 'file_url');
    const needMime = !cols.some(c => c.name === 'file_mime');
    const needShow = !cols.some(c => c.name === 'show_in_menu');
    if (needUrl) db.prepare('ALTER TABLE kb_items ADD COLUMN file_url TEXT').run();
    if (needMime) db.prepare('ALTER TABLE kb_items ADD COLUMN file_mime TEXT').run();
    if (needShow) db.prepare('ALTER TABLE kb_items ADD COLUMN show_in_menu INTEGER DEFAULT 0').run();
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
    if (need('wa_template_name')) db.prepare('ALTER TABLE settings_multi ADD COLUMN wa_template_name TEXT').run();
    if (need('wa_template_language')) db.prepare('ALTER TABLE settings_multi ADD COLUMN wa_template_language TEXT').run();
    if (need('escalation_email_enabled')) db.prepare('ALTER TABLE settings_multi ADD COLUMN escalation_email_enabled INTEGER DEFAULT 0').run();
    if (need('escalation_email')) db.prepare('ALTER TABLE settings_multi ADD COLUMN escalation_email TEXT').run();
    if (need('smtp_host')) db.prepare('ALTER TABLE settings_multi ADD COLUMN smtp_host TEXT').run();
    if (need('smtp_port')) db.prepare('ALTER TABLE settings_multi ADD COLUMN smtp_port INTEGER DEFAULT 587').run();
    if (need('smtp_secure')) db.prepare('ALTER TABLE settings_multi ADD COLUMN smtp_secure INTEGER DEFAULT 0').run();
    if (need('smtp_user')) db.prepare('ALTER TABLE settings_multi ADD COLUMN smtp_user TEXT').run();
    if (need('smtp_pass')) db.prepare('ALTER TABLE settings_multi ADD COLUMN smtp_pass TEXT').run();
  } catch {}
}

// Perform ensures on import
ensureUserScopedColumns();
ensureDigitColumns();
ensureAiSettingsColumns();
ensureKbFileColumns();
migrateCustomersTable();

/**
 * Ensure extra columns on handoff for inbox management (archive/delete flags).
 */
function ensureHandoffExtras() {
  try {
    const cols = db.prepare('PRAGMA table_info(handoff)').all();
    const needArchived = !cols.some(c => c.name === 'is_archived');
    const needDeletedAt = !cols.some(c => c.name === 'deleted_at');
    const needLastSeen = !cols.some(c => c.name === 'last_seen_ts');
    const needEscalationStep = !cols.some(c => c.name === 'escalation_step');
    const needEscalationReason = !cols.some(c => c.name === 'escalation_reason');
    const needHumanExpires = !cols.some(c => c.name === 'human_expires_ts');
    // Ensure global UNIQUE on contact_id is removed; rely on composite unique created elsewhere
    try { db.exec("DROP INDEX IF EXISTS sqlite_autoindex_handoff_1"); } catch {}
    if (needArchived) db.prepare('ALTER TABLE handoff ADD COLUMN is_archived INTEGER DEFAULT 0').run();
    if (needDeletedAt) db.prepare('ALTER TABLE handoff ADD COLUMN deleted_at INTEGER').run();
    if (needLastSeen) db.prepare('ALTER TABLE handoff ADD COLUMN last_seen_ts INTEGER DEFAULT 0').run();
    if (needEscalationStep) db.prepare('ALTER TABLE handoff ADD COLUMN escalation_step TEXT').run();
    if (needEscalationReason) db.prepare('ALTER TABLE handoff ADD COLUMN escalation_reason TEXT').run();
    if (needHumanExpires) db.prepare('ALTER TABLE handoff ADD COLUMN human_expires_ts INTEGER DEFAULT 0').run();
  } catch {}
}

ensureHandoffExtras();

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

// Cleanup legacy schema objects safely
function cleanupLegacySchema() {
  try {
    // Drop legacy single-tenant settings table if it exists
    db.exec("DROP TABLE IF EXISTS settings");
    // Drop legacy tenant_id column from kb_items if it somehow still exists (noop if not present)
    try {
      const cols = db.prepare('PRAGMA table_info(kb_items)').all();
      if (cols.some(c => c.name === 'tenant_id')) {
        // SQLite cannot drop columns easily; rebuild would be required.
        // Skip destructive migration automatically to avoid data loss.
        // The column is ignored by code; leaving it is harmless.
      }
    } catch {}
  } catch {}
}

ensureBookingSessionColumns();
cleanupLegacySchema();


/**
 * Ensure guides (help/blog) table exists and seed an initial article.
 */
function ensureGuides() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE,
        title TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guides_slug ON guides(slug);

      CREATE TABLE IF NOT EXISTS enquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        status TEXT DEFAULT 'new'
      );
    `);
  } catch {}
}

function seedGuides() {
  try {
    const count = db.prepare(`SELECT COUNT(1) AS c FROM guides`).get()?.c || 0;
    const upsert = (slug, title, summary, content) => {
      const row = db.prepare(`SELECT id FROM guides WHERE slug = ?`).get(slug);
      if (row?.id) {
        db.prepare(`UPDATE guides SET title = ?, summary = ?, content = ? WHERE slug = ?`).run(title, summary, content, slug);
      } else {
        db.prepare(`INSERT INTO guides (slug, title, summary, content) VALUES (?, ?, ?, ?)`).run(slug, title, summary, content);
      }
    };

    // Getting started
    const gs = [
      '',
      'This guide walks you through creating a Meta developer setup, connecting WhatsApp Business, verifying the webhook, and sending your first automated reply.',
      '',
      '![WhatsApp Agent Setup](/ex-mark-icon.png)',
      '',
      'Prerequisites:',
      '- A Meta Business account and a WhatsApp Business number (or a test number).',
      '- Ability to set environment variables and restart the server.',
      '',
      '**Step 1: Getting Started with WhatsApp Agent**',
      '1) Go to Meta for Developers and sign up/log in: https://developers.facebook.com',
      '2) Create a new App (choose a Business type). [Image: Create App screen]',
      '![WhatsApp App Create](/whatsapp-business-itegration-2.png)',
      '',   
      '3) In the App dashboard, add the WhatsApp product. [Image: Add Product → WhatsApp]',
      '![WhatsApp Product Add](/whatsapp-business-itegration-4.png)',
      '',
      '**Step 2: Generate a long‑lived token and find your App Secret**',
      '1) In WhatsApp → Getting Started or API Setup, follow the steps to create a System User and generate a long‑lived token with scopes:',
      '   whatsapp_business_messaging, whatsapp_business_management. [Image: Permissions checklist]',
      '![WhatsApp Permissions](/whatsapp-business-itegration-5.png)',
      '',
      '2) Note your App Secret from App settings → Basic. [Image: App Secret field]',
      '',
      '**Step 3: Get your Phone Number ID and Business Number**',
      '1) In WhatsApp Manager, add or select your number. [Image: WhatsApp Manager numbers]',
      '![WhatsApp Manager Numbers](/whatsapp-business-itegration-6.png)',
      '',
      '2) Copy the Phone Number ID and your formatted Business Phone (digits only). [Image: Phone Number ID]',
      '',
      '**Step 4: Configure this app (Settings → WhatsApp Setup)**',
      '1) Open Settings in the dashboard and paste:',
      '   - Phone Number ID',
      '   - WhatsApp Token (long‑lived)',
      '   - App Secret',
      '   - Business Phone (digits)',
      '2) Choose a Verify Token (any strong string). You will reuse it during webhook setup.',
      '',
      '**Step 5: Set up the Webhook in Meta**',
      '1) In your Meta App → WhatsApp → Configuration → Webhooks, click “Configure Webhooks”.',
      '2) Set Callback URL to https://YOUR_DOMAIN/webhook and use the same Verify Token as above.',
      '3) Click Verify & Save. Meta will call GET /webhook and this app will return the challenge if the token matches.',
      '![WhatsApp Webhooks](/whatsapp_agent.png)',
      '',
      '4) Subscribe to events (messages).',
      '![WhatsApp Webhooks](/whatsapp_messages_events.png)',
      '', 
      '**Step 6: Add business info & Knowledge Base**',
      '1) In Settings → Personal Information, set Business Name and Website URL.',
      '2) In Knowledge Base, add entries like Hours, Locations, Payments. You can also upload PDFs; the bot will share them when relevant.',
      '',
      '**Step 7: Test**',
      '1) From your phone, send a WhatsApp message to the Business number.',
      '2) Try a simple question (e.g., “What are your hours?”). The bot answers from your KB or sends a helpful prompt.',
      '3) For bookings (optional), enable “Enable bookings via WhatsApp & dashboard” and try saying “book”.',
      '',
      'Troubleshooting:',
      '- If webhook verification fails, confirm Verify Token matches exactly and your domain is HTTPS and public.',
      '- If replies fail, re‑check Phone Number ID, Token, and App Secret in Settings.',
      '- Use the server logs for “KB Matches” or webhook errors to pinpoint configuration issues.',
      '',
      'You’re set — add more KB entries over time for richer, more accurate answers.'
    ].join('\n');
    upsert('getting-started', 'Getting Started with WhatsApp Agent', 'Create Meta app, connect WhatsApp, verify webhook, and send your first reply.', gs);

    // Best practices
    const bp = [
      '# Best Practices for a Helpful Knowledge Base',
      '',
      'Your KB powers instant, accurate replies. Use these tips to keep answers tight and useful:',
      '',
      '- Prefer short sentences and concrete facts (hours, prices, locations).',
      '- Group related info under clear titles (Payments, Returns, Delivery).',
      '- Add PDFs for menus, service catalogs, or forms to enable file replies.',
      '- Review conversation logs to fill gaps and update the KB regularly.',
      '',
      'Pro tip: Add “Top FAQs” with your most common questions for quick wins.'
    ].join('\n');
    upsert('kb-best-practices', 'KB Best Practices', 'How to write concise, high-signal KB articles.', bp);

    // Booking setup
    const bk = [
      '# Enable Bookings & Reminders with WhatsApp',
      '',
      'Let customers book appointments via WhatsApp:',
      '',
      '1) In Settings, check “Enable bookings via WhatsApp & dashboard”.',
      '2) Add a Staff member and optional connected calendar.',
      '3) Customize reminder windows (2h, 4h, 1d).',
      '4) Try “test reminder” in WhatsApp to preview the flow.',
      '',
      'Customers can say “book” to get available dates and times.'
    ].join('\n');
    upsert('bookings-and-reminders', 'Bookings & Reminders', 'Turn on scheduling and automated reminders.', bk);
  } catch {}
}

ensureGuides();
seedGuides();
