import { ensureAuthed, getSignedInEmail, getCurrentUserId, signSessionToken } from "../middleware/auth.mjs";
import { renderSidebar, escapeHtml, renderTopbar, getProfessionalHead } from "../utils.mjs";
import { db } from "../db-mongodb.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { getCurrentUsage, getUserPlan } from "../services/usage.mjs";

export default function registerDashboardRoutes(app) {
  app.get("/dashboard", ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);
    const s = getSettingsForUser(userId);
    
    // Get usage and plan info
    const usage = getCurrentUsage(userId);
    const plan = getUserPlan(userId);
    const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;    

    // Create metrics dashboard HTML
    const metricsHtml = `
      <div class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <h3 style="margin: 0;">Live Metrics</h3>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="customize-metrics" class="btn-ghost" style="font-size: 14px;">Customize</button>
            <button id="export-metrics" class="btn-ghost" style="font-size: 14px;">Export</button>
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
          <h4 style="margin: 0 0 12px 0; color: #374151;">Message Activity (Today)</h4>
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
          
          // Available metrics configuration
          const availableMetrics = {
            'messages_sent_today': { label: 'Messages Sent Today', icon: '📤', color: '#10b981' },
            'messages_received_today': { label: 'Messages Received Today', icon: '📥', color: '#3b82f6' },
            'messages_trend': { label: 'Message Trends', icon: '📈', color: '#8b5cf6' },
            'active_conversations': { label: 'Active Conversations', icon: '💬', color: '#f59e0b' },
            'response_time': { label: 'Avg Response Time', icon: '⏱️', color: '#ef4444' },
            'ai_success_rate': { label: 'AI Success Rate', icon: '🤖', color: '#06b6d4' },
            'template_usage': { label: 'Template Usage', icon: '📋', color: '#84cc16' },
            'system_health': { label: 'System Health', icon: '💚', color: '#22c55e' },
            'tickets_new': { label: 'New Tickets', icon: '🎫', color: '#3b82f6' },
            'tickets_in_progress': { label: 'Tickets In Progress', icon: '🔄', color: '#f59e0b' },
            'tickets_resolved': { label: 'Tickets Resolved', icon: '✅', color: '#10b981' },
            'tickets_created_today': { label: 'Tickets Created Today', icon: '📝', color: '#8b5cf6' },
            'tickets_resolved_today': { label: 'Tickets Resolved Today', icon: '🎯', color: '#06b6d4' },
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
              const response = await fetch('/api/metrics/dashboard', {
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json'
                }
              });
              metricsData = await response.json();
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
          
          // Render metrics cards
          function renderMetrics() {
            const grid = document.getElementById('metrics-grid');
            if (!grid) return;
            
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
            let trend = '';

            switch (key) {
              case 'messages_sent_today':
                rawValue = metricsData.messages?.sent_today || 0;
                subtitle = 'Sent today';
                trend = metricsData.messages?.sent_trend;
                break;
              case 'messages_received_today':
                rawValue = metricsData.messages?.received_today || 0;
                subtitle = 'Received today';
                trend = metricsData.messages?.received_trend;
                break;
              case 'active_conversations':
                rawValue = metricsData.conversations?.active || 0;
                subtitle = 'Active now';
                break;
              case 'response_time':
                rawValue = metricsData.performance?.avg_response_time || 0;
                subtitle = 'Avg response time';
                break;
              case 'ai_success_rate':
                rawValue = metricsData.performance?.ai_success_rate || 0;
                subtitle = 'Success rate';
                break;
              case 'template_usage':
                rawValue = metricsData.templates?.used_today || 0;
                subtitle = 'Templates used';
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
                subtitle = 'Created today';
                trend = metricsData.tickets?.created_trend;
                break;
              case 'tickets_resolved_today':
                rawValue = metricsData.tickets?.resolved_today || 0;
                subtitle = 'Resolved today';
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

            const trendHtml = trend !== undefined ? \`
              <div style="font-size: 12px; color: \${trend >= 0 ? '#10b981' : '#ef4444'}; margin-top: 4px;">
                \${trend >= 0 ? '↗' : '↘'} \${Math.abs(trend)}%
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
          
          // Render hourly chart
          function renderChart() {
            const canvas = document.getElementById('chart-canvas');
            if (!canvas || !metricsData.charts?.hourly_messages) return;
            
            const ctx = canvas.getContext('2d');
            const data = metricsData.charts.hourly_messages;
            
            // Simple chart rendering (you could use Chart.js for better charts)
            const width = canvas.width = canvas.offsetWidth;
            const height = canvas.height = canvas.offsetHeight;
            
            ctx.clearRect(0, 0, width, height);
            
            const maxValue = Math.max(...data.map(d => Math.max(d.received, d.sent)));
            const stepX = width / 24;
            const stepY = height / maxValue;
            
            // Draw received messages (blue)
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            data.forEach((d, i) => {
              const x = i * stepX;
              const y = height - (d.received * stepY);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
            
            // Draw sent messages (green)
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            ctx.beginPath();
            data.forEach((d, i) => {
              const x = i * stepX;
              const y = height - (d.sent * stepY);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
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
            ${renderSidebar('dashboard')}
            <main class="main">
                ${metricsHtml}
                ${apptHtml}
                ${intakeHtml}
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

