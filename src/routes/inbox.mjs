import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml, renderTopbar } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread } from "../services/conversations.mjs";
import { db } from "../db.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText, sendWhatsAppTemplate } from "../services/whatsapp.mjs";

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const contacts = listContactsForUser(userId).filter(c => !q || String(c.contact).includes(q));
    const email = await getSignedInEmail(req);
    const customers = db.prepare(`SELECT contact_id, display_name FROM customers WHERE user_id = ?`).all(userId);
    const customerNameByContact = new Map(customers.map(r => [String(r.contact_id), r.display_name]));
    const lastSeenRows = db.prepare(`SELECT contact_id, COALESCE(last_seen_ts,0) AS seen FROM handoff WHERE user_id = ?`).all(userId);
    const lastSeenByContact = new Map(lastSeenRows.map(r => [String(r.contact_id), Number(r.seen||0)]));
    // Get escalations and check if support has handled them
    const escalationRows = db.prepare(`
      SELECT h.contact_id, h.escalation_reason, h.updated_at as escalation_ts, 
             h.is_human, h.human_expires_ts
      FROM handoff h 
      WHERE h.user_id = ? AND h.escalation_reason IS NOT NULL
    `).all(userId);
    
    const escalationByContact = new Map();
    const now = Math.floor(Date.now()/1000);
    
    escalationRows.forEach(row => {
      const contactId = String(row.contact_id);
      const escalationTs = Number(row.escalation_ts || 0);
      const isHuman = Number(row.is_human || 0);
      const humanExpiresTs = Number(row.human_expires_ts || 0);
      
      // Check if human mode is still active (not expired and not manually turned off)
      const isHumanModeActive = isHuman && humanExpiresTs > now;
      
      // Only show live chip if human mode is still active (escalation not handled yet)
      // If human mode is off or expired, the escalation has been handled
      if (isHumanModeActive) {
        escalationByContact.set(contactId, row.escalation_reason);
      }
    });
    const list = contacts.map(c => {
      const lastTs = Number(c.last_ts||0);
      const ts = new Date(lastTs*1000).toLocaleString();
      const preview = (c.last_text || "").slice(0, 60).replace(/</g,'&lt;');
      const initials = String(c.contact||'').slice(-2);
      const displayDefault = c.contact ? `+${String(c.contact).replace(/^\+/, '')}` : '';
      const displayName = customerNameByContact.get(String(c.contact)) || displayDefault;
      const seenTs = lastSeenByContact.get(String(c.contact)) || 0;
      const hasNew = lastTs > seenTs;
      const hasEscalation = escalationByContact.has(String(c.contact));
      const dropdownId = `menu_${c.contact}`;
      const menu = `
        <div class="dropdown" style="position:relative;">
          <button type="button" class="btn-ghost" style="border:none;" onclick="return toggleMenu('${dropdownId}', event)">
            <img src="/menu-icon.svg" alt="Menu" style="width:20px;height:20px;vertical-align:middle;border:none;"/>
          </button>
          <div id="${dropdownId}" class="dropdown-menu" style="position:absolute; right:0; top:28px; background:#fff; border:1px solid var(--border); border-radius:8px; padding:6px; min-width:140px; display:none; box-shadow:0 6px 20px rgba(0,0,0,0.12); z-index:10;" onclick="event.stopPropagation()">
            <form method="post" action="/inbox/${c.contact}/archive" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;">
                <img src="/archive-icon.svg" alt="Archive"/> Archive
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;">
                <img src="/clear-icon.svg" alt="Clear"/> Clear
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/delete" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; color:#c00; border:none;">
                <img src="/delete-icon.svg" alt="Delete"/> Delete
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/nameCustomer" style="margin:0;">
              <button type="button" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;" onclick="openNameModal('${c.contact}'); return false;">
                <img src="/name-person-icon.svg" alt="Name Person"/> Name Customer
              </button>
            </form>
          </div>
        </div>
      `;
      return `
        <li class="inbox-item">
          <a href="/inbox/${c.contact}">
            <div class="wa-row">
              <div class="wa-avatar">${initials}</div>
              <div class="wa-col">
                <div class="wa-name">${displayName}${hasNew ? '<span class="badge-dot"></span>' : ''}${hasEscalation ? '<span class="live-chip">live</span>' : ''}</div>
                <div class="wa-top">
                  <div class="item-preview small">${preview}</div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="item-ts small">${ts}</div>
                    <div class="dropdown-icon">
                      ${menu}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </a>
        </li>
      `;
    }).join("");
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Inbox</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script src="/notifications.js"></script>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Inbox`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <form method="get" action="/inbox" style="display:flex; gap:8px; align-items:center;">
                <input class="settings-field" type="text" name="q" placeholder='Search...' style="background-image: url('/search-icon-black.svg'); background-repeat: no-repeat; background-position: 8px center; background-size: 16px 16px; padding-left: 36px;" value="${q}"/>
                <button type="submit"><img src="/search-icon.svg" alt="Search" style="width:20px;height:20px;vertical-align:middle;"/></button>
              </form>
              <div id="nameModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:1000; align-items:center; justify-content:center;">
                <div class="card" style="width:420px; max-width:95vw;">
                  <div class="small" style="margin-bottom:8px;">Name Customer</div>
                  <form id="nameForm" method="post" action="" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="display:grid; gap:8px;">
                    <input class="settings-field" type="text" name="display_name" placeholder="Customer name" required />
                    <textarea class="settings-field" name="notes" rows="3" placeholder="Notes (optional)"></textarea>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                      <button type="button" class="btn-ghost" onclick="closeNameModal()">Cancel</button>
                      <button type="submit">Save</button>
                    </div>
                  </form>
                </div>
              </div>
              <script>
                function openNameModal(contactId){
                  var f = document.getElementById('nameForm');
                  if (f) f.action = '/inbox/' + encodeURIComponent(contactId) + '/nameCustomer';
                  var m = document.getElementById('nameModal');
                  if (m){ m.style.display = 'flex'; }
                }
                function closeNameModal(){
                  var m = document.getElementById('nameModal');
                  if (m){ m.style.display = 'none'; }
                }
                document.addEventListener('keydown', function(e){
                  if(e.key==='Escape'){ closeNameModal(); }
                });
              </script>
              <script>
                function toggleMenu(id, evt){
                  if(evt){ try{ evt.preventDefault(); evt.stopPropagation(); }catch(_){} }
                  try{
                    document.querySelectorAll('.dropdown-menu').forEach(el=>{ if(el.id!==id) el.style.display='none'; });
                    const el = document.getElementById(id);
                    if(!el) return false; el.style.display = (el.style.display==='block') ? 'none' : 'block';
                  }catch(_){ }
                  return false;
                }
                document.addEventListener('click', function(){
                  document.querySelectorAll('.dropdown-menu').forEach(el=>{ el.style.display='none'; });
                });
              </script>
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
    // Mark as seen
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, last_seen_ts, updated_at)
        VALUES (?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET last_seen_ts = strftime('%s','now'), updated_at = strftime('%s','now')`).run(phone, userId);
    } catch {}
    const cust = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(userId, phone);
    const headerName = cust?.display_name || ('+' + String(phone).replace(/^\+/, ''));
    // Fetch richer message data so we can render interactive/document messages too
    const msgs = db.prepare(`
      SELECT id, direction, type, text_body, COALESCE(timestamp, 0) AS ts, raw
      FROM messages
      WHERE user_id = ?
        AND (
          ((from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) AND direction = 'inbound') OR
          ((to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?)) AND direction = 'outbound')
        )
      ORDER BY ts ASC
    `).all(userId, phoneDigits, phoneDigits, phoneDigits, phoneDigits);
    const status = db.prepare(`SELECT is_human, COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId);
    const isHuman = !!status?.is_human;
    const expTs = Number(status?.exp || 0);
    const nowSec = Math.floor(Date.now()/1000);
    const remain = expTs > nowSec ? (expTs - nowSec) : 0;
    const email = await getSignedInEmail(req);
    const items = msgs.map(m => {
      const cls = m.direction === 'inbound' ? 'msg msg-in' : 'msg msg-out';
      let display = String(m.text_body || '').trim();
      // For non-text messages, derive a readable label from raw payload
      if (!display) {
        let raw;
        try { raw = JSON.parse(m.raw || '{}'); } catch { raw = {}; }
        if (m.type === 'interactive') {
          const br = raw?.interactive?.button_reply;
          const lr = raw?.interactive?.list_reply;
          const bodyText = raw?.interactive?.body?.text;
          if (br?.title) display = br.title;
          else if (lr?.title) display = lr.title;
          else if (bodyText) display = bodyText;
          else display = '[interactive]';
        } else if (m.type === 'document') {
          const filename = raw?.document?.filename || raw?.document?.link || 'Document';
          display = `[document] ${filename}`;
        } else if (m.type === 'image') {
          display = '[image]';
        } else if (m.type === 'audio') {
          display = '[audio]';
        } else if (m.type === 'video') {
          display = '[video]';
        } else if (m.type) {
          display = `[${m.type}]`;
        }
      }
      const safe = escapeHtml(display).replace(/\n/g, '<br/>');
      const ts = new Date((m.ts||0)*1000).toLocaleString();
      return `<div class="${cls}"><div class="bubble">${safe}<div class="meta">${ts}</div></div></div>`;
    }).join("");
    const toastMsg = (req.query?.toast || '').toString();
    const toastType = (req.query?.type || '').toString();
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Chat +${String(phone).replace(/^\+/, '')}</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
          
          // Check authentication before form submission to prevent redirects
          async function checkAuthThenSubmit(form){
            try {
              const response = await fetch('/auth/status', { credentials: 'include' });
              const authData = await response.json();
              if (!authData.signedIn) {
                alert('Your session has expired. Please sign in again.');
                window.location = '/auth';
                return false;
              }
              return true;
            } catch (error) {
              console.error('Auth check failed:', error);
              alert('Authentication check failed. Please try again.');
              return false;
            }
          }
          function setupComposer(){
            const ta=document.querySelector('.wa-composer textarea');
            if(!ta) return; ta.addEventListener('keydown', function(e){
              if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.form.submit(); }
            });
          }
          window.addEventListener('DOMContentLoaded', setupComposer);
        </script>
        <script>
          (function(){
            try{
              var secs = ${remain};
              if(!secs) return;
              function fmt(s){ var m = Math.floor(s/60), r = s%60; return (''+m)+":"+(''+r).padStart(2,'0'); }
              function tick(){ var el = document.getElementById('exp_remain'); if(el){ el.textContent = fmt(secs); } if(secs>0){ secs--; setTimeout(tick,1000);} }
              tick();
            }catch(_){ }
          })();
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / +${String(phone).replace(/^\+/, '')}`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div style="min-height: calc(100vh - 107px);" class="card">
                ${toastMsg ? `<div class="toast ${toastType || 'info'}">${toastMsg}</div>` : ''}
                <div class="wa-chat-header">
                  <a href="/inbox" style="border:none; margin-right:20px;">
                    <img src="/left-arrow-icon.svg" alt="Back" style="width:20px;height:20px;vertical-align:middle;"/>
                  </a>
                  <div class="wa-avatar">${String(phone).slice(-2)}</div>
                  <div style="flex:1;">
                    <div class="wa-name">${headerName}</div>
                    <div class="small">${isHuman ? ('Human' + (remain ? ' • <span id="exp_remain"></span> left' : '')) : 'AI'}</div>
                  </div>
                  <form method="post" action="/handoff/${phone}" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;">
                    <input type="hidden" name="is_human" value="${isHuman ? '' : '1'}"/>
                    <button type="submit" class="btn-ghost" style="border:none; background:transparent; padding:0; margin:0;">
                      <img 
                        src="${isHuman ? '/raise-hand-icon.svg' : '/bot-icon.svg'}"
                        alt="${isHuman ? 'Human handling' : 'AI handling'}" 
                        style="width:26px;height:26px;vertical-align:middle;margin-right:6px; cursor:pointer;"
                      />
                    </button>
                  </form>
                  ${isHuman ? `<form method="post" action="/inbox/${phone}/renew" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" title="Renew 5 minutes" style="border:none;"><img src="/restart-onboarding.svg" alt="Renew" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>` : ''}
                  <form method="post" action="/inbox/${phone}/archive" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="border:none;"><img src="/archive-icon.svg" alt="Archive" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>
                  <form method="post" action="/inbox/${phone}/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="border:none;"><img src="/clear-icon.svg" alt="Clear" style="width:24px;height:24px;vertical-align:middle;"/></button>
                  </form>
                  <form method="post" action="/inbox/${phone}/delete" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="color:#c00; border:none;"><img src="/delete-icon.svg" alt="Delete" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>
                </div>
                ${(() => {
                  try{
                    const lastInbound = (msgs||[]).filter(x=>x.direction==='inbound').map(x=>Number(x.ts||0)).sort((a,b)=>b-a)[0]||0;
                    const over24 = lastInbound && (Math.floor(Date.now()/1000)-lastInbound) > 24*3600;
                    if (over24) {
                      return `<div class=\"small\" style=\"margin:8px 0; padding:8px; background:#fff8e1; border:1px solid #fde68a; border-radius:8px;\">Session expired (>24h). Send template to reopen window.
                        <form method=\"post\" action=\"/inbox/${phone}/send-template\" onsubmit=\"event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;\" style=\"display:flex; gap:6px; align-items:center; margin-top:6px;\">
                          <input class=\"settings-field\" name=\"var1\" placeholder=\"{{1}} (optional)\" style=\"height:32px;\"/>
                          <input class=\"settings-field\" name=\"var2\" placeholder=\"{{2}} (optional)\" style=\"height:32px;\"/>
                          <button class=\"btn-ghost\" type=\"submit\" style=\"border:none;\">Send Template</button>
                        </form>
                      </div>`;
                    }
                  }catch(_){ }
                  return '';
                })()}
                <div class="chat-thread">
                  ${items || '<div class="small" style="text-align:center;padding:16px;">No messages</div>'}
                </div>
                <div style="margin-top:2vh;" class="composer wa-composer">
                  <form method="post" action="/send/${phone}" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center;">
                    <textarea ${!isHuman ? 'disabled' : ''} rows="1" name="text" placeholder="Type a message"></textarea>
                    <button ${!isHuman ? 'disabled' : ''} style="cursor:${!isHuman ? 'not-allowed' : 'pointer'}; background:#dcf8c6; border-radius:100vh;" type="submit" ><img src="/send-whatsapp-icon.svg" alt="Send" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>
                </div>
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
    const now = Math.floor(Date.now()/1000);
    const exp = isHuman ? (now + 5*60) : 0;
    const upsert = db.prepare(`
      INSERT INTO handoff (contact_id, user_id, is_human, human_expires_ts, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(contact_id, user_id) DO UPDATE SET is_human = excluded.is_human, human_expires_ts = excluded.human_expires_ts, updated_at = excluded.updated_at
    `);
    try { upsert.run(phone, userId, isHuman, exp); } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Renew 5 more minutes of human mode
  app.post("/inbox/:phone/renew", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try {
      const now = Math.floor(Date.now()/1000);
      const row = db.prepare(`SELECT COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId) || { exp: 0 };
      const base = Number(row.exp || 0) > now ? Number(row.exp || 0) : now;
      const next = base + 5*60;
      db.prepare(`INSERT INTO handoff (contact_id, user_id, is_human, human_expires_ts, updated_at)
        VALUES (?, ?, 1, ?, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET is_human = 1, human_expires_ts = ?, updated_at = strftime('%s','now')
      `).run(phone, userId, next, next);
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Archive a conversation (hide from inbox list)
  app.post("/inbox/:phone/archive", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, is_archived, updated_at) VALUES (?, ?, 1, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET is_archived = 1, updated_at = excluded.updated_at`).run(phone, userId);
    } catch {}
    res.redirect(`/inbox`);
  });

  // Clear a conversation (delete messages only for this contact/user)
  app.post("/inbox/:phone/clear", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      db.prepare(`DELETE FROM messages WHERE user_id = ? AND (
        (from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) OR
        (to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?))
      )`).run(userId, digits, digits, digits, digits);
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Delete a conversation (mark deleted and remove messages)
  app.post("/inbox/:phone/delete", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      db.prepare(`DELETE FROM messages WHERE user_id = ? AND (
        (from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) OR
        (to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?))
      )`).run(userId, digits, digits, digits, digits);
    } catch {}
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, deleted_at, updated_at) VALUES (?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET deleted_at = strftime('%s','now'), updated_at = strftime('%s','now')`).run(phone, userId);
    } catch {}
    res.redirect(`/inbox`);
  });

  app.post("/send/:phone", ensureAuthed, async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.redirect(`/inbox/${to}`);
    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          // Optionally queue the freeform reply AFTER user responds to the template
          return res.redirect(`/inbox/${to}?toast=Template sent. Ask the user to reply to reopen the session.&type=success`);
        } catch (e) {
          console.error('Template send failed, falling back to text within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
        }
      }
    } catch {}
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
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
    }
    res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Message sent')}&type=success`);
  });

  app.post("/inbox/:phone/send-template", ensureAuthed, async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
    const tname = cfg.wa_template_name || 'hello_world';
    const tlang = cfg.wa_template_language || 'en_US';
    const components = [];
    const var1 = (req.body?.var1 || '').toString().trim();
    const var2 = (req.body?.var2 || '').toString().trim();
    const bodyParams = [];
    if (var1) bodyParams.push({ type: 'text', text: var1 });
    if (var2) bodyParams.push({ type: 'text', text: var2 });
    if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });
    try { 
      await sendWhatsAppTemplate(to, tname, tlang, components, cfg);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template sent successfully')}&type=success`);
    } catch (e) { 
      console.error('Template send error:', e?.message || e);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
    }
  });

  app.post("/inbox/:phone/nameCustomer", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const name = (req.body?.display_name || "").toString().trim().slice(0, 80);
    const notes = (req.body?.notes || "").toString().trim().slice(0, 400);
    if (!name) return res.redirect(`/inbox`);
  
    try {
      db.prepare(`
        INSERT INTO customers (user_id, contact_id, display_name, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(user_id, contact_id) DO UPDATE
        SET display_name = excluded.display_name, notes = excluded.notes, updated_at = excluded.updated_at
      `).run(userId, phone, name, notes || null);
    } catch {}
    return res.redirect(`/inbox`);
  });
}