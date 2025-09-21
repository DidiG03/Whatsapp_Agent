import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { clerkMiddleware, requireAuth, getAuth, clerkClient } from "@clerk/express";
import pino from "pino";
import pinoHttp from "pino-http";
dotenv.config();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
}));
// Capture rawBody for signature verification while still parsing JSON
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.urlencoded({ extended: true }));
// Clerk setup (optional if keys are missing)
const CLERK_PUBLISHABLE = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE && CLERK_SECRET);
if (CLERK_ENABLED) {
  // Ensure Clerk sees keys even if only NEXT_PUBLIC_* is set
  process.env.CLERK_PUBLISHABLE_KEY = CLERK_PUBLISHABLE;
  process.env.CLERK_SECRET_KEY = CLERK_SECRET;
  app.use(
    clerkMiddleware({
      publishableKey: CLERK_PUBLISHABLE,
      secretKey: CLERK_SECRET,
      signInUrl: process.env.CLERK_SIGN_IN_URL,
      signUpUrl: process.env.CLERK_SIGN_UP_URL,
      enableHandshake: true,
    })
  );
} else {
  console.warn("[Clerk] Disabled: missing CLERK_PUBLISHABLE_KEY or CLERK_SECRET_KEY");
}
function ensureAuthed(req, res, next) {
  if (!CLERK_ENABLED) return next();
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.redirect(process.env.CLERK_SIGN_IN_URL || "/auth");
    return next();
  } catch {
    return res.redirect(process.env.CLERK_SIGN_IN_URL || "/auth");
  }
}
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Per-route protection handled below (GET vs POST handshake)

// Simple SQLite DB init
const db = new Database("./data.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,            -- inbound | outbound
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
    status TEXT NOT NULL,               -- sent | delivered | read | failed
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
    contact_id TEXT UNIQUE, -- contact phone number
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
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Ensure multi-tenant columns exist
function ensureUserScopedColumns() {
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
    `);
  } catch {}
}
ensureUserScopedColumns();

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Settings helpers (multi-tenant)
function getCurrentUserId(req) {
  if (!CLERK_ENABLED) return null;
  try { return getAuth(req)?.userId || null; } catch { return null; }
}
function getSettingsForUser(userId) {
  if (!userId) return {};
  const row = db.prepare(`SELECT * FROM settings_multi WHERE user_id = ?`).get(userId);
  return row || {};
}
function upsertSettingsForUser(userId, values) {
  if (!userId) return {};
  const current = getSettingsForUser(userId);
  const merged = {
    user_id: userId,
    phone_number_id: values.phone_number_id ?? current.phone_number_id ?? null,
    whatsapp_token: values.whatsapp_token ?? current.whatsapp_token ?? null,
    verify_token: values.verify_token ?? current.verify_token ?? null,
    app_secret: values.app_secret ?? current.app_secret ?? null,
    business_phone: values.business_phone ?? current.business_phone ?? null,
  };
  db.prepare(`
    INSERT INTO settings_multi (user_id, phone_number_id, whatsapp_token, verify_token, app_secret, business_phone, updated_at)
    VALUES (@user_id, @phone_number_id, @whatsapp_token, @verify_token, @app_secret, @business_phone, strftime('%s','now'))
    ON CONFLICT(user_id) DO UPDATE SET
      phone_number_id = excluded.phone_number_id,
      whatsapp_token = excluded.whatsapp_token,
      verify_token = excluded.verify_token,
      app_secret = excluded.app_secret,
      business_phone = excluded.business_phone,
      updated_at = excluded.updated_at
  `).run(merged);
  return merged;
}
function findSettingsByVerifyToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE verify_token = ?`).get(token) || null;
}
function findSettingsByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE phone_number_id = ?`).get(phoneNumberId) || null;
}
function findSettingsByBusinessPhone(digits) {
  if (!digits) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE REPLACE(business_phone, '+', '') = ? OR business_phone = ?`).get(digits, digits) || null;
}

