import { ensureAuthed, getSignedInEmail, getCurrentUserId, signSessionToken } from "../middleware/auth.mjs";
import { renderSidebar, escapeHtml, renderTopbar, getProfessionalHead } from "../utils.mjs";
import { db } from "../db-mongodb.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { ONBOARD_STEPS, getOnboarding } from "../services/onboarding.mjs";
import { getCurrentUsage, getUserPlan } from "../services/usage.mjs";

export default function registerDashboardRoutes(app) {
  app.get("/dashboard", ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);
    const s = await getSettingsForUser(userId);
    const onboardingState = await getOnboarding(userId);
    const [usage, plan] = await Promise.all([
      getCurrentUsage(userId),
      getUserPlan(userId)
    ]);
    const isUpgraded = (plan?.plan_name || 'free') !== 'free';

    const kbCompletedSteps = Math.min(onboardingState?.step || 0, ONBOARD_STEPS.length);
    const kbStepCompleted = !isUpgraded || kbCompletedSteps >= ONBOARD_STEPS.length;
    const metaStepCompleted = !!(s.phone_number_id && s.waba_id && s.business_phone);
    const tokensStepCompleted = !!(s.whatsapp_token && s.app_secret && s.verify_token);
    const allCompleted = metaStepCompleted && tokensStepCompleted && kbStepCompleted;
    const showSetupGuide = !allCompleted;
    
    // Get usage and plan info (metrics)
    const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;    

    // High-level setup steps for the guide widget
    const setupSections = [
      {
        id: 'meta',
        title: 'Connect your Meta account',
        items: [
          'Create or log in to your Meta for Developers account.',
          'Create a WhatsApp Business app.',
          'Link a WhatsApp Business Account (WABA) and phone number.'
        ]
      },
      {
        id: 'tokens',
        title: 'Configure WhatsApp API keys',
        items: [
          'Copy your Phone Number ID and WhatsApp Business Account ID.',
          'Copy your Business phone number.',
          'Generate a long‑lived WhatsApp access token.',
          'Set your App Secret and Verify Token in WhatsApp Agent settings.'
        ]
      }
    ];

    if (isUpgraded) {
      setupSections.push({
        id: 'kb',
        title: 'Set up your Knowledge Base',
        items: [
          'Add your most important FAQs.',
          'Import documents or website content.',
          'Test answers using the KB assistant.'
        ]
      });
    }

    const totalSetupSteps = setupSections.length || 1;
    const completedSetupSteps =
      (metaStepCompleted ? 1 : 0) +
      (tokensStepCompleted ? 1 : 0) +
      (isUpgraded && kbStepCompleted ? 1 : 0);
    const setupProgress = Math.round((completedSetupSteps / totalSetupSteps) * 100);
    const nextSection = setupSections[completedSetupSteps] || setupSections[0];
    const nextStepLabel = 'Next: ' + escapeHtml(nextSection.title);

    const setupStepItems = setupSections.map((section, index) => {
      const first = index === 0;
      const sectionId = section.id;
      const sectionCompleted =
        sectionId === 'meta' ? metaStepCompleted :
        sectionId === 'tokens' ? tokensStepCompleted :
        kbStepCompleted;

      let itemsHtml;
      if (sectionId === 'tokens') {
        const tokenTaskStatus = {
          phone_waba: !!(s.phone_number_id && s.waba_id),
          business_phone: !!s.business_phone,
          whatsapp_token: !!s.whatsapp_token,
          app_secret_verify: !!(s.app_secret && s.verify_token)
        };
        itemsHtml = `
          <li class="sg-item ${tokenTaskStatus.phone_waba ? 'sg-item-completed' : ''}" data-task-id="phone_waba">
            Copy your Phone Number ID and WhatsApp Business Account ID.
          </li>
          <li class="sg-item ${tokenTaskStatus.business_phone ? 'sg-item-completed' : ''}" data-task-id="business_phone">
            Copy your Business phone number.
          </li>
          <li class="sg-item ${tokenTaskStatus.whatsapp_token ? 'sg-item-completed' : ''}" data-task-id="whatsapp_token">
            Generate a long-lived WhatsApp access token.
          </li>
          <li class="sg-item ${tokenTaskStatus.app_secret_verify ? 'sg-item-completed' : ''}" data-task-id="app_secret_verify">
            Set your App Secret and Verify Token in WhatsApp Agent settings.
          </li>
        `;
      } else {
        itemsHtml = (section.items || []).map(text => `
          <li class="sg-item">${escapeHtml(text)}</li>
        `).join('');
      }

      return `
        <div class="sg-section">
          <button type="button" class="sg-section-header${first ? ' open' : ''}${sectionCompleted ? ' completed' : ''}" data-section-id="${sectionId}">
            <span class="sg-section-title">${escapeHtml(section.title)}</span>
            <span class="sg-section-right">
              <span class="sg-section-check">${sectionCompleted ? '✓' : ''}</span>
              <span class="sg-section-chevron">⌃</span>
            </span>
          </button>
          <div class="sg-section-body" id="sg-section-${sectionId}" style="${first ? '' : 'display:none;'}">
            <ul class="sg-items">
              ${itemsHtml}
            </ul>
            ${sectionId === 'meta' ? `
              <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener" class="sg-link">Open Meta for Developers ↗</a>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const setupGuideHtml = showSetupGuide ? `
      <div class="setup-guide-card setup-expanded" id="setupGuideCard">
        <div class="setup-guide-header">
          <span>Setup guide</span>
          <button type="button" class="setup-guide-link" id="setupGuideToggle">Minimize</button>
        </div>
        <div class="setup-guide-progress">
          <div class="setup-guide-progress-bar" style="width:${setupProgress}%;"></div>
        </div>
        <div class="setup-guide-next">${nextStepLabel}</div>
        <div class="setup-guide-steps">
          ${setupStepItems}
        </div>
      </div>
      <style>
        .setup-guide-card {
          position: fixed;
          z-index: 900;
          background: #fff;
          border-radius: 16px;
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.25);
          border: 1px solid #e5e7eb;
          transition: all 0.25s ease;
        }
        .setup-guide-card.setup-expanded {
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 320px;
          max-width: 90vw;
          padding: 18px 18px 16px 18px;
        }
        .setup-guide-card.setup-minimized {
          top: 24px;
          left: 24px;
          transform: none;
          width: 260px;
          max-width: 80vw;
          padding: 12px 14px 10px 14px;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
        }
        .setup-guide-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 600;
          color: #111827;
          margin-bottom: 12px;
        }
        .setup-guide-link {
          font-size: 12px;
          color: #6366f1;
          text-decoration: none;
          border: none;
          background: transparent;
          cursor: pointer;
        }
        .setup-guide-progress {
          height: 4px;
          background: #ede9fe;
          border-radius: 999px;
          margin-bottom: 12px;
          overflow: hidden;
        }
        .setup-guide-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
        }
        .setup-guide-next {
          font-size: 13px;
          color: #4b5563;
          margin: 8px 0 4px 0;
        }
        .setup-guide-steps {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .sg-section {
          border-radius: 10px;
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          overflow: hidden;
        }
        .sg-section-header {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          background: #f9fafb;
          border: none;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          color: #111827;
        }
        .sg-section-header.open {
          background: #eef2ff;
        }
        .sg-section-title {
          text-align: left;
        }
        .sg-section-right {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .sg-section-check {
          font-size: 12px;
          color: #16a34a;
          opacity: 0;
        }
        .sg-section-chevron {
          font-size: 11px;
          transform: rotate(0deg);
          transition: transform 0.15s ease;
        }
        .sg-section-header.open .sg-section-chevron {
          transform: rotate(180deg);
        }
        .sg-section-body {
          padding: 8px 10px 10px 10px;
          background: #ffffff;
        }
        .sg-items {
          list-style: disc;
          margin: 0 0 6px 16px;
          padding: 0;
          font-size: 13px;
          color: #4b5563;
        }
        .sg-item + .sg-item {
          margin-top: 4px;
        }
        .sg-link {
          font-size: 12px;
          color: #6366f1;
          text-decoration: none;
        }
        .sg-section-header.completed .sg-section-title {
          text-decoration: line-through;
          color: #6b7280;
        }
        .sg-section-header.completed .sg-section-check {
          opacity: 1;
        }
        .sg-item-completed {
          text-decoration: line-through;
          color: #9ca3af;
        }
        .setup-guide-footer {
          margin-top: 12px;
        }
        .setup-guide-card.setup-minimized .setup-guide-steps,
        .setup-guide-card.setup-minimized .setup-guide-footer {
          display: none;
        }
        .setup-guide-card.setup-expanded .setup-guide-next {
          display: none;
        }
        .setup-guide-card.setup-minimized .setup-guide-next {
          display: block;
        }
        @media (max-width: 900px) {
          .setup-guide-card {
            position: fixed;
            width: 90vw;
          }
        }
        .sg-modal {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          background: rgba(15,23,42,0.35);
          z-index: 950;
        }
        .sg-modal-dialog {
          background: #ffffff;
          border-radius: 16px;
          padding: 16px 18px 14px 18px;
          max-width: 400px;
          width: 90vw;
          box-shadow: 0 24px 60px rgba(15,23,42,0.35);
          border: 1px solid #e5e7eb;
        }
        .sg-modal-title {
          margin: 0 0 10px 0;
          font-size: 15px;
          font-weight: 600;
          color: #111827;
        }
        .sg-modal-fields {
          display: grid;
          gap: 8px;
          margin-bottom: 12px;
        }
        .sg-modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .sg-btn {
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid #e5e7eb;
          background: #f9fafb;
          font-size: 13px;
          cursor: pointer;
        }
        .sg-btn-primary {
          background: #4f46e5;
          border-color: #4f46e5;
          color: #ffffff;
        }
      </style>
      <script>
        (function(){
          try {
            var card = document.getElementById('setupGuideCard');
            var toggle = document.getElementById('setupGuideToggle');
            var modal = document.getElementById('sgModal');
            var modalTitle = document.getElementById('sgModalTitle');
            var modalFields = document.getElementById('sgModalFields');
            var modalForm = document.getElementById('sgModalForm');
            var modalCancel = document.getElementById('sgModalCancel');
            if (!card || !toggle) return;
            var key = 'wa_setup_guide_minimized';
            function applyState(minimized) {
              card.classList.toggle('setup-minimized', minimized);
              card.classList.toggle('setup-expanded', !minimized);
              toggle.textContent = minimized ? 'Expand' : 'Minimize';
            }
            var saved = null;
            try { saved = window.localStorage.getItem(key); } catch(_) {}
            applyState(saved === '1');
            toggle.addEventListener('click', function(){
              var minimizedNow = card.classList.contains('setup-expanded');
              applyState(minimizedNow);
              try { window.localStorage.setItem(key, minimizedNow ? '1' : '0'); } catch(_) {}
            });

            // Accordion behavior for setup sections
            var headers = card.querySelectorAll('.sg-section-header');
            headers.forEach(function(btn){
              btn.addEventListener('click', function(){
                var id = this.getAttribute('data-section-id');
                var body = document.getElementById('sg-section-' + id);
                var isOpen = this.classList.contains('open');
                headers.forEach(function(h){
                  h.classList.remove('open');
                  var hid = h.getAttribute('data-section-id');
                  var hb = document.getElementById('sg-section-' + hid);
                  if (hb) hb.style.display = 'none';
                });
                if (!isOpen && body) {
                  this.classList.add('open');
                  body.style.display = 'block';
                }
              });
            });

            // Setup task → modal mapping (step 2)
            var TASK_CONFIG = {
              phone_waba: {
                title: 'Phone Number ID & WABA ID',
                fields: [
                  { name: 'phone_number_id', label: 'Phone Number ID', placeholder: '8***************' },
                  { name: 'waba_id', label: 'WhatsApp Business Account ID', placeholder: '2208283003006315' }
                ]
              },
              business_phone: {
                title: 'Business phone number',
                fields: [
                  { name: 'business_phone', label: 'Business phone', placeholder: '1***************' }
                ]
              },
              whatsapp_token: {
                title: 'WhatsApp token',
                fields: [
                  { name: 'whatsapp_token', label: 'WhatsApp token', placeholder: 'E***************' }
                ]
              },
              app_secret_verify: {
                title: 'App Secret & Verify Token',
                fields: [
                  { name: 'app_secret', label: 'App Secret', placeholder: 'c***************' },
                  { name: 'verify_token', label: 'Verify token', placeholder: '***************' }
                ]
              }
            };

            function openTaskModal(taskId) {
              if (!modal || !modalTitle || !modalFields || !modalForm) return;
              var cfg = TASK_CONFIG[taskId];
              if (!cfg) return;
              modalTitle.textContent = cfg.title;
              modalFields.innerHTML = '';
              cfg.fields.forEach(function(f){
                var wrapper = document.createElement('div');
                wrapper.className = 'sg-modal-field';
                wrapper.innerHTML = '<label>'+f.label+'<input class="settings-field" name="'+f.name+'" placeholder="'+(f.placeholder||'')+'"/></label>';
                modalFields.appendChild(wrapper);
              });
              modal.setAttribute('data-task-id', taskId);
              modal.style.display = 'flex';
            }

            function closeTaskModal() {
              if (!modal) return;
              modal.style.display = 'none';
              modal.removeAttribute('data-task-id');
              if (modalForm) modalForm.reset();
            }

            if (modalCancel) {
              modalCancel.addEventListener('click', function(e){
                e.preventDefault();
                closeTaskModal();
              });
            }

            if (modalForm) {
              modalForm.addEventListener('submit', function(e){
                e.preventDefault();
                if (!modal) return;
                var taskId = modal.getAttribute('data-task-id');
                var cfg = TASK_CONFIG[taskId];
                if (!cfg) return;
                var formData = new FormData(modalForm);
                var updates = {};
                cfg.fields.forEach(function(f){
                  var v = (formData.get(f.name) || '').toString().trim();
                  if (v) updates[f.name] = v;
                });
                if (!Object.keys(updates).length) {
                  closeTaskModal();
                  return;
                }
                fetch('/api/settings/setup-task', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                  },
                  credentials: 'include',
                  body: JSON.stringify({ updates })
                }).then(function(resp){ return resp.json(); })
                  .then(function(data){
                    if (data && data.success) {
                      window.location.reload();
                    } else {
                      alert(data && data.error ? data.error : 'Failed to save settings');
                    }
                  }).catch(function(err){
                    console.error('Setup task save error', err);
                    alert('Failed to save settings');
                  }).finally(function(){
                    closeTaskModal();
                  });
              });
            }

            // Attach click handlers to clickable tasks
            var taskItems = card.querySelectorAll('.sg-item[data-task-id]');
            taskItems.forEach(function(li){
              li.style.cursor = 'pointer';
              li.addEventListener('click', function(){
                var id = this.getAttribute('data-task-id');
                openTaskModal(id);
              });
            });
          } catch(_) {}
        })();
      </script>
      <div class="sg-modal" id="sgModal">
        <div class="sg-modal-dialog">
          <h4 class="sg-modal-title" id="sgModalTitle"></h4>
          <form id="sgModalForm">
            <div class="sg-modal-fields" id="sgModalFields"></div>
            <div class="sg-modal-actions">
              <button type="button" class="sg-btn" id="sgModalCancel">Cancel</button>
              <button type="submit" class="sg-btn sg-btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    ` : '';

    // Create metrics dashboard HTML
    // Make this section scrollable so deeper content (like integrations) is reachable even on smaller screens.
    const metricsHtml = `
      <div style="padding: 16px; overflow-y: auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <h3 style="margin: 0;">Live Metrics</h3>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="customize-metrics" class="btn-ghost" style="font-size: 14px;">Customize</button>
            <button id="export-metrics" class="btn-ghost" style="font-size: 14px;">Export</button>
            <div style="display: flex; align-items: center; gap: 4px;">
              <span style="font-size: 12px; color: #6b7280;">Range:</span>
              <select id="metrics-range" style="font-size: 12px; padding: 2px 4px;">
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                <option value="last7">Last 7 days</option>
                <option value="last30">Last 30 days</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
              <span style="font-size: 12px; color: #6b7280;">Auto-refresh:</span>
              <select id="refresh-interval" style="font-size: 12px; padding: 2px 4px;">
                <option value="10">10s</option>
                <option value="30" selected>30s</option>
                <option value="60">1m</option>
                <option value="300">5m</option>
                <option value="0">Off</option>
              </select>
            </div>
          </div>
        </div>
        
        <!-- Metrics Grid -->
        <div id="metrics-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 16px;">
          <!-- Metrics will be populated by JavaScript -->
        </div>
        
        <!-- Hourly Chart -->
        <div id="hourly-chart-container" style="margin-top: 16px;">
          <h4 id="chart-title" style="margin: 0 0 12px 0; color: #374151;">Message Activity</h4>
          <div id="hourly-chart" style="height: 200px; background: #f9fafb; border-radius: 8px; padding: 16px; position: relative;">
            <canvas id="chart-canvas" width="100%" height="100%"></canvas>
          </div>
        </div>
        
        <!-- Customization Modal -->
        <div id="customize-modal" style="display:none; position:fixed; inset:0; background: rgba(17,24,39,0.45); backdrop-filter: blur(4px); z-index:1000;">
          <div style="position:absolute; top:50%; left:50%; transform: translate(-50%, -50%); width: min(760px, 92vw);">
            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:16px; box-shadow:0 24px 60px rgba(0,0,0,0.2); overflow:hidden;">
              <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #f1f5f9;">
                <h3 style="margin:0; font-size:18px;">Customize Dashboard</h3>
                <button id="cancel-customize" class="btn-ghost" aria-label="Close" title="Close" style="border:none; font-size:18px; line-height:1;">×</button>
              </div>
              <div style="padding:16px 20px;">
                <div style="margin:0 0 12px 0; font-weight:600; color:#111827;">Visible Metrics:</div>
                <div id="metrics-checkboxes" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px; align-items:stretch;">
                  <!-- Options render here -->
                </div>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; padding:12px 20px; border-top:1px solid #f1f5f9; background:#fafafa;">
                <button id="cancel-customize-footer" class="btn-ghost">Cancel</button>
                <button id="save-customize" class="btn">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    const paymentsHtml = `
      <div style="padding:0 16px 24px 16px; margin-top:24px;">
        <div class="card" id="paymentsCard">
          <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 4px 0; display:flex; align-items:center; gap:8px;">
                <img src="/stripe-icon.svg" alt="Stripe" width="20" height="20" style="display:inline-block;">
                Stripe payments
              </h3>
              <div class="small" id="stripeStatusCaption">Connect Stripe to request payments from the inbox.</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <a class="btn" id="stripeConnectBtn" href="/stripe/connect/start?redirect=/dashboard">Connect Stripe</a>
              <button class="btn-ghost" id="stripeDisconnectBtn" style="display:none;">Disconnect</button>
            </div>
          </div>
        </div>
      </div>
      <script>
        (function(){
          const card = document.getElementById('paymentsCard');
          if (!card) return;
          const caption = document.getElementById('stripeStatusCaption');
          const connectBtn = document.getElementById('stripeConnectBtn');
          const disconnectBtn = document.getElementById('stripeDisconnectBtn');
          async function fetchStatus(){
            try {
              const resp = await fetch('/api/payments/stripe/status', { headers: { 'Accept':'application/json' } });
              const data = await resp.json();
              if (!data.success) throw new Error('Failed to load status');
              const connected = !!data.connected;
              connectBtn.style.display = connected ? 'none' : 'inline-flex';
              disconnectBtn.style.display = connected ? 'inline-flex' : 'none';
              if (connected) {
                const acc = data.account || {};
                caption.textContent = acc.charges_enabled ? 'Payments ready to use in the inbox.' : 'Connected. Finish onboarding inside Stripe to start requesting payments.';
              } else {
                caption.textContent = data.available ? 'Connect to send payment links directly from conversations.' : 'Stripe Connect is not configured yet.';
              }
            } catch (err) {
              console.error('Stripe status load failed', err);
            }
          }
          disconnectBtn?.addEventListener('click', async () => {
            disconnectBtn.disabled = true;
            try {
              const resp = await fetch('/api/payments/stripe/disconnect', { method: 'POST' });
              if (!resp.ok) throw new Error('Disconnect failed');
              await fetchStatus();
            } catch (err) {
              console.error('Stripe disconnect failed', err);
            } finally {
              disconnectBtn.disabled = false;
            }
          });
          fetchStatus();
        })();
      </script>
    `;
    
    let apptHtml = '';
    let apptJson = '[]';
    let intakeHtml = '';
    if (s?.bookings_enabled) {
      const rows = db.prepare(`
        SELECT a.id, a.start_ts, a.end_ts, a.contact_phone, a.status, a.notes,
               s.name AS staff_name
        FROM appointments a
        LEFT JOIN staff s ON s.id = a.staff_id
        WHERE a.user_id = ? AND a.status = 'confirmed' AND a.start_ts >= strftime('%s','now')
        ORDER BY a.start_ts ASC
        LIMIT 20
      `).all(userId);
      apptJson = JSON.stringify(rows);
      const items = rows.map(r => {
        const start = new Date((r.start_ts||0)*1000).toLocaleString();
        const phone = (r.contact_phone||'').replace(/\D/g,'');
        const displayPhone = phone ? `+${phone}` : 'Unknown';
        // Pull first two answers from notes formatted as "Q: A | Q: A"
        let summaryValues = [];
        if (r.notes && typeof r.notes === 'string') {
          const parts = r.notes.split('|').map(p => p.trim()).filter(Boolean);
          for (const p of parts) {
            const idx = p.indexOf(':');
            const val = idx >= 0 ? p.slice(idx+1).trim() : p;
            if (val) summaryValues.push(val);
            if (summaryValues.length >= 2) break;
          }
        }
        const headline = escapeHtml(summaryValues[0] || displayPhone);
        const detail = escapeHtml(summaryValues[1] || (r.staff_name ? `Staff: ${r.staff_name}` : ''));
        const meta = `Ref #${r.id} · ${r.status}${r.staff_name ? ` · ${escapeHtml(r.staff_name)}` : ''}`;
        const startISO = new Date((r.start_ts||0)*1000).toISOString();
        const endISO = new Date((r.end_ts||0)*1000).toISOString();
        const title = encodeURIComponent((s?.business_name ? `Appointment with ${s.business_name}` : 'Appointment'));
        const desc = encodeURIComponent(`Ref #${r.id}`);
        const loc = encodeURIComponent(s?.website_url || '');
        const dt = (iso) => { const d = new Date(iso); const p=n=>String(n).padStart(2,'0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };
        const gDates = `${dt(startISO)}/${dt(endISO)}`;
        const gHref = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${gDates}&details=${desc}&location=${loc}`;
        const icsRel = `/ics?title=${title}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&desc=${desc}&loc=${loc}`;
        return `
          <li class="inbox-item">
            <div>
              <div class="wa-name">${headline}</div>
              <div class="item-ts small">${start}</div>
              <div class="item-preview small">${meta}</div>
              ${detail ? `<div class=\"item-preview small\">${detail}</div>` : ''}
              <div class="small" style="margin-top:6px; display:flex; gap:10px; align-items:center;">
                <a class="btn-ghost" style="border:none;" href="${icsRel}" target="_blank" rel="noopener">Add to Apple/ICS</a>
                <a class="btn-ghost" style="border:none;" href="${gHref}" target="_blank" rel="noopener">Add to Google</a>
              </div>
            </div>
          </li>
        `;
      }).join("");
      apptHtml = `
        <div class="card">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <h3 style="margin:0 0 8px 0;">Appointments</h3>
            <div style="display:flex; gap:8px;">
              <button id="btnList" class="btn-ghost" style="border:none;">List</button>
              <button id="btnCalendar" class="btn-ghost" style="border:none;">Calendar</button>
            </div>
          </div>
          <div id="listView">${items ? `<ul class=\"list\">${items}</ul>` : '<div class=\"small\">No upcoming appointments</div>'}</div>
          <div id="calendarView" style="display:none;">
            <div id="calendarRoot"></div>
          </div>
        </div>
        <script id="appointments-json" type="application/json">${apptJson.replace(/</g, '\\u003c')}</script>
        <script src="/calendar.js"></script>
        <script>
          (function(){
            var btnL = document.getElementById('btnList');
            var btnC = document.getElementById('btnCalendar');
            var list = document.getElementById('listView');
            var cal = document.getElementById('calendarView');
            if(btnL && btnC && list && cal){
              btnL.addEventListener('click', function(){ list.style.display='block'; cal.style.display='none'; });
              btnC.addEventListener('click', function(){ list.style.display='none'; cal.style.display='block'; });
            }
          })();
        </script>
      `;

      const q = (s.booking_questions_json || '["What\'s your name?","What\'s the reason for the booking?"]');
      intakeHtml = `
        <div class="card" style="margin-top:12px;">
          <h3 style="margin:0 0 8px 0;">Booking Intake Questions</h3>
          <div class="small" style="margin-bottom:8px;">Define the questions your bot will ask after a slot is selected.</div>
          <form id="booking-q-form" method="post" action="/dashboard/booking-questions" style="display:grid; gap:8px;">
            <input type="hidden" name="booking_questions_json" id="booking_questions_json" />
            <div id="q-list" style="display:grid; gap:8px;"></div>
            <div style="display:flex; gap:8px;">
              <button type="button" id="add-q" class="btn-ghost" style="border:none;">Add question</button>
              <div style="flex:1;"></div>
              <button type="submit">Save questions</button>
            </div>
          </form>
          <script type="application/json" id="initial-q">${q.replace(/</g, '\\u003c')}</script>
          <script>
            (function(){
              function parseInitial(){
                try{ var txt = document.getElementById('initial-q')?.textContent || '[]';
                  var arr = JSON.parse(txt); return Array.isArray(arr) ? arr : []; }catch(e){ return []; }
              }
              var questions = parseInitial();
              if(!questions.length){ questions = ["What's your name?","What's the reason for the booking?"]; }
              questions = questions.slice(0, 10).map(function(q){ return String(q||'').trim(); }).filter(Boolean);

              var listEl = document.getElementById('q-list');
              var formEl = document.getElementById('booking-q-form');
              var hiddenEl = document.getElementById('booking_questions_json');
              var addBtn = document.getElementById('add-q');

              function render(){
                while(listEl.firstChild){ listEl.removeChild(listEl.firstChild); }
                questions.forEach(function(val, idx){
                  var row = document.createElement('div');
                  row.style.display = 'flex';
                  row.style.gap = '8px';

                  var input = document.createElement('input');
                  input.className = 'settings-field';
                  input.type = 'text';
                  input.placeholder = 'Question ' + (idx+1);
                  input.value = val;
                  input.style.flex = '1';

                  var del = document.createElement('button');
                  del.type = 'button';
                  del.className = 'btn-ghost';
                  del.style.border = 'none';
                  del.title = 'Delete';
                  del.innerHTML = '<img src="/delete-icon.svg" alt="Delete"/>';
                  del.addEventListener('click', function(){
                    questions.splice(idx, 1);
                    if(!questions.length){ questions.push(''); }
                    render();
                  });

                  row.appendChild(input);
                  row.appendChild(del);
                  listEl.appendChild(row);
                });
              }

              addBtn && addBtn.addEventListener('click', function(){
                if(questions.length >= 10) return;
                questions.push('');
                render();
              });

              formEl && formEl.addEventListener('submit', function(){
                var inputs = listEl.querySelectorAll('input.settings-field');
                var out = [];
                inputs.forEach(function(i){ var v = String(i.value||'').trim(); if(v) out.push(v); });
                hiddenEl.value = JSON.stringify(out.slice(0, 10));
              });

              if(!questions.length){ questions = ['']; }
              render();
            })();
          </script>
        </div>
      `;
    }
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead('Dashboard')}<body>
        <script src="/auth-utils.js"></script>
        <script>
          // Enhanced authentication check on page load
          (async function checkAuthOnLoad(){
            await window.authManager.checkAuthOnLoad();
          })();
          
          // Enhanced auth check for form submission
          async function checkAuthThenSubmit(form){
            return window.authManager.submitFormWithAuth(form);
          }
          function toggleMiniOnboard(force){
            const box = document.getElementById('mini-onboard');
            const btn = document.getElementById('kb-toggle');
            if(!box) return;
            const show = (typeof force === 'boolean') ? force : box.style.display === 'none';
            box.style.display = show ? 'block' : 'none';
            // Keep the button from shifting by hiding it while the assistant is open
            if (btn) {
              btn.style.position = 'fixed';
              btn.style.left = 'auto';
              btn.style.right = '24px';
              btn.style.bottom = '24px';
              btn.style.display = show ? 'none' : 'flex';
            }
          }
          
          // Metrics Dashboard functionality
          let metricsData = {};
          let userPreferences = {};
          let refreshInterval = null;
          let currentRange = 'today';
          try {
            const storedRange = window.localStorage.getItem('wa_metrics_range');
            if (storedRange) currentRange = storedRange;
          } catch (_) {}
          
          // Available metrics configuration
          const availableMetrics = {
            'messages_sent_today': { label: 'Messages Sent', icon: '📤', color: '#10b981' },
            'messages_received_today': { label: 'Messages Received', icon: '📥', color: '#3b82f6' },
            'messages_trend': { label: 'Message Trends', icon: '📈', color: '#8b5cf6' },
            'active_conversations': { label: 'Active Conversations', icon: '💬', color: '#f59e0b' },
            'response_time': { label: 'Avg Response Time', icon: '⏱️', color: '#ef4444' },
            'ai_success_rate': { label: 'AI Success Rate', icon: '🤖', color: '#06b6d4' },
            'template_usage': { label: 'Template Usage', icon: '📋', color: '#84cc16' },
            'system_health': { label: 'System Health', icon: '💚', color: '#22c55e' },
            'tickets_new': { label: 'New Tickets', icon: '🎫', color: '#3b82f6' },
            'tickets_in_progress': { label: 'Tickets In Progress', icon: '🔄', color: '#f59e0b' },
            'tickets_resolved': { label: 'Tickets Resolved', icon: '✅', color: '#10b981' },
            'tickets_created_today': { label: 'Tickets Created', icon: '📝', color: '#8b5cf6' },
            'tickets_resolved_today': { label: 'Tickets Resolved', icon: '🎯', color: '#06b6d4' },
            'ticket_resolution_time': { label: 'Avg Resolution Time', icon: '⏰', color: '#ef4444' },
            'escalation_rate': { label: 'Escalation Rate', icon: '🚨', color: '#dc2626' },
            // New CSAT metrics
            'csat_avg_7d': { label: 'CSAT Avg (7d)', icon: '⭐', color: '#f59e0b' },
            'csat_count_7d': { label: 'CSAT Ratings (7d)', icon: '🗳️', color: '#3b82f6' },
            'csat_avg_today': { label: 'CSAT Avg (Today)', icon: '🌟', color: '#10b981' }
          };
          
          // Load user preferences
          async function loadPreferences() {
            try {
              const response = await fetch('/api/metrics/preferences', {
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json'
                }
              });
              userPreferences = await response.json();
              document.getElementById('refresh-interval').value = (userPreferences.refreshInterval ?? 30);
              // Ensure CSAT tiles appear for users without saved preferences
              try {
                if (!Array.isArray(userPreferences.visibleMetrics)) userPreferences.visibleMetrics = [];
                ['csat_avg_7d','csat_count_7d','csat_avg_today'].forEach(k => {
                  if (!userPreferences.visibleMetrics.includes(k)) userPreferences.visibleMetrics.push(k);
                });
              } catch {}
            } catch (error) {
              console.error('Failed to load preferences:', error);
              userPreferences = {
                visibleMetrics: ['messages_sent_today', 'messages_received_today', 'active_conversations', 'response_time', 'tickets_new', 'tickets_in_progress', 'tickets_resolved', 'csat_avg_7d', 'csat_count_7d', 'csat_avg_today'],
                refreshInterval: 30
              };
            }
          }
          
          // Load metrics data
          async function loadMetrics() {
            try {
              const response = await fetch('/api/metrics/dashboard?range=' + encodeURIComponent(currentRange), {
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json'
                }
              });
              metricsData = await response.json();
              if (metricsData?.range?.key) {
                currentRange = metricsData.range.key;
                try { window.localStorage.setItem('wa_metrics_range', currentRange); } catch (_) {}
              }
              const rangeSelect = document.getElementById('metrics-range');
              if (rangeSelect) {
                rangeSelect.value = currentRange;
              }
              // Load CSAT metrics and merge
              try {
                const csr = await fetch('/api/metrics/csat', { headers: { 'Accept': 'application/json' } });
                const cjson = await csr.json().catch(()=>({}));
                if (cjson && cjson.success) {
                  metricsData.csat = cjson;
                }
              } catch {}
              renderMetrics();
              renderChart();
            } catch (error) {
              console.error('Failed to load metrics:', error);
              showError('Failed to load metrics data');
            }
          }
          
          function getRangeContext() {
            return {
              label: metricsData?.range?.label || 'Today',
              compareLabel: metricsData?.range?.compareLabel || 'Previous period'
            };
          }
          
          // Render metrics cards
          function renderMetrics() {
            const grid = document.getElementById('metrics-grid');
            if (!grid) return;
            
            const rangeCtx = getRangeContext();
            const chartTitle = document.getElementById('chart-title');
            if (chartTitle) {
              chartTitle.textContent = 'Message Activity (' + rangeCtx.label + ')';
            }
            
            grid.innerHTML = '';
            
            const visibleMetrics = userPreferences.visibleMetrics || Object.keys(availableMetrics);
            
            visibleMetrics.forEach(metricKey => {
              const metric = availableMetrics[metricKey];
              if (!metric) return;
              
              const card = createMetricCard(metricKey, metric);
              grid.appendChild(card);
            });
          }
          
          // Create individual metric card
          function createMetricCard(key, config) {
            const card = document.createElement('div');
            card.className = 'metric-card';
            card.style.cssText = \`
              background: #f8f9fa;
              border: 1px solid #e5e7eb;
              border-radius: 8px;
              padding: 16px;
              text-align: center;
              position: relative;
            \`;

            // Helpers for nicer value formatting
            function humanizeSeconds(totalSeconds){
              const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
              const h = Math.floor(s / 3600);
              const m = Math.floor((s % 3600) / 60);
              const rem = s % 60;
              if (h > 0) return h + 'h ' + m + 'm';
              if (m > 0) return m + 'm ' + rem + 's';
              return rem + 's';
            }
            function formatNumber(n){
              const num = Number(n ?? 0);
              return Number.isFinite(num) ? num.toLocaleString() : '--';
            }
            function formatValueByKey(k, raw){
              switch(k){
                case 'response_time':
                  return Math.round(Number(raw || 0)) + ' s';
                case 'ai_success_rate':
                  return Math.round(Number(raw || 0)) + '%';
                case 'ticket_resolution_time':
                  return Math.round(Number(raw || 0)) + ' min';
                case 'system_health':
                  return humanizeSeconds(raw || 0);
                case 'csat_avg_7d':
                case 'csat_avg_today':
                  return (Number(raw || 0).toFixed(2)) + ' / 5';
                default:
                  return formatNumber(raw || 0);
              }
            }

            let rawValue = '--';
            let subtitle = '';
            let trend = undefined;
            const { label: rangeLabel, compareLabel } = getRangeContext();

            switch (key) {
              case 'messages_sent_today':
                rawValue = metricsData.messages?.sent_today || 0;
                subtitle = 'Sent (' + rangeLabel + ')';
                trend = metricsData.messages?.sent_trend;
                break;
              case 'messages_received_today':
                rawValue = metricsData.messages?.received_today || 0;
                subtitle = 'Received (' + rangeLabel + ')';
                trend = metricsData.messages?.received_trend;
                break;
              case 'active_conversations':
                rawValue = metricsData.conversations?.active || 0;
                subtitle = 'Active now';
                break;
              case 'response_time':
                rawValue = metricsData.performance?.avg_response_time || 0;
                subtitle = 'Avg response time (' + rangeLabel + ')';
                break;
              case 'ai_success_rate':
                rawValue = metricsData.performance?.ai_success_rate || 0;
                subtitle = 'Success rate (' + rangeLabel + ')';
                break;
              case 'template_usage':
                rawValue = metricsData.templates?.used_today || 0;
                subtitle = 'Templates (' + rangeLabel + ')';
                break;
              case 'system_health':
                rawValue = metricsData.system?.uptime || 0;
                subtitle = 'Uptime';
                break;
              case 'tickets_new':
                rawValue = metricsData.tickets?.status_counts?.new || 0;
                subtitle = 'New tickets';
                break;
              case 'tickets_in_progress':
                rawValue = metricsData.tickets?.status_counts?.in_progress || 0;
                subtitle = 'In progress';
                break;
              case 'tickets_resolved':
                rawValue = metricsData.tickets?.status_counts?.resolved || 0;
                subtitle = 'Resolved';
                break;
              case 'tickets_created_today':
                rawValue = metricsData.tickets?.created_today || 0;
                subtitle = 'Created (' + rangeLabel + ')';
                trend = metricsData.tickets?.created_trend;
                break;
              case 'tickets_resolved_today':
                rawValue = metricsData.tickets?.resolved_today || 0;
                subtitle = 'Resolved (' + rangeLabel + ')';
                trend = metricsData.tickets?.resolved_trend;
                break;
              case 'ticket_resolution_time':
                rawValue = metricsData.tickets?.avg_resolution_time || 0;
                subtitle = 'Avg resolution time';
                break;
              case 'escalation_rate':
                rawValue = metricsData.tickets?.escalations_today || 0;
                subtitle = 'Escalations today';
                break;
                case 'csat_avg_7d':
                  rawValue = metricsData.csat?.avg_7d || 0;
                  subtitle = 'Average rating (last 7 days)';
                  break;
                case 'csat_count_7d':
                  rawValue = metricsData.csat?.count_7d || 0;
                  subtitle = 'Ratings (last 7 days)';
                  break;
                case 'csat_avg_today':
                  rawValue = metricsData.csat?.avg_today || 0;
                  subtitle = 'Average rating (today)';
                  break;
            }
            const value = formatValueByKey(key, rawValue);

            const hasTrend = trend !== undefined && trend !== null;
            const trendHtml = hasTrend ? \`
              <div style="font-size: 12px; color: \${trend >= 0 ? '#10b981' : '#ef4444'}; margin-top: 4px;">
                \${trend >= 0 ? '↗' : '↘'} \${Math.abs(trend)}%\${compareLabel ? \` vs \${compareLabel}\` : ''}
              </div>
            \` : '';

            card.innerHTML = \`
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <div style="font-size: 14px; color: #374151; font-weight: 600; text-align:left;">\${config.label}</div>
                <div style="font-size: 20px;">\${config.icon}</div>
              </div>
              <div style="font-size: 24px; font-weight: bold; color: #111827; margin-bottom: 4px;">\${value}</div>
              <div style="font-size: 13px; color: #6b7280;">\${subtitle}</div>
              \${trendHtml}
            \`;

            return card;
          }
          
          // Render range-aware chart
          function renderChart() {
            const canvas = document.getElementById('chart-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const chartInfo = metricsData.charts;
            const width = canvas.width = canvas.offsetWidth;
            const height = canvas.height = canvas.offsetHeight;
            ctx.clearRect(0, 0, width, height);
            
            if (!chartInfo || !Array.isArray(chartInfo.data) || chartInfo.data.length === 0) {
              ctx.fillStyle = '#9ca3af';
              ctx.font = '14px Inter, sans-serif';
              ctx.fillText('No message activity for selected range', 12, height / 2);
              return;
            }
            
            const data = chartInfo.data;
            const maxValue = Math.max(1, ...data.map(d => Math.max(d.received || 0, d.sent || 0)));
            const stepX = data.length > 1 ? width / (data.length - 1) : width;
            const padding = 24;
            const usableHeight = height - padding * 2;
            
            // Axis baseline
            ctx.strokeStyle = '#e5e7eb';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height - padding);
            ctx.lineTo(width, height - padding);
            ctx.stroke();
            
            // Received (blue)
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            data.forEach((point, idx) => {
              const x = idx * stepX;
              const y = height - padding - ((point.received || 0) / maxValue) * usableHeight;
              if (idx === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
            
            // Sent (green)
            ctx.strokeStyle = '#10b981';
            ctx.beginPath();
            data.forEach((point, idx) => {
              const x = idx * stepX;
              const y = height - padding - ((point.sent || 0) / maxValue) * usableHeight;
              if (idx === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
            
            // Labels
            ctx.fillStyle = '#9ca3af';
            ctx.font = '10px Inter, sans-serif';
            const labelStep = data.length <= 10 ? 1 : Math.ceil(data.length / 5);
            data.forEach((point, idx) => {
              if (idx % labelStep !== 0 && idx !== data.length - 1) return;
              const x = idx * stepX;
              ctx.fillText(point.label || '', x - 12, height - 6);
            });
          }
          
          // Setup customization modal
          function setupCustomization() {
            const modal = document.getElementById('customize-modal');
            const customizeBtn = document.getElementById('customize-metrics');
            const cancelBtn = document.getElementById('cancel-customize');
            const cancelBtnFooter = document.getElementById('cancel-customize-footer');
            const saveBtn = document.getElementById('save-customize');
            
            customizeBtn?.addEventListener('click', () => {
              renderCustomizationModal();
              modal.style.display = 'block';
              function onKey(e){ if(e.key === 'Escape'){ modal.style.display='none'; document.removeEventListener('keydown', onKey);} }
              document.addEventListener('keydown', onKey);
            });
            
            cancelBtn?.addEventListener('click', () => {
              modal.style.display = 'none';
            });
            cancelBtnFooter?.addEventListener('click', () => {
              modal.style.display = 'none';
            });
            // Close when clicking backdrop
            modal?.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
            
            saveBtn?.addEventListener('click', async () => {
              await savePreferences();
              modal.style.display = 'none';
              renderMetrics();
            });
          }
          
          // Render customization modal
          function renderCustomizationModal() {
            const container = document.getElementById('metrics-checkboxes');
            if (!container) return;
            
            container.innerHTML = '';
            
            Object.entries(availableMetrics).forEach(([key, config]) => {
              const option = document.createElement('label');
              option.style.cssText = 'display:flex; align-items:center; gap:12px; border:1px solid #e5e7eb; border-radius:12px; padding:10px 12px; background:#ffffff; cursor:pointer; transition: box-shadow .2s, border-color .2s;';
              option.addEventListener('mouseenter', ()=> option.style.boxShadow='0 6px 18px rgba(0,0,0,0.06)');
              option.addEventListener('mouseleave', ()=> option.style.boxShadow='none');
              const input = document.createElement('input');
              input.type = 'checkbox';
              input.id = \`metric-\${key}\`;
              input.checked = userPreferences.visibleMetrics?.includes(key) || false;
              const icon = document.createElement('div');
              icon.textContent = config.icon;
              icon.style.cssText = 'font-size:18px; width:22px; text-align:center;';
              const text = document.createElement('div');
              text.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
              const title = document.createElement('div');
              title.textContent = config.label;
              title.style.cssText = 'font-size:14px; font-weight:600; color:#111827;';
              const sub = document.createElement('div');
              sub.textContent = '';
              sub.style.cssText = 'font-size:12px; color:#6b7280;';
              text.appendChild(title);
              text.appendChild(sub);
              const colorDot = document.createElement('span');
              colorDot.style.cssText = 'margin-left:auto; width:10px; height:10px; border-radius:50%; border:1px solid #e5e7eb;';
              try { colorDot.style.background = config.color || '#e5e7eb'; } catch {}
              option.appendChild(input);
              option.appendChild(icon);
              option.appendChild(text);
              option.appendChild(colorDot);
              container.appendChild(option);
            });
          }
          
          // Save preferences
          async function savePreferences() {
            const checkboxes = document.querySelectorAll('#metrics-checkboxes input[type="checkbox"]');
            const visibleMetrics = Array.from(checkboxes)
              .filter(cb => cb.checked)
              .map(cb => cb.id.replace('metric-', ''));
            
            userPreferences.visibleMetrics = visibleMetrics;
            userPreferences.refreshInterval = parseInt(document.getElementById('refresh-interval').value);
            
            try {
              await fetch('/api/metrics/preferences', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                credentials: 'same-origin',
                body: JSON.stringify(userPreferences)
              });
            } catch (error) {
              console.error('Failed to save preferences:', error);
            }
          }
          
          function setupRangeSelector() {
            const rangeSelect = document.getElementById('metrics-range');
            if (!rangeSelect) return;
            rangeSelect.value = currentRange;
            rangeSelect.addEventListener('change', () => {
              currentRange = rangeSelect.value;
              try { window.localStorage.setItem('wa_metrics_range', currentRange); } catch (_) {}
              loadMetrics();
            });
          }
          
          // Setup auto-refresh
          function setupAutoRefresh() {
            const select = document.getElementById('refresh-interval');
            select?.addEventListener('change', () => {
              if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
              }
              
              const interval = parseInt(select.value);
              if (interval > 0) {
                refreshInterval = setInterval(loadMetrics, interval * 1000);
              }
            });
            
            // Start with default interval
            const defaultInterval = parseInt(select?.value || '30');
            if (defaultInterval > 0) {
              refreshInterval = setInterval(loadMetrics, defaultInterval * 1000);
            }
          }
          
          // Export functionality
          function setupExport() {
            const exportBtn = document.getElementById('export-metrics');
            exportBtn?.addEventListener('click', async () => {
              try {
                const response = await fetch('/api/metrics/export?format=json&days=7', {
                  headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                  }
                });
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`metrics-export-\${new Date().toISOString().split('T')[0]}.json\`;
                a.click();
                URL.revokeObjectURL(url);
              } catch (error) {
                console.error('Export failed:', error);
                showError('Export failed');
              }
            });
          }
          
          // Show error message
          function showError(message) {
            // You could integrate with your existing toast system
            console.error(message);
          }
          
          // Setup WebSocket for real-time updates
          function setupWebSocket() {
            const userId = '${userId}';
            function attach() {
              const rm = window.realtimeManager;
              if (rm && rm.socket) {
                try { rm.socket.off && rm.socket.off('metrics_update'); } catch {}
                rm.socket.on('metrics_update', (data) => {
                  console.log('📊 Received real-time metrics update:', data);
                  if (data && String(data.userId) === String(userId)) {
                    if (data.data?.range?.key && data.data.range.key !== currentRange) {
                      return;
                    }
                    metricsData = data.data;
                    renderMetrics();
                    renderChart();
                  }
                });
                return;
              }
              setTimeout(attach, 500);
            }
            attach();
          }
          
          // Initialize metrics dashboard
          async function initMetricsDashboard() {
            await loadPreferences();
            await loadMetrics();
            setupRangeSelector();
            setupCustomization();
            setupAutoRefresh();
            setupExport();
            setupWebSocket();
          }
          
          // Start metrics dashboard when page loads
          initMetricsDashboard();
        </script>
        <div class="container">
      ${renderTopbar('Dashboard', email)}
          <div class="layout">
      ${renderSidebar('dashboard', { showBookings: isUpgraded, isUpgraded })}
            <main class="main">
                ${metricsHtml}
                ${apptHtml}
                ${intakeHtml}
                ${paymentsHtml}
              <div id="mini-onboard" class="card" style="position:fixed; right:24px; bottom:92px; width:400px; display:none; padding:0; overflow:hidden; z-index:1000;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #eee;">
                  <div class="small">KB Assistant</div>
                  <button onclick="toggleMiniOnboard(false)" class="btn-ghost">×</button>
                </div>
                <iframe src="/assistant?token=${encodeURIComponent(signSessionToken(userId))}" style="width:100%; height:660px; border:0; background:white;" sandbox="allow-forms allow-scripts allow-same-origin"></iframe>
              </div>
            </main>
          </div>
        </div>
        <button id="kb-toggle" onclick="toggleMiniOnboard()" style="position:fixed; right:24px; left:auto; bottom:24px; width:56px; height:56px; border-radius:50%; background:#4f46e5; color:#fff; border:none; box-shadow:0 6px 18px rgba(0,0,0,0.15); display:flex; align-items:center; justify-content:center; font-size:28px; line-height:0; cursor:pointer; z-index:1001;" aria-label="Chat" title="Chat">+
        </button>
        ${showSetupGuide ? setupGuideHtml : ''}
      </body></html>
    `);
  });

  // Save intake questions
  app.post("/dashboard/booking-questions", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    let raw = (req.body?.booking_questions_json || '').toString();
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not array');
      const clean = parsed.map(v => String(v||'').trim()).filter(Boolean).slice(0, 10);
      upsertSettingsForUser(userId, { booking_questions_json: JSON.stringify(clean) });
    } catch {
      // keep raw if invalid? prefer ignore
    }
    return res.redirect('/dashboard');
  });

  // CSAT metrics API (per-user)
  app.get("/api/metrics/csat", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const dbNative = (await import("../db-mongodb.mjs")).getDB();
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOf7d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

      const qBase = { user_id: String(userId) };
      const todayDocs = await dbNative
        .collection('csat_ratings')
        .find({ ...qBase, createdAt: { $gte: startOfToday } }, { projection: { score: 1 } })
        .toArray();
      const last7Docs = await dbNative
        .collection('csat_ratings')
        .find({ ...qBase, createdAt: { $gte: startOf7d } }, { projection: { score: 1 } })
        .toArray();

      function stats(arr) {
        const scores = (arr || []).map(r => Number(r.score || 0)).filter(n => Number.isFinite(n) && n > 0);
        const count = scores.length;
        const sum = scores.reduce((a, b) => a + b, 0);
        const avg = count ? sum / count : 0;
        return { count, avg };
      }
      const t = stats(todayDocs);
      const w = stats(last7Docs);

      // Distribution for the last 7 days
      const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of last7Docs) {
        const s = Number(r.score || 0);
        if (s >= 1 && s <= 5) dist[s]++;
      }

      res.json({
        success: true,
        avg_today: Number(t.avg.toFixed(2)),
        count_today: t.count,
        avg_7d: Number(w.avg.toFixed(2)),
        count_7d: w.count,
        distribution_7d: dist
      });
    } catch (e) {
      console.error('CSAT metrics error:', e?.message || e);
      res.status(500).json({ success: false, error: 'csat_metrics_failed' });
    }
  });
}

