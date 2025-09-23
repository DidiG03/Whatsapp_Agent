import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread } from "../services/conversations.mjs";
import { db } from "../db.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText } from "../services/whatsapp.mjs";

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const contacts = listContactsForUser(userId).filter(c => !q || String(c.contact).includes(q));
    const email = await getSignedInEmail(req);
    const list = contacts.map(c => {
      const ts = new Date((c.last_ts||0)*1000).toLocaleString();
      const preview = (c.last_text || "").slice(0, 60).replace(/</g,'&lt;');
      const initials = String(c.contact||'').slice(-2);
      const display = c.contact ? `+${String(c.contact).replace(/^\+/, '')}` : '';
      return `<li class="inbox-item"><a href="/inbox/${c.contact}"><div class="wa-row"><div class="wa-avatar">${initials}</div><div class="wa-col"><div class="wa-top"><div class="wa-name">${display}</div><div class="item-ts small">${ts}</div></div><div class="item-preview small">${preview}</div></div></div></a></li>`;
    }).join("");
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
              <div class="card" style="margin-bottom:12px;">
                <form method="get" action="/inbox" style="display:flex; gap:8px; align-items:center;">
                  <input class="settings-field" type="text" name="q" placeholder="Search by phone digits" value="${q}"/>
                  <button type="submit" class="btn-ghost">Search</button>
                </form>
              </div>
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
    const items = msgs.map(m => {
      const cls = m.direction === 'inbound' ? 'msg msg-in' : 'msg msg-out';
      const text = escapeHtml(m.text_body || '').replace(/\n/g, '<br/>');
      const ts = new Date((m.ts||0)*1000).toLocaleString();
      return `<div class="${cls}"><div class="bubble">${text}<div class="meta">${ts}</div></div></div>`;
    }).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>Chat +${String(phone).replace(/^\+/, '')}</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script>
          async function checkAuthThenSubmit(form){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
          function setupComposer(){
            const ta=document.querySelector('.wa-composer textarea');
            if(!ta) return; ta.addEventListener('keydown', function(e){
              if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.form.submit(); }
            });
          }
          window.addEventListener('DOMContentLoaded', setupComposer);
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / +${String(phone).replace(/^\+/, '')}</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div class="card section wa-chat-header">
                <div class="wa-avatar">${String(phone).slice(-2)}</div>
                <div style="flex:1;">
                  <div class="wa-name">+${String(phone).replace(/^\+/, '')}</div>
                  <div class="small">Chat</div>
                </div>
                <form method="post" action="/handoff/${phone}" onsubmit="return checkAuthThenSubmit(this)">
                  <label><input type="checkbox" name="is_human" value="1" ${isHuman ? 'checked' : ''}/> Hand off to human</label>
                  <button type="submit" class="btn-ghost">Save</button>
                </form>
              </div>
              <div class="card section">
                <div class="chat-thread">
                  ${items || '<div class="small" style="text-align:center;padding:16px;">No messages</div>'}
                </div>
              </div>
              <div class="card section composer wa-composer">
                <form method="post" action="/send/${phone}" onsubmit="return checkAuthThenSubmit(this)" style="display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center;">
                  <textarea rows="1" name="text" placeholder="Type a message"></textarea>
                  <button type="submit" class="send">Send</button>
                </form>
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