// Resilient WhatsApp client
async function sendWhatsAppText(to, body, cfg) {
  if (!cfg.phone_number_id || !cfg.whatsapp_token) throw new Error("WhatsApp is not configured");
  const url = `https://graph.facebook.com/v20.0/${cfg.phone_number_id}/messages`;
  const payload = { messaging_product: "whatsapp", to, text: { body } };
  const headers = {
    "Authorization": `Bearer ${cfg.whatsapp_token}`,
    "Content-Type": "application/json"
  };
  const maxRetries = 3;
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (resp.status >= 500) throw new Error(`WhatsApp 5xx ${resp.status}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`WhatsApp error ${resp.status}: ${text}`);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// Simple retrieval from KB: top N by naive keyword overlap
function retrieveKbMatches(query, limit = 3) {
  const all = db.prepare(`SELECT id, title, content FROM kb_items ORDER BY id DESC`).all();
  const q = (query || "").toLowerCase();
  const terms = q.split(/[^a-z0-9]+/).filter(Boolean);
  const scored = all.map((row) => {
    const text = `${row.title || ""} ${row.content}`.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
    return { ...row, score };
  });
  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function generateAiReply(userMessage, contextSnippets) {
  const context = contextSnippets.map((s, i) => `# Doc ${i+1}: ${s.title || "Untitled"}\n${s.content}`).join("\n\n");
  const prompt = `You are a helpful business assistant on WhatsApp. Answer using the provided docs. If unsure, say you will hand off to a human.
\nDocs:\n${context}\n\nUser: ${userMessage}\nAssistant:`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You answer briefly, clearly, and politely." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 200
    });
    return resp.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    console.error("OpenAI error:", e?.message || e);
    return null;
  }
}

// Helper: get signed-in user's email (Clerk)
async function getSignedInEmail(req) {
  if (!CLERK_ENABLED) return null;
  try {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary = user.emailAddresses?.find(e => e.id === primaryId)?.emailAddress;
    return primary || user.emailAddresses?.[0]?.emailAddress || null;
  } catch {
    return null;
  }
}

// KB endpoints
app.post("/kb", (req, res) => {
  const { title, content } = req.body || {};
  if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });
  const stmt = db.prepare(`INSERT INTO kb_items (title, content) VALUES (?, ?)`);
  const info = stmt.run(title || null, content);
  return res.json({ id: info.lastInsertRowid, title, content });
});

app.get("/kb", (_req, res) => {
  const rows = db.prepare(`SELECT id, title, content, created_at FROM kb_items ORDER BY id DESC LIMIT 100`).all();
  return res.json(rows);
});

