import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <script>
          async function checkAuthThenSubmit(form){
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
                  <button type="submit">Save</button>
                </form>

                <div class="section" style="display:flex; flex-direction:row; gap:8px; width:100%;">
                  <form method="post" action="/kb/clear" onsubmit="return checkAuthThenSubmit(this)">
                    <button type="submit" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca">Clear Knowledge Base</button>
                  </form>
                  <form method="post" action="/danger/wipe" onsubmit="if(!confirm('Delete all data for this account? This cannot be undone.')) return false; return checkAuthThenSubmit(this)">
                    <button type="submit" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca">Delete my account data</button>
                  </form>
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
      db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(userId);
    } catch {}
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
    };
    upsertSettingsForUser(userId, values);
    res.redirect("/settings");
  });
}

