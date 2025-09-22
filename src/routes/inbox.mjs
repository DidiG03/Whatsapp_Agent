import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread } from "../services/conversations.mjs";
import { db } from "../db.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText } from "../services/whatsapp.mjs";

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contacts = listContactsForUser(userId);
    const email = await getSignedInEmail(req);
    const list = contacts.map(c => `<li><a href="/inbox/${c.contact}">${c.contact}</a> <small>${new Date((c.last_ts||0)*1000).toLocaleString()}</small></li>`).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>Inbox</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / Inbox</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <ul class="list card">${list || '<div class="small" style="margin-top:16px;">No conversations yet</div>'}</ul>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.get("/inbox/:phone", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const phoneDigits = normalizePhone(phone);
    const msgs = listMessagesForThread(userId, phoneDigits);
    const status = db.prepare(`SELECT is_human FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId);
    const isHuman = !!status?.is_human;
    const email = await getSignedInEmail(req);
    const items = msgs.map(m => `<div class="chat-msg"><b>${m.direction}:</b> ${m.text_body || ''} <span class="small">${new Date((m.ts||0)*1000).toLocaleString()}</span></div>`).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>Chat ${phone}</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script>
          async function checkAuthThenSubmit(form){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / ${phone}</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div class="card section">
                <form method="post" action="/handoff/${phone}" onsubmit="return checkAuthThenSubmit(this)">
                  <label><input type="checkbox" name="is_human" value="1" ${isHuman ? 'checked' : ''}/> Hand off to human</label>
                  <button type="submit">Save</button>
                </form>
              </div>
              <div class="card section">
                <form method="post" action="/send/${phone}" onsubmit="return checkAuthThenSubmit(this)">
                  <input type="text" name="text" placeholder="Type a message"/>
                  <button type="submit" class="send">Send</button>
                </form>
              </div>
              <div class="card section">
                ${items || '<p>No messages</p>'}
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

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
          INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, strftime('%s','now'), ?)
        `);
        try { stmt.run(outboundId, userId, fromBiz, to, normalizePhone(fromBiz), normalizePhone(to), text, JSON.stringify({ to, text })); } catch {}
      }
    } catch (e) {
      console.error("Manual send error:", e);
    }
    res.redirect(`/inbox/${to}`);
  });
}