// Inbox views
app.get("/inbox", ensureAuthed, async (req, res) => {
  const userId = getCurrentUserId(req);
  const contacts = db.prepare(`
    SELECT from_id AS contact, MAX(timestamp) AS last_ts
    FROM messages
    WHERE direction = 'inbound' AND from_id IS NOT NULL AND user_id = ?
    GROUP BY from_id
    ORDER BY last_ts DESC
    LIMIT 100
  `).all(userId);
  const email = await getSignedInEmail(req);
  const list = contacts.map(c => `<li><a href="/inbox/${c.contact}">${c.contact}</a> <small>${new Date((c.last_ts||0)*1000).toLocaleString()}</small></li>`).join("");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html><head><title>Inbox</title></head>
    <body>
      <h1>Inbox ${email ? `<small style="font-weight:normal; font-size:14px">— signed in as ${email}</small>` : ''} ${CLERK_ENABLED ? `<a href="/logout" style="margin-left:12px; font-size:14px;">Sign out</a>` : ''}</h1>
      <ul>${list || '<li>No conversations yet</li>'}</ul>
    </body></html>
  `);
});

app.get("/inbox/:phone", ensureAuthed, async (req, res) => {
  const phone = req.params.phone;
  const userId = getCurrentUserId(req);
  const msgs = db.prepare(`
    SELECT direction, text_body, timestamp FROM messages
    WHERE user_id = ? AND ((from_id = ? AND direction='inbound') OR (to_id = ? AND direction='outbound'))
    ORDER BY timestamp ASC
  `).all(userId, phone, phone);
  const status = db.prepare(`SELECT is_human FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId);
  const isHuman = !!status?.is_human;
  const email = await getSignedInEmail(req);
  const items = msgs.map(m => `<div><b>${m.direction}:</b> ${m.text_body || ''} <small>${new Date((m.timestamp||0)*1000).toLocaleString()}</small></div>`).join("");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html><head><title>Chat ${phone}</title></head>
    <body>
      <a href="/inbox">⬅ Back</a> ${email ? `<small style="margin-left:8px; color:#444">${email}</small>` : ''} ${CLERK_ENABLED ? `<a href="/logout" style="margin-left:12px; font-size:12px;">Sign out</a>` : ''}
      <h2>Chat with ${phone}</h2>
      <form method="post" action="/handoff/${phone}">
        <label><input type="checkbox" name="is_human" value="1" ${isHuman ? 'checked' : ''}/> Hand off to human</label>
        <button type="submit">Save</button>
      </form>
      <form method="post" action="/send/${phone}" style="margin-top:10px;">
        <input type="text" name="text" placeholder="Type a message" style="width:300px"/>
        <button type="submit">Send</button>
      </form>
      <hr/>
      ${items || '<p>No messages</p>'}
    </body></html>
  `);
});

// Toggle handoff
app.post("/handoff/:phone", ensureAuthed, (req, res) => {
  const phone = req.params.phone;
  const userId = getCurrentUserId(req);
  const isHuman = req.body?.is_human ? 1 : 0;
  const upsert = db.prepare(`
    INSERT INTO handoff (contact_id, user_id, is_human, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(contact_id, user_id) DO UPDATE SET is_human = excluded.is_human, updated_at = excluded.updated_at
  `);
  try { upsert.run(phone, userId, isHuman); } catch {}
  res.redirect(`/inbox/${phone}`);
});

// Send message to a contact (manual reply)
app.post("/send/:phone", ensureAuthed, async (req, res) => {
  const to = req.params.phone;
  const userId = getCurrentUserId(req);
  const cfg = getSettingsForUser(userId);
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.redirect(`/inbox/${to}`);
  try {
    const data = await sendWhatsAppText(to, text, cfg);
    const outboundId = data?.messages?.[0]?.id;
    const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
    if (outboundId) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, type, text_body, timestamp, raw)
        VALUES (?, ?, 'outbound', ?, ?, 'text', ?, strftime('%s','now'), ?)
      `);
      try { stmt.run(outboundId, userId, fromBiz, to, text, JSON.stringify({ to, text })); } catch {}
    }
  } catch (e) {
    console.error("Manual send error:", e);
  }
  res.redirect(`/inbox/${to}`);
});

// Webhook verification (Meta calls this once when you set it up)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Find tenant by verify_token
  const s = findSettingsByVerifyToken(token);
  if (mode === "subscribe" && s) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Simple home page
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html><body>
      <h1>WhatsApp Agent</h1>
      <ul>
        <li><a href="/auth">Sign in / Sign up</a></li>
        <li><a href="/inbox">Inbox (requires sign in)</a></li>
        <li><a href="/kb">KB (JSON)</a></li>
        <li><a href="/settings">Settings</a></li>
        ${CLERK_ENABLED ? '<li><a href="/logout">Sign out</a></li>' : ''}
      </ul>
    </body></html>
  `);
});
console.log(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
// Auth links (hosted by Clerk)
app.get("/auth", (_req, res) => {
  const pub = (process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ? "configured" : "missing publishable key";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html><body>
      <h2>Auth</h2>
      <p>Clerk status: ${pub}</p>
      <ul>
        <li><a href="${process.env.CLERK_SIGN_IN_URL || 'https://accounts.clerk.com/sign-in'}">Sign In</a></li>
        <li><a href="${process.env.CLERK_SIGN_UP_URL || 'https://accounts.clerk.com/sign-up'}">Sign Up</a></li>
        ${CLERK_ENABLED ? '<li><a href="/logout">Sign out</a></li>' : ''}
      </ul>
    </body></html>
  `);
});

