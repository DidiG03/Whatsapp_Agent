import { ensureAuthed, getSignedInEmail, getCurrentUserId, signSessionToken } from "../middleware/auth.mjs";
import { renderSidebar, escapeHtml, renderTopbar } from "../utils.mjs";
import { db } from "../db.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";

export default function registerDashboardRoutes(app) {
  app.get("/dashboard", ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);
    const s = getSettingsForUser(userId);
    let apptHtml = '';
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
        <div class="card" style="margin-top:12px;">
          <h3 style="margin:0 0 8px 0;">Upcoming Appointments</h3>
          ${items ? `<ul class="list">${items}</ul>` : '<div class="small">No upcoming appointments</div>'}
        </div>
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
            <main class="main">
              ${apptHtml}
              ${intakeHtml}
              <div id="mini-onboard" class="card" style="position:fixed; right:24px; bottom:92px; width:360px; display:none; padding:0; overflow:hidden;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #eee;">
                  <div class="small">KB Assistant</div>
                  <button onclick="toggleMiniOnboard(false)" class="btn-ghost">×</button>
                </div>
                <iframe src="/assistant?token=${encodeURIComponent(signSessionToken(userId))}" style="width:100%; height:360px; border:0; background:#fff;" sandbox="allow-forms allow-scripts allow-same-origin"></iframe>
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

