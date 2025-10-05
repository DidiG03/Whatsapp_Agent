import { ensureAuthed, getSignedInEmail, getCurrentUserId, signSessionToken } from "../middleware/auth.mjs";
import { renderSidebar, escapeHtml, renderTopbar } from "../utils.mjs";
import { db } from "../db.mjs";
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
    const usagePercentage = plan.monthly_limit > 0 ? Math.round((totalMessages / plan.monthly_limit) * 100) : 0;
    
    // Create usage summary HTML
    const usageHtml = `
      <div class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <h3 style="margin: 0;">Monthly Usage</h3>
          <a href="/plan" class="btn-ghost" style="font-size: 14px;">View Details</a>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 16px;">
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #111827;">${totalMessages}</div>
            <div style="font-size: 14px; color: #6b7280;">of ${plan.monthly_limit}</div>
            <div style="font-size: 12px; color: #6b7280;">messages</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #111827;">${usagePercentage}%</div>
            <div style="font-size: 14px; color: #6b7280;">used</div>
            <div class="usage-progress" style="width: 100%; height: 6px; background: #e5e7eb; border-radius: 3px; margin-top: 4px; overflow: hidden;">
              <div style="height: 100%; width: ${Math.min(usagePercentage, 100)}%; background-color: ${usagePercentage > 90 ? '#ef4444' : usagePercentage > 75 ? '#f59e0b' : '#10b981'}; transition: width 0.3s ease;"></div>
            </div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #111827;">${plan.plan_name}</div>
            <div style="font-size: 14px; color: #6b7280;">plan</div>
            <div style="font-size: 12px; color: #6b7280;">$${plan.plan_name === 'free' ? '0' : '29'}/month</div>
          </div>
        </div>
        ${usagePercentage > 90 ? `
          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 8px; margin-top: 12px; text-align: center;">
            <span style="color: #dc2626; font-size: 14px;">⚠️ ${usagePercentage}% usage reached</span>
          </div>
        ` : ''}
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>Code Orbit - Dashboard</title><link rel="stylesheet" href="/styles.css"></head><body>
        <script src="/notifications.js"></script>
        <script>
          async function checkAuthThenSubmit(form){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
          function toggleMiniOnboard(force){
            const box = document.getElementById('mini-onboard');
            if(!box) return;
            const show = (typeof force === 'boolean') ? force : box.style.display === 'none';
            box.style.display = show ? 'block' : 'none';
          }
        </script>
        <div class="container">
          ${renderTopbar('Dashboard', email)}
          <div class="layout">
            ${renderSidebar('dashboard')}
            <main class="main" style="height: calc(100vh - 119px); overflow:auto;">
              ${usageHtml}
              ${apptHtml}
              ${intakeHtml}
              <div id="mini-onboard" class="card" style="position:fixed; right:24px; bottom:92px; width:400px; display:none; padding:0; overflow:hidden;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #eee;">
                  <div class="small">KB Assistant</div>
                  <button onclick="toggleMiniOnboard(false)" class="btn-ghost">×</button>
                </div>
                <iframe src="/assistant?token=${encodeURIComponent(signSessionToken(userId))}" style="width:100%; height:660px; border:0; background:white;" sandbox="allow-forms allow-scripts allow-same-origin"></iframe>
              </div>
              <button onclick="toggleMiniOnboard()" style="position:fixed; right:24px; bottom:24px; width:56px; height:56px; border-radius:50%; background:#4f46e5; color:#fff; border:none; box-shadow:0 6px 18px rgba(0,0,0,0.15); display:flex; align-items:center; justify-content:center; font-size:28px; line-height:0; cursor:pointer;" aria-label="Chat" title="Chat">+
              </button>
            </main>
          </div>
        </div>
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
}