// Silence Chrome DevTools probe noise
app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.sendStatus(204));

// Settings UI
app.get("/settings", ensureAuthed, (req, res) => {
  const userId = getCurrentUserId(req);
  const s = getSettingsForUser(userId);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html><body>
      <h2>Settings</h2>
      <form method="post" action="/settings">
        <div><label>Phone Number ID <input name="phone_number_id" value="${s.phone_number_id || ''}"/></label></div>
        <div><label>WhatsApp Token <input name="whatsapp_token" value="${s.whatsapp_token || ''}"/></label></div>
        <div><label>Verify Token <input name="verify_token" value="${s.verify_token || ''}"/></label></div>
        <div><label>App Secret <input name="app_secret" value="${s.app_secret || ''}"/></label></div>
        <div><label>Business Phone (digits) <input name="business_phone" value="${s.business_phone || ''}"/></label></div>
        <button type="submit">Save</button>
      </form>
    </body></html>
  `);
});

app.post("/settings", ensureAuthed, (req, res) => {
  const userId = getCurrentUserId(req);
  const values = {
    phone_number_id: req.body?.phone_number_id || null,
    whatsapp_token: req.body?.whatsapp_token || null,
    verify_token: req.body?.verify_token || null,
    app_secret: req.body?.app_secret || null,
    business_phone: req.body?.business_phone || null,
  };
  upsertSettingsForUser(userId, values);
  res.redirect("/settings");
});

// Logout current session (Clerk)
app.get("/logout", async (req, res) => {
  if (!CLERK_ENABLED) return res.redirect("/");
  try {
    const { sessionId } = getAuth(req);
    if (sessionId) {
      await clerkClient.sessions.revokeSession(sessionId);
    }
  } catch (e) {
    console.error("Logout error:", e?.message || e);
  }
  return res.redirect(process.env.CLERK_SIGN_IN_URL || "/");
});

// Receive messages
app.post("/webhook", async (req, res) => {
  try {
    // Verify X-Hub-Signature-256 if provided
    const sig = req.header("X-Hub-Signature-256") || req.header("x-hub-signature-256");
    // Identify tenant for signature check by phone_number_id in payload metadata
    const prospective = (() => {
      try {
        const temp = JSON.parse((req.rawBody || Buffer.from("{}"))?.toString("utf8"));
        const pnid = temp?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
        return findSettingsByPhoneNumberId(pnid);
      } catch { return null; }
    })();
    const s = prospective || {};
    if (s.app_secret && sig) {
      const [algo, their] = sig.split("=");
      if (algo !== "sha256") return res.sendStatus(403);
      const crypto = await import("node:crypto");
      const hmac = crypto.createHmac("sha256", s.app_secret);
      // rawBody set by bodyParser verify above
      const raw = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
      hmac.update(raw);
      const ours = hmac.digest("hex");
      if (ours !== their) {
        req.log?.warn({ theirs, ours }, "Invalid webhook signature");
        return res.sendStatus(403);
      }
    }

    const payload = req.body;
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    // Handle delivery/read status updates
    const statuses = change?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      statuses.forEach((s) => {
        const status = s.status; // "sent" | "delivered" | "read" | "failed"
        const recipientId = s.recipient_id;
        const messageId = s.id || s.message_id;
        const timestamp = s.timestamp;
        const error = Array.isArray(s.errors) ? s.errors[0] : undefined;

        if (status === "failed") {
          console.log("Status failed:", {
            recipientId,
            messageId,
            timestamp,
            errorCode: error?.code,
            errorTitle: error?.title,
            errorMessage: error?.message,
          });
        } else {
          console.log("Status:", status, { recipientId, messageId, timestamp });
        }

        // Persist status
        const insertStatus = db.prepare(
          `INSERT INTO message_statuses (message_id, status, recipient_id, timestamp, error_code, error_title, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        try {
          insertStatus.run(
            messageId || null,
            status || null,
            recipientId || null,
            timestamp ? Number(timestamp) : null,
            error?.code ?? null,
            error?.title ?? null,
            error?.message ?? null
          );
        } catch (e) {
          // ignore duplicates or minor DB errors to avoid breaking webhook
        }
      });
    }

    const message = change?.messages?.[0];
    if (!message) return res.sendStatus(200); // not a message event

    // Guard: avoid replying to our own messages and non-text events
    const metadata = change?.metadata;
    // Attach resolved tenant user_id on all DB writes
    const tenant = findSettingsByPhoneNumberId(metadata?.phone_number_id) || findSettingsByBusinessPhone(metadata?.display_phone_number?.replace(/\D/g, ""));
    const tenantUserId = tenant?.user_id || null;
    const businessNumber = metadata?.display_phone_number?.replace(/\D/g, "");
    if (businessNumber && message.from === businessNumber) {
      console.log("Skip self/echo message from:", message.from);
      return res.sendStatus(200);
    }
    const messageType = message.type;
    if (messageType !== "text") {
      console.log("Skip non-text inbound:", messageType);
      return res.sendStatus(200);
    }

    const from = message.from;                 // user phone number (string)
    const text = message.text?.body || "";     // message text if text type
    console.log("Inbound:", from, text);

    // Persist inbound (idempotent)
    const inboundId = message.id;
    if (inboundId) {
      const insertInbound = db.prepare(
        `INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, type, text_body, timestamp, raw)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?)`
      );
      try {
        insertInbound.run(
          inboundId,
          tenantUserId,
          from || null,
          metadata?.display_phone_number?.replace(/\D/g, "") || null,
          message.type || null,
          text || null,
          message.timestamp ? Number(message.timestamp) : null,
          JSON.stringify(message)
        );
      } catch {}
    }

    // Respect handoff to human: if active, do not auto-reply
    const handoffState = db.prepare(`SELECT is_human FROM handoff WHERE contact_id = ?`).get(from);
    if (handoffState?.is_human) {
      console.log("Handoff active, skipping auto-reply for", from);
      return res.sendStatus(200);
    }

    // Try AI reply from KB first
    let reply = null;
    const matches = retrieveKbMatches(text, 3);
    if (matches.length > 0) {
      reply = await generateAiReply(text, matches);
    }
    // Fallback simple rules
    if (!reply) {
      reply = "🤖 Thanks for messaging us! We’ll reply shortly.";
    const t = text.trim().toLowerCase();
    if (t.includes("price") || t.includes("pricing")) reply = "Our pricing starts at £19/month. Need full details?";
    else if (t.includes("support") || t.includes("help")) reply = "You can reach support here. What issue are you facing?";
    else if (t.includes("menu")) reply = "Here’s our menu: starters, mains, desserts. Reply 1/2/3 for details.";
    }

    // Send session reply (valid within 24h of user message)
    const cfg = tenant || {};
    const sendRespData = await sendWhatsAppText(from, reply, cfg);
    // Capture outbound message id if available
    try {
      const outboundId = sendRespData?.messages?.[0]?.id;
      if (outboundId) {
        const insertOutbound = db.prepare(
          `INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, type, text_body, timestamp, raw)
           VALUES (?, ?, 'outbound', ?, ?, 'text', ?, strftime('%s','now'), ?)`
        );
        insertOutbound.run(
          outboundId,
          tenantUserId,
          (cfg.business_phone || "").replace(/\D/g, "") || null,
          from || null,
          reply || null,
          JSON.stringify({ to: from, reply })
        );
      }
    } catch {}

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
