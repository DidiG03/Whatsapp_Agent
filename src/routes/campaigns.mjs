import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, renderTopbar, escapeHtml } from "../utils.mjs";
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { getPlanStatus } from "../services/usage.mjs";
import { enqueueOutboundMessage } from "../jobs/outboundQueue.mjs";
import { sendTemplateStatusEmail } from "../services/email.mjs";
import { sendWhatsAppText, sendWhatsAppTemplate } from "../services/whatsapp.mjs";

export default function registerCampaignRoutes(app) {
  // Campaigns landing page
  app.get("/campaigns", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);

    // Fetch recent templates/campaigns for sidebar preview
    const db = getDB();
    const templates = await db.collection('wa_templates').find({ user_id: String(userId) }).sort({ createdAt: -1 }).limit(10).toArray();
    const campaigns = await db.collection('wa_campaigns').find({ user_id: String(userId) }).sort({ createdAt: -1 }).limit(10).toArray();

    const tplRows = (templates || []).map(t => `
      <tr>
        <td>${escapeHtml(t.name || '(unnamed)')}</td>
        <td class="small">${escapeHtml(t.language || 'en_US')}</td>
        <td><span class="badge ${t.status || 'submitted'}">${escapeHtml(t.status || 'submitted')}</span></td>
        <td class="small">${new Date(t.createdAt || Date.now()).toLocaleString()}</td>
      </tr>`).join("");

    const campRows = (campaigns || []).map(c => `
      <tr>
        <td>${escapeHtml(c.name || '(unnamed)')}</td>
        <td class="small">${escapeHtml(c.segment?.type || 'all')}</td>
        <td>${escapeHtml(c.mode || 'send_now')}</td>
        <td class="small">${c.scheduled_at ? new Date(c.scheduled_at * 1000).toLocaleString() : '-'}</td>
        <td><span class="badge ${escapeHtml(c.status || 'draft')}">${escapeHtml(c.status || 'draft')}</span></td>
      </tr>`).join("");

    const [settings, { isUpgraded }] = await Promise.all([
      getSettingsForUser(userId),
      getPlanStatus(userId)
    ]);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>Campaigns</title><link rel="stylesheet" href="/styles.css"><script src="/toast.js"></script>
        <style>
          /* Meta-like surface + controls */
          .meta-card { background:#ffffff; border:1px solid #e5e7eb; border-radius:10px; padding:16px; }
          .meta-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; margin-top:10px; }
          .meta-input, .meta-select, .meta-textarea { height:38px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:8px; padding:8px 10px; font-size:14px; outline:none; }
          .meta-textarea { height:auto; resize:vertical; min-height:82px; }
          .meta-input:focus, .meta-select:focus, .meta-textarea:focus { border-color:#93c5fd; box-shadow:0 0 0 3px rgba(59,130,246,0.15); background:#ffffff; }
          .meta-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
          /* Buttons */
          .meta-form button { align-self:start; height:38px; }
          .meta-primary { 
            background:#2563eb; color:#fff; border:1px solid #1e40af; border-radius:8px; 
            padding:0 16px; min-width:120px; height:38px; font-weight:600; 
            display:inline-flex; align-items:center; justify-content:center; 
            transition:background .15s ease, box-shadow .15s ease, transform .02s ease;
          }
          .meta-primary:hover { background:#1d4ed8; box-shadow:0 1px 2px rgba(0,0,0,.06); }
          .meta-primary:active { transform:translateY(0.5px); }
          .meta-primary:focus { outline:none; box-shadow:0 0 0 3px rgba(59,130,246,0.25); }
          .meta-primary:disabled { opacity:.6; cursor:not-allowed; }
          .meta-ghost { 
            background:#ffffff; color:#111827; border:1px solid #e5e7eb; border-radius:8px; 
            padding:0 12px; height:38px; display:inline-flex; align-items:center; justify-content:center;
            transition:background .15s ease, border-color .15s ease;
          }
          .meta-ghost:hover { background:#f3f4f6; border-color:#d1d5db; }
          .meta-table { width:100%; border-collapse:separate; border-spacing:0; }
          .meta-table thead th { text-align:left; font-size:12px; color:#6b7280; background:#f8fafc; padding:10px; border-bottom:1px solid #e5e7eb; }
          .meta-table tbody td { padding:10px; border-bottom:1px solid #eef2f7; font-size:14px; }
          .meta-table tbody tr:hover { background:#f9fafb; }
          .badge { padding:4px 8px; border-radius:9999px; font-size:12px; border:1px solid #e5e7eb; background:#f9fafb; }
          .badge.APPROVED { background:#ecfdf5; color:#065f46; border-color:#a7f3d0; }
          .badge.submitted { background:#fef3c7; color:#92400e; border-color:#fde68a; }
          .small.muted { color:#64748b; }
        </style>
      </head>
      <body>
        <div class="container">
        ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Campaigns`, email)}
          <div class="layout">
            ${renderSidebar('campaigns', { showBookings: !!(settings?.bookings_enabled), isUpgraded })}
            <main class="main">
              <div class="main-content">
                <div class="meta-card" style="margin-bottom:12px;">
                  <div class="meta-toolbar" style="gap:8px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                      <h3 style="margin:0;">Campaign Actions</h3>
                      <div class="small muted">Templates are required for messages beyond 24h.</div>
                    </div>
                    <div style="display:flex; gap:8px;">
                      <button id="openCreateCampaign" class="meta-primary" type="button">Create Campaign</button>
                      <button id="openSubmitTemplate" class="meta-ghost" type="button">Submit Template</button>
                      <form method="post" action="/campaigns/templates/sync" style="margin:0;">
                        <button class="meta-ghost" type="submit" title="Pull approved templates from Meta">Sync from Meta</button>
                      </form>
                    </div>
                  </div>
                </div>

                <!-- Modals (reuse global day-modal styles) -->
                <style>.meta-form-vertical { display:grid; grid-template-columns: 1fr; gap:10px; }</style>

                <div id="modalCreate" class="day-modal">
                  <div class="day-modal-overlay" data-close="modalCreate"></div>
                  <div class="day-modal-content" style="max-width: 900px;">
                    <div class="day-modal-header">
                      <strong>Create Campaign</strong>
                      <button class="day-modal-close" data-close="modalCreate">×</button>
                    </div>
                    <div class="day-modal-body">
                      <form method="post" action="/campaigns/send" class="meta-form-vertical">
                        <input class="settings-field meta-input" name="name" placeholder="Campaign name" required />
                        <select class="settings-field meta-select" name="segment_type">
                          <option value="all">All customers</option>
                          <option value="recent">Active in last N days</option>
                        </select>
                        <input class="settings-field meta-input" name="recent_days" placeholder="N days (for recent)" />
                        <select class="settings-field meta-select" name="mode">
                          <option value="send_now">Send now</option>
                          <option value="schedule">Schedule</option>
                        </select>
                        <input class="settings-field meta-input" type="datetime-local" name="scheduled_at" />
                        <select class="settings-field meta-select" name="kind">
                          <option value="text">Freeform Text</option>
                          <option value="template">Approved Template</option>
                        </select>
                        <input class="settings-field meta-input" name="template_name" placeholder="Template name (if template)" />
                        <input class="settings-field meta-input" name="template_lang" placeholder="Template language (e.g., en_US)" />
                        <input class="settings-field meta-input" name="text" placeholder="Message text (if text)" />
                        <button class="meta-primary" type="submit">Launch</button>
                      </form>
                    </div>
                  </div>
                </div>

                <div id="modalTemplate" class="day-modal">
                  <div class="day-modal-overlay" data-close="modalTemplate"></div>
                  <div class="day-modal-content" style="max-width: 900px;">
                    <div class="day-modal-header">
                      <strong>Submit Template for Approval</strong>
                      <button class="day-modal-close" data-close="modalTemplate">×</button>
                    </div>
                    <div class="day-modal-body">
                      <form method="post" action="/campaigns/templates/submit" class="meta-form-vertical">
                        <input class="settings-field meta-input" name="name" placeholder="Template name" required />
                        <input class="settings-field meta-input" name="language" placeholder="Language (e.g., en_US)" required />
                        <input class="settings-field meta-input" name="category" placeholder="Category (e.g., MARKETING)" />
                        <textarea class="settings-field meta-textarea" name="body" placeholder="Template body" rows="4" required></textarea>
                        <button class="meta-primary" type="submit">Submit for Approval</button>
                      </form>
                    </div>
                  </div>
                </div>

                <script>
                  (function(){
                    var openCreate = document.getElementById('openCreateCampaign');
                    var openTemplate = document.getElementById('openSubmitTemplate');
                    var modalCreate = document.getElementById('modalCreate');
                    var modalTemplate = document.getElementById('modalTemplate');
                    function show(el){ if(el) el.classList.add('show'); }
                    function hide(el){ if(el) el.classList.remove('show'); }
                    if(openCreate){ openCreate.addEventListener('click', function(){ show(modalCreate); }); }
                    if(openTemplate){ openTemplate.addEventListener('click', function(){ show(modalTemplate); }); }
                    document.addEventListener('click', function(e){
                      var closeId = e.target && e.target.getAttribute && e.target.getAttribute('data-close');
                      if(closeId){ var el = document.getElementById(closeId); hide(el); }
                    });
                    document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ hide(modalCreate); hide(modalTemplate); } });
                  })();
                </script>

                <div class="meta-card">
                  <h3 style="margin:0 0 10px 0;">Recent Campaigns</h3>
                  <div style="overflow:auto;">
                    <table class="meta-table"><thead><tr><th>Name</th><th>Segment</th><th>Mode</th><th>Scheduled</th><th>Status</th></tr></thead><tbody>${campRows || '<tr><td colspan="5" class="small">No campaigns yet</td></tr>'}</tbody></table>
                  </div>
                </div>

                <div class="meta-card" style="margin-top:12px;">
                  <h3 style="margin:0 0 10px 0;">Templates</h3>
                  <div style="overflow:auto;">
                    <table class="meta-table"><thead><tr><th>Name</th><th>Lang</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${tplRows || '<tr><td colspan="4" class="small">No templates yet</td></tr>'}</tbody></table>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  // Submit template for approval: create on Meta (Cloud API) then store locally
  app.post("/campaigns/templates/submit", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const db = getDB();
      const cfg = await getSettingsForUser(userId);

      const rawName = String(req.body?.name || '').trim();
      const language = String(req.body?.language || 'en_US').trim();
      const category = String(req.body?.category || 'MARKETING').trim();
      const bodyText = String(req.body?.body || '').trim();
      if (!rawName || !language || !bodyText) {
        return res.redirect('/campaigns?toast=' + encodeURIComponent('Missing template name, language or body') + '&type=error');
      }
      if (!cfg?.whatsapp_token || (!cfg?.waba_id && !cfg?.phone_number_id)) {
        return res.redirect('/campaigns?toast=' + encodeURIComponent('Connect WhatsApp in Settings (token + WABA ID or Phone Number ID) before submitting templates.') + '&type=error');
      }

      // Resolve WABA ID if not provided
      let wabaId = cfg?.waba_id || null;
      try {
        if (!wabaId && cfg?.phone_number_id) {
          const fetch = (await import('node-fetch')).default;
          const phoneResp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(String(cfg.phone_number_id))}?fields=whatsapp_business_account`, {
            headers: { Authorization: `Bearer ${cfg.whatsapp_token}` }
          });
          if (phoneResp.ok) {
            const phoneJson = await phoneResp.json();
            wabaId = phoneJson?.whatsapp_business_account?.id || null;
          }
        }
      } catch {}
      if (!wabaId) {
        return res.redirect('/campaigns?toast=' + encodeURIComponent('Could not determine WABA ID from settings. Please set it in Settings.') + '&type=error');
      }

      // Sanitize name to Meta format (lowercase, underscores only)
      const name = rawName.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 512) || 'template_' + Date.now();

      // Create template on Meta
      let createOk = false; let respStatus = null; let respText = '';
      try {
        const fetch = (await import('node-fetch')).default;
        const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(String(wabaId))}/message_templates`;
        const payload = {
          name,
          category,
          language,
          components: [ { type: 'BODY', text: bodyText } ]
        };
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.whatsapp_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        respStatus = r.status;
        if (!r.ok) {
          respText = await r.text().catch(()=>String(r.status));
        } else {
          createOk = true;
        }
      } catch (e) {
        respText = e?.message || String(e);
      }

      if (!createOk) {
        console.warn('[Templates][Create] Meta API error', { status: respStatus, text: respText?.slice?.(0,200) });
        return res.redirect('/campaigns?toast=' + encodeURIComponent('Meta template create failed. Check your token/WABA and fields, then try again.') + '&type=error');
      }

      // Store a local record for quick reference
      try {
        await db.collection('wa_templates').updateOne(
          { user_id: String(userId), name, language },
          { $set: { category, body: bodyText, status: 'submitted', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
          { upsert: true }
        );
      } catch {}

      // Redirect with success and encourage sync
      return res.redirect('/campaigns?toast=' + encodeURIComponent('Template submitted to Meta. It may take a few minutes to appear. Use Sync from Meta to refresh.') + '&type=success');
    } catch (e) {
      console.error('Template submit error:', e?.message || e);
      return res.status(500).json({ error: 'submit_failed' });
    }
  });

  // Sync approved templates from Meta (WhatsApp Cloud API)
  app.post("/campaigns/templates/sync", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const db = getDB();
      const cfg = await getSettingsForUser(userId);
      if (!cfg?.whatsapp_token || !cfg?.phone_number_id) {
        return res.redirect('/campaigns?toast=' + encodeURIComponent('Missing WhatsApp configuration (token or phone number ID).') + '&type=error');
      }
      const fetch = (await import('node-fetch')).default;
      // Guardrails so the sync stays within Vercel's 30s function timeout
      const SYNC_HARD_LIMIT = 500;           // Max templates to process per request
      const SYNC_TIME_BUDGET_MS = 20000;     // Soft time budget to avoid 504s
      const startedAt = Date.now();
      let reachedLimit = false;
      let hitTimeBudget = false;
      // Step 1: derive WABA ID from settings or via phone lookup
      let wabaId = cfg?.waba_id || null;
      if (!wabaId) {
        const phoneResp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(String(cfg.phone_number_id))}?fields=whatsapp_business_account`, {
          headers: { Authorization: `Bearer ${cfg.whatsapp_token}` }
        });
        if (!phoneResp.ok) {
          const text = await phoneResp.text().catch(()=>String(phoneResp.status));
          throw new Error(`Phone lookup failed ${phoneResp.status}: ${text.slice(0,120)}`);
        }
        const phoneJson = await phoneResp.json();
        wabaId = phoneJson?.whatsapp_business_account?.id;
        if (!wabaId) throw new Error('Could not determine WABA ID');
      }

      // Step 2: list message templates with pagination
      let url = `https://graph.facebook.com/v20.0/${encodeURIComponent(String(wabaId))}/message_templates?limit=100`;
      let count = 0;
      while (url) {
        // Respect a soft time budget so we don't hit Vercel's hard timeout
        if (Date.now() - startedAt > SYNC_TIME_BUDGET_MS) {
          hitTimeBudget = true;
          break;
        }

        const r = await fetch(url, { headers: { Authorization: `Bearer ${cfg.whatsapp_token}` } });
        if (!r.ok) throw new Error(`Templates fetch failed ${r.status}`);
        const j = await r.json();
        const data = Array.isArray(j?.data) ? j.data : [];
        for (const t of data) {
          const key = {
            user_id: String(userId),
            name: t?.name || null,
            language: t?.language || null
          };
          const existing = await db.collection('wa_templates').findOne(key);
          const setDoc = {
            category: t?.category || null,
            status: t?.status || null,
            quality_score: t?.quality_score || null,
            components: t?.components || [],
            last_updated_time: t?.last_updated_time ? new Date(t.last_updated_time) : null,
            updatedAt: new Date()
          };
          await db.collection('wa_templates').updateOne(
            key,
            { $set: setDoc, $setOnInsert: { user_id: key.user_id, name: key.name, language: key.language, createdAt: new Date() } },
            { upsert: true }
          );
          const oldStatus = existing?.status ? String(existing.status) : null;
          const newStatus = setDoc.status ? String(setDoc.status) : null;
          if (newStatus && newStatus !== oldStatus) {
            const up = newStatus.toUpperCase();
            if (up === 'APPROVED' || up.startsWith('REJECTED')) {
              try { await sendTemplateStatusEmail(userId, { ...key, ...setDoc }, oldStatus); } catch {}
            }
          }
          count++;

          if (count >= SYNC_HARD_LIMIT) {
            reachedLimit = true;
            break;
          }

          if (Date.now() - startedAt > SYNC_TIME_BUDGET_MS) {
            hitTimeBudget = true;
            break;
          }
        }
        if (reachedLimit || hitTimeBudget) break;
        url = j?.paging?.next || null;
      }
      let msg;
      if (!count) {
        msg = 'No template changes found';
      } else if (reachedLimit || hitTimeBudget) {
        msg = `Synced ${count} template${count===1?'':'s'} from Meta (partial sync; run again to continue)`;
      } else {
        msg = `Synced ${count} template${count===1?'':'s'} from Meta`;
      }
      return res.redirect('/campaigns?toast=' + encodeURIComponent(msg) + '&type=success');
    } catch (e) {
      console.error('Templates sync error:', e?.message || e);
      const errMsg = e?.message ? `Sync failed: ${e.message}` : 'Sync failed';
      return res.redirect('/campaigns?toast=' + encodeURIComponent(errMsg) + '&type=error');
    }
  });

  // Send/schedule campaign
  app.post("/campaigns/send", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const db = getDB();
      const cfg = await getSettingsForUser(userId);

      const name = String(req.body?.name || 'Campaign').trim();
      const segmentType = String(req.body?.segment_type || 'all');
      const recentDays = Number(req.body?.recent_days || 0);
      const mode = String(req.body?.mode || 'send_now');
      const kind = String(req.body?.kind || 'text');
      const text = String(req.body?.text || '').trim();
      const templateName = String(req.body?.template_name || '').trim();
      const templateLang = String(req.body?.template_lang || 'en_US').trim();
      const scheduledAt = req.body?.scheduled_at ? Math.floor(new Date(req.body.scheduled_at).getTime()/1000) : null;

      // Resolve audience
      let contacts = [];
      if (segmentType === 'recent' && recentDays > 0) {
        const since = Math.floor(Date.now()/1000) - recentDays*86400;
        const messages = await db.collection('messages').aggregate([
          { $match: { user_id: String(userId), direction: 'inbound', timestamp: { $gte: since } } },
          { $group: { _id: '$from_digits', last_ts: { $max: '$timestamp' } } }
        ]).toArray();
        contacts = messages.map(m => m._id).filter(Boolean);
      } else {
        const rows = await db.collection('customers').find({ user_id: String(userId) }, { projection: { contact_id: 1 } }).limit(5000).toArray();
        contacts = rows.map(r => r.contact_id).filter(Boolean);
      }

      // Store campaign record
      const camp = {
        user_id: String(userId),
        name,
        segment: { type: segmentType, recent_days: recentDays || null },
        mode,
        kind,
        text: kind === 'text' ? text : null,
        template_name: kind === 'template' ? templateName : null,
        template_lang: kind === 'template' ? templateLang : null,
        scheduled_at: mode === 'schedule' ? scheduledAt : null,
        status: mode === 'schedule' ? 'scheduled' : 'sent',
        audience_size: contacts.length,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const { insertedId } = await db.collection('wa_campaigns').insertOne(camp);
      const campaignId = insertedId?.toString?.() || null;

      // If send_now, dispatch
      if (mode === 'send_now') {
        for (const phone of contacts) {
          try {
            if (kind === 'template') {
              // Try template send; if fails, skip silently
              try { await sendWhatsAppTemplate(phone, templateName || 'hello_world', templateLang || 'en_US', [], cfg); } catch {}
            } else {
              const jobId = await enqueueOutboundMessage({
                userId,
                cfg,
                to: phone,
                message: text || '',
                idempotencyKey: campaignId ? `campaign:${campaignId}:${phone}` : undefined
              });
              if (!jobId) {
                await sendWhatsAppText(phone, text || '', cfg);
              }
            }
          } catch {}
        }
      }

      return res.redirect('/campaigns');
    } catch (e) {
      console.error('Campaign send error:', e?.message || e);
      return res.status(500).json({ error: 'campaign_failed' });
    }
  });
}
