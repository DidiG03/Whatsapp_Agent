import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { CLERK_ENABLED } from "../config.mjs";
import { getOnboarding } from "../services/onboarding.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { renderSidebar } from "../utils.mjs";
import { getSignedInEmail } from "../middleware/auth.mjs";
import { db } from "../db.mjs";

export default function registerSettingsRoutes(app) {
  app.get("/settings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const s = getSettingsForUser(userId);
    const ob = getOnboarding(userId);
    const email = await getSignedInEmail(req);
    const calendars = db.prepare(`SELECT id, display_name, account_email, calendar_id FROM calendars WHERE user_id = ? ORDER BY id`).all(userId);
    const staff = db.prepare(`SELECT id, name, timezone, slot_minutes, calendar_id FROM staff WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(userId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <script>
          window.CLERK_ENABLED = ${CLERK_ENABLED ? 'true' : 'false'};
          async function checkAuthThenSubmit(form){
            if (!window.CLERK_ENABLED) return true;
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
          function toggleReveal(id){
            const el=document.getElementById(id);
            if(!el) return; el.type = el.type === 'password' ? 'text' : 'password';
          }
          async function copyValue(id){
            const el=document.getElementById(id); if(!el) return;
            try{ await navigator.clipboard.writeText(el.value||''); }catch(e){}
          }
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / Settings</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('settings')}
            <main class="main">
              <div class="card chat-box-settings">
                ${(!ob || ob.step < 3) ? '<p><a href="/onboarding">Finish onboarding questions</a></p>' : ''}
                <form method="post" action="/settings" onsubmit="return checkAuthThenSubmit(this)">
                  <div class="section">
                    <h3>WhatsApp Setup</h3>
                    <div class="grid-2">
                      <label>Phone Number ID
                        <input placeholder="8***************" class="settings-field" name="phone_number_id" value="${s.phone_number_id || ''}"/>
                      </label>
                      <label>Business Phone (digits)
                        <input placeholder="1***************" class="settings-field" name="business_phone" value="${s.business_phone || ''}"/>
                      </label>
                    </div>
                    <div class="grid-2">
                      <label>WhatsApp Token
                        <div class="input-row">
                          <input id="wa_token" type="password" placeholder="E***************" class="settings-field" name="whatsapp_token" value="${s.whatsapp_token || ''}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('wa_token')">Reveal</button>
                          <button type="button" class="btn-ghost" onclick="copyValue('wa_token')">Copy</button>
                        </div>
                      </label>
                      <label>App Secret
                        <div class="input-row">
                          <input id="app_secret" type="password" placeholder="c***************" class="settings-field" name="app_secret" value="${s.app_secret || ''}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('app_secret')">Reveal</button>
                          <button type="button" class="btn-ghost" onclick="copyValue('app_secret')">Copy</button>
                        </div>
                      </label>
                    </div>
                    <label>Verify Token
                      <input placeholder="***************" class="settings-field" name="verify_token" value="${s.verify_token || ''}"/>
                    </label>
                  </div>

                  <div class="section">
                    <h3>Website</h3>
                    <label>Website URL
                      <input placeholder="https://www.example.com" class="settings-field" name="website_url" value="${s.website_url || ''}"/>
                    </label>
                  </div>

                  <div class="section">
                    <h3>AI Preferences</h3>
                    <div class="grid-2">
                      <label>AI Tone
                        <input placeholder="friendly, professional, playful" class="settings-field" name="ai_tone" value="${s.ai_tone || ''}"/>
                      </label>
                      <label>AI Blocked Topics
                        <input placeholder="refunds, medical" class="settings-field" name="ai_blocked_topics" value="${s.ai_blocked_topics || ''}"/>
                      </label>
                    </div>
                    <label>AI Style Notes
                      <input placeholder="use emojis, keep answers under 2 lines" class="settings-field" name="ai_style" value="${s.ai_style || ''}"/>
                    </label>
                  </div>
                  <div class="section">
                    <h3>Greeting</h3>
                    <label>Entry Greeting
                      <input placeholder="Hello! How can I help you today?" class="settings-field" name="entry_greeting" value="${s.entry_greeting || 'Hello! How can I help you today?'}"/>
                    </label>
                  </div>
                  <div class="section">
                    <h3>Bookings</h3>
                    <label>
                      <input type="hidden" name="bookings_enabled" value="0"/>
                      <input type="checkbox" name="bookings_enabled" value="1" ${s.bookings_enabled ? 'checked' : ''}/> Enable bookings via WhatsApp & dashboard
                    </label>
                    <div class="grid-2" style="margin-top:8px;">
                      <label>Reschedule min lead (minutes)
                        <input class="settings-field" type="number" min="0" step="5" name="reschedule_min_lead_minutes" value="${Number(s.reschedule_min_lead_minutes||60)}"/>
                      </label>
                      <label>Cancel min lead (minutes)
                        <input class="settings-field" type="number" min="0" step="5" name="cancel_min_lead_minutes" value="${Number(s.cancel_min_lead_minutes||60)}"/>
                      </label>
                    </div>
                    <div class="section" style="margin-top:8px;">
                      <h4 style="margin:0 0 6px 0;">Reminders</h4>
                      <label>
                        <input type="hidden" name="reminders_enabled" value="0"/>
                        <input type="checkbox" name="reminders_enabled" value="1" ${s.reminders_enabled && s.bookings_enabled ? 'checked' : ''} ${!s.bookings_enabled ? 'disabled' : ''}/> Enable reminders (requires bookings)
                      </label>
                      <div class="small">Choose one or more windows. If booking is the same day and window is 1D, no reminder is sent.</div>
                      <div style="display:flex; gap:12px; margin-top:6px;">
                        ${['2h','4h','1d'].map(w => {
                          const current = (() => { try { return JSON.parse(s.reminder_windows||'[]'); } catch { return []; } })();
                          const on = current.includes(w);
                          return `<label><input type="checkbox" name="reminder_windows" value="${w}" ${on ? 'checked' : ''} ${!s.bookings_enabled ? 'disabled' : ''}/> ${w.toUpperCase()}</label>`;
                        }).join('')}
                      </div>
                    </div>
                  </div>
                  <div style="display: flex; gap: 10px; align-items: center; margin-top: 16px;">
                    <button type="submit">Save</button>
                  </div>
                </form>
                <div class="section" style="display:flex; gap:10px; align-items:center;">
                  <form method="post" action="/kb/clear" style="margin:0;display:inline;">
                    <button type="submit" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca">Clear Knowledge Base</button>
                  </form>
                  <form method="post" action="/danger/wipe" style="margin:0;display:inline;" onsubmit="return confirm('Delete all data for this account? This cannot be undone.');">
                    <button type="submit" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca">Delete my account data</button>
                  </form>
                </div>
                <div class="section">
                  <h3>Staff</h3>
                  <div class="card" style="margin-bottom:12px;">
                    <form method="post" action="/settings/staff" onsubmit="return checkAuthThenSubmit(this)" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
                      <label>Name
                        <input class="settings-field" name="name" placeholder="Dr. Jane Doe" required />
                      </label>
                      <label>Timezone
                        <input class="settings-field" name="timezone" placeholder="America/New_York" value="${s.timezone || ''}" />
                      </label>
                      <label>Slot Minutes
                        <input class="settings-field" type="number" min="5" max="240" step="5" name="slot_minutes" value="30" />
                      </label>
                      <label>Calendar
                        <select class="settings-field" name="calendar_id">
                          <option value="">— None (local only) —</option>
                          ${(calendars||[]).map(c => `<option value="${c.id}">${(c.display_name||c.account_email||c.calendar_id||('Calendar #'+c.id))}</option>`).join('')}
                        </select>
                      </label>
                      <label style="grid-column: 1 / -1;">Working Hours JSON
                        <textarea class="settings-field" name="working_hours_json" rows="3" placeholder='{"mon":["09:00-17:00"],"tue":["09:00-17:00"],"wed":["09:00-17:00"],"thu":["09:00-17:00"],"fri":["09:00-17:00"]}'></textarea>
                      </label>
                      <div style="grid-column: 1 / -1; display:flex; gap:8px;">
                        <button type="submit">Add Staff</button>
                      </div>
                    </form>
                  </div>
                  <div class="card">
                    <div class="small" style="margin-bottom:8px;">Existing staff</div>
                    ${staff.length ? `<ul class="list">${staff.map(r => `
                      <li class="inbox-item">
                        <div class="wa-row">
                          <div class="wa-col">
                            <div class="wa-top"><div class="wa-name">${r.name}</div></div>
                            <div class="item-preview small">${r.timezone || 'UTC'} · ${r.slot_minutes||30}m ${r.calendar_id ? '(Calendar linked)' : ''}</div>
                          </div>
                          <form method="post" action="/settings/staff/${r.id}/delete" onsubmit="return checkAuthThenSubmit(this)" style="margin-left:auto;">
                            <button type="submit" class="btn-ghost" style="color:#991b1b;">Delete</button>
                          </form>
                        </div>
                      </li>
                    `).join('')}</ul>` : '<div class="small">No staff yet</div>'}
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.post("/kb/clear", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      console.log("[KB][CLEAR] requested by", { userId });
      // Preflight FTS integrity; rebuild if necessary BEFORE delete to avoid error noise
      try {
        db.prepare("INSERT INTO kb_items_fts(kb_items_fts) VALUES ('integrity-check')").run();
      } catch {
        console.warn('[KB][CLEAR] FTS integrity-check failed; rebuilding');
        try { db.prepare("INSERT INTO kb_items_fts(kb_items_fts) VALUES ('rebuild')").run(); } catch {}
        try {
          db.exec(`DROP TABLE IF EXISTS kb_items_fts;`);
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_items_fts USING fts5(
            title,
            content,
            content='kb_items',
            content_rowid='id'
          );`);
          db.exec(`INSERT INTO kb_items_fts(rowid, title, content) SELECT id, title, content FROM kb_items;`);
        } catch {}
      }

      // Now perform the delete
      const del = db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(userId);
      console.log("[KB][CLEAR] deleted rows", { changes: del?.changes || 0 });
      const remaining = db.prepare(`SELECT COUNT(1) AS c FROM kb_items WHERE user_id = ?`).get(userId)?.c || 0;
      console.log("[KB][CLEAR] remaining rows", { remaining });
    } catch (e) {
      console.error("[KB][CLEAR] final error", e?.message || e);
    }
    return res.redirect('/settings');
  });

  app.post("/danger/wipe", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const ids = db.prepare(`SELECT id FROM messages WHERE user_id = ?`).all(userId).map(r => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM message_statuses WHERE message_id IN (${ph})`).run(...ids);
      }
      db.prepare(`DELETE FROM messages WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM handoff WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM onboarding_state WHERE user_id = ?`).run(userId);
      db.prepare(`DELETE FROM settings_multi WHERE user_id = ?`).run(userId);
    } catch (e) {
      console.error('Wipe error:', e?.message || e);
    }
    return res.redirect('/logout');
  });

  app.post("/settings", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const values = {
      phone_number_id: req.body?.phone_number_id || null,
      whatsapp_token: req.body?.whatsapp_token || null,
      verify_token: req.body?.verify_token || null,
      app_secret: req.body?.app_secret || null,
      business_phone: req.body?.business_phone || null,
      website_url: req.body?.website_url || null,
      ai_tone: req.body?.ai_tone || null,
      ai_blocked_topics: req.body?.ai_blocked_topics || null,
      ai_style: req.body?.ai_style || null,
      entry_greeting: req.body?.entry_greeting || null,
      bookings_enabled: req.body?.bookings_enabled ? 1 : 0,
      reschedule_min_lead_minutes: req.body?.reschedule_min_lead_minutes ? Number(req.body.reschedule_min_lead_minutes) : null,
      cancel_min_lead_minutes: req.body?.cancel_min_lead_minutes ? Number(req.body.cancel_min_lead_minutes) : null,
      reminders_enabled: (req.body?.reminders_enabled && req.body?.bookings_enabled) ? 1 : 0,
      reminder_windows: (() => {
        const v = req.body?.reminder_windows;
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        const clean = arr.map(x => String(x||'').toLowerCase()).filter(x => ['2h','4h','1d'].includes(x));
        return clean.length ? JSON.stringify(clean) : null;
      })(),
    };
    upsertSettingsForUser(userId, values);
    res.redirect("/settings");
  });

  // Create staff
  app.post("/settings/staff", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.redirect('/settings');
    const timezone = (req.body?.timezone || '').toString().trim() || null;
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    const workingJson = (req.body?.working_hours_json || '').toString().trim() || null;
    const calIdRaw = (req.body?.calendar_id || '').toString().trim();
    const calendarId = calIdRaw ? Number(calIdRaw) : null;
    try {
      db.prepare(`INSERT INTO staff (user_id, name, calendar_id, timezone, slot_minutes, working_hours_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(userId, name, calendarId, timezone, slotMinutes, workingJson);
    } catch {}
    return res.redirect('/settings');
  });

  // Delete staff
  app.post("/settings/staff/:id/delete", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const id = Number(req.params.id || 0);
    if (!id) return res.redirect('/settings');
    try { db.prepare(`DELETE FROM staff WHERE id = ? AND user_id = ?`).run(id, userId); } catch {}
    return res.redirect('/settings');
  });
}
