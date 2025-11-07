import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { listEvents as gcalListEvents } from "../services/google.mjs";
import { renderSidebar, renderTopbar, escapeHtml, getProfessionalHead } from "../utils.mjs";

export default function registerBookingsTab(app) {
  app.get("/bookings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const s = await getSettingsForUser(userId);
    const db = getDB();
    // Calendar connection status
    let cal = null;
    try {
      cal = await db.collection('calendars').findOne({ user_id: String(userId) });
    } catch {}

    // Pull appointments for calendar (past 30d to next 90d)
    const nowSec = Math.floor(Date.now()/1000);
    const fromSec = nowSec - 30*86400;
    const toSec = nowSec + 90*86400;
    let appts = [];
    try {
      appts = await db.collection('appointments')
        .aggregate([
          { $match: { user_id: String(userId), start_ts: { $gte: fromSec, $lte: toSec } } },
          { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
          { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
          { $addFields: { _id_str: { $toString: '$_id' } } },
          { $project: { _id_str: 1, id: 1, start_ts: 1, end_ts: 1, contact_phone: 1, status: 1, notes: 1, staff_name: 1 } },
          { $sort: { start_ts: 1 } }
        ]).toArray();
    } catch {}
    // Overlay Google Calendar events if connected
    try {
      if (cal) {
        const timeMin = new Date(fromSec*1000).toISOString();
        const timeMax = new Date(toSec*1000).toISOString();
        const gitems = await gcalListEvents(cal, timeMin, timeMax);
        const gcalIds = new Set((appts||[]).map(a => String(a.gcal_event_id||'')).filter(Boolean));
        const mapped = [];
        for (const ev of (gitems||[])) {
          // Skip cancelled or duplicates of our own created bookings
          if (String(ev.status||'confirmed') === 'cancelled') continue;
          if (ev.id && gcalIds.has(String(ev.id))) continue;
          // Determine start/end (dateTime or all-day date)
          const sISO = ev.start?.dateTime || (ev.start?.date ? (ev.start.date + 'T00:00:00.000Z') : null);
          const eISO = ev.end?.dateTime || (ev.end?.date ? (ev.end.date + 'T00:00:00.000Z') : null);
          if (!sISO || !eISO) continue;
          const s = Math.floor(new Date(sISO).getTime()/1000);
          const e = Math.floor(new Date(eISO).getTime()/1000);
          mapped.push({
            id: `gcal_${ev.id||Math.random().toString(36).slice(2)}`,
            start_ts: s,
            end_ts: e,
            status: 'confirmed',
            notes: null,
            contact_phone: null,
            staff_name: ev.organizer?.displayName || '',
            summary: ev.summary || 'Google event',
            source: 'google',
            html_link: ev.htmlLink || null
          });
        }
        appts = (appts || []).concat(mapped);
      }
    } catch {}
    const apptJson = JSON.stringify(appts || []);

    // Settings values with defaults
    const bookingMaxPerDay = Number(s?.booking_max_per_day || 0);
    const bookingDaysAhead = Number(s?.booking_days_ahead || 60);
    const displayInterval = Number(s?.booking_display_interval_minutes || 30);
    const capacityWindow = Number(s?.booking_capacity_window_minutes || 60);
    const capacityLimit = Number(s?.booking_capacity_limit || 0);
    const closedDatesJson = String(s?.closed_dates_json || '[]');
    const holidayRulesJson = String(s?.holidays_rules_json || '[]');
    const bookingQuestionsJson = String(s?.booking_questions_json || '[]');
    const servicesJson = String(s?.services_json || '[]');
    const waitlistEnabled = !!s?.waitlist_enabled;

    // Security headers and no-cache
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead('Bookings')}<body>
        <style>
          /* Disable global spinner pseudo-element on this page */
          .loading::after { display: none !important; }
        </style>
        <div class="container">
          ${renderTopbar('Bookings', email)}
          <div class="layout">
            ${renderSidebar('bookings')}
            <main class="main">
              <div class="main-content">
                <div class="card" style="margin-bottom:12px;">
                  <h3 style="margin:0 0 8px 0;">Booking Settings</h3>
                  <form method="post" action="/bookings/settings" style="display:grid; gap:16px;" onsubmit="return true;">
                    <div class="settings-row" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid #eee;">
                      <div>
                        <div class="settings-label" style="margin-bottom:4px;">Calendar Sync (Google)</div>
                        <div class="settings-help">
                          ${cal ? `Connected as ${escapeHtml(cal.account_email || 'Google account')}` : 'Not connected'}
                        </div>
                      </div>
                      <div>
                        ${cal
                          ? `<form method="post" action="/google/disconnect" style="display:inline;"><button type="submit" class="btn-ghost">Disconnect</button></form>`
                          : `<a class="btn" href="/google/connect">Connect Google Calendar</a>`}
                      </div>
                    </div>
                    <div class="settings-grid">
                      <label class="settings-label">Max bookings per day (per staff)
                        <input type="number" min="0" step="1" class="settings-field" name="booking_max_per_day" value="${bookingMaxPerDay}" />
                      </label>
                      <label class="settings-label">Accept bookings up to (days ahead)
                        <input type="number" min="1" step="1" class="settings-field" name="booking_days_ahead" value="${bookingDaysAhead}" />
                      </label>
                      <label class="settings-label">Display interval for available times
                        <select name="booking_display_interval_minutes" class="settings-field">
                          ${[15,20,30,40,60,90,120].map(v=>`<option value="${v}" ${displayInterval===v?'selected':''}>${v===60?'1 hour':(v===120?'2 hours':v+' min')}</option>`).join('')}
                        </select>
                      </label>
                      <label class="settings-label">Capacity window (how many per window)
                        <select name="booking_capacity_window_minutes" class="settings-field">
                          ${[30,60,90,120].map(v=>`<option value="${v}" ${capacityWindow===v?'selected':''}>${v===60?'per hour':(v+' min window')}</option>`).join('')}
                        </select>
                      </label>
                      <label class="settings-label">Capacity limit per window
                        <input type="number" min="0" step="1" class="settings-field" name="booking_capacity_limit" value="${capacityLimit}" />
                      </label>
                    </div>
                    <div class="settings-row" style="display:flex; gap:16px; align-items:center;">
                      <label class="settings-label" style="display:flex; gap:8px; align-items:center;">
                        <input type="checkbox" name="waitlist_enabled" value="1" ${waitlistEnabled ? 'checked' : ''} />
                        Enable waitlist notifications (offer earlier slots on cancellations)
                      </label>
                    </div>
                    <!-- Closed dates and Holiday rules moved to Settings page -->
                    <div>
                      <label class="settings-label">Service types (name, minutes, optional price)
                        <div style="display:grid; gap:8px;">
                          <div id="servicesList" class="list" style="display:flex; flex-direction:column; gap:6px;"></div>
                          <div class="input-inline" style="display:flex; gap:8px; flex-wrap:wrap;">
                            <input type="text" id="serviceName" class="settings-field" placeholder="Name (e.g., Haircut — Basic)" />
                            <input type="number" id="serviceMinutes" class="settings-field" placeholder="Minutes" min="5" step="5" style="max-width:140px;" />
                            <input type="text" id="servicePrice" class="settings-field" placeholder="Price (optional)" />
                            <button type="button" class="btn" id="addServiceBtn">Add</button>
                          </div>
                          <textarea name="services_json" id="services_json" rows="2" style="display:none;">${escapeHtml(servicesJson)}</textarea>
                          <div class="settings-help" style="margin-top:4px;">These service tiers will be offered during booking.</div>
                        </div>
                      </label>
                    </div>
                    <div>
                      <label class="settings-label">Booking questions
                        <div style="display:grid; gap:8px;">
                          <div id="bookingQuestionsList" class="list" style="display:flex; flex-direction:column; gap:6px;"></div>
                          <div class="input-inline">
                            <input type="text" id="questionInput" class="settings-field" placeholder="Add a question (e.g., What's your email?)" />
                            <button type="button" class="btn" id="addQuestionBtn">Add</button>
                          </div>
                          <textarea name="booking_questions_json" id="booking_questions_json" rows="2" style="display:none;">${escapeHtml(bookingQuestionsJson)}</textarea>
                          <div class="settings-help" style="margin-top:4px;">Name is mandatory and will be asked first even if omitted.</div>
                        </div>
                      </label>
                    </div>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                      <button type="submit" class="btn">Save Settings</button>
                    </div>
                  </form>
                </div>

                <div class="card">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <h3 style="margin:0 0 8px 0;">Calendar</h3>
                    <div class="small" style="color:#6b7280;">Past 30 days to next 90 days</div>
                  </div>
                  <div id="calendarRoot"></div>
                  <script id="appointments-json" type="application/json">${apptJson.replace(/</g, '\u003c')}</script>
                  <script src="/calendar.js"></script>
                  <script>
                    (function(){
                      function parseJson(v, def){ try { return JSON.parse(String(v||'').trim()||'[]'); } catch(_) { return def; } }
                      function setHidden(id, arr){ document.getElementById(id).value = JSON.stringify(arr||[]); }
                      function chip(text){ var b=document.createElement('button'); b.type='button'; b.className='chip'; b.textContent=text; return b; }

                      // Closed dates and Holiday rules moved to Settings page

                      // Booking questions UI
                      var qArr = parseJson(document.getElementById('booking_questions_json').value, []);
                      var qList = document.getElementById('bookingQuestionsList');
                      function renderQs(){ qList.innerHTML=''; (qArr||[]).forEach(function(q,idx){ var row=document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.alignItems='center'; var span=document.createElement('div'); span.textContent=q; span.style.flex='1'; span.className='kb-item'; var del=document.createElement('button'); del.type='button'; del.className='btn-ghost'; del.textContent='Remove'; del.onclick=function(){ qArr.splice(idx,1); renderQs(); }; row.appendChild(span); row.appendChild(del); qList.appendChild(row); }); setHidden('booking_questions_json', qArr); }
                      document.getElementById('addQuestionBtn').onclick=function(){ var v=document.getElementById('questionInput').value.trim(); if(!v) return; qArr.push(v); document.getElementById('questionInput').value=''; renderQs(); };
                      renderQs();
                      
                      // Services UI
                      var sArr = parseJson(document.getElementById('services_json').value, []);
                      var sList = document.getElementById('servicesList');
                      function renderSvcs(){
                        sList.innerHTML='';
                        (sArr||[]).forEach(function(svc, idx){
                          var row=document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.alignItems='center';
                          var span=document.createElement('div'); span.textContent=(svc.name||'') + (svc.minutes?(' · '+svc.minutes+' min'):'') + (svc.price?(' · '+svc.price):''); span.style.flex='1'; span.className='kb-item';
                          var del=document.createElement('button'); del.type='button'; del.className='btn-ghost'; del.textContent='Remove'; del.onclick=function(){ sArr.splice(idx,1); renderSvcs(); };
                          row.appendChild(span); row.appendChild(del); sList.appendChild(row);
                        });
                        setHidden('services_json', sArr);
                      }
                      document.getElementById('addServiceBtn').onclick=function(){
                        var n=document.getElementById('serviceName').value.trim();
                        var m=parseInt(document.getElementById('serviceMinutes').value,10);
                        var p=document.getElementById('servicePrice').value.trim();
                        if(!n || !m || m<=0) return;
                        sArr.push({ name:n, minutes:m, price:p||null });
                        document.getElementById('serviceName').value='';
                        document.getElementById('serviceMinutes').value='';
                        document.getElementById('servicePrice').value='';
                        renderSvcs();
                      };
                      renderSvcs();
                    })();
                  </script>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.post("/bookings/settings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const maxPerDay = Number(req.body?.booking_max_per_day || 0);
    const daysAhead = Number(req.body?.booking_days_ahead || 60);
    const displayInterval = Number(req.body?.booking_display_interval_minutes || 30);
    const capacityWindow = Number(req.body?.booking_capacity_window_minutes || 60);
    const capacityLimit = Number(req.body?.booking_capacity_limit || 0);
    const qjsonRaw = (req.body?.booking_questions_json || '').toString();
    const servicesRaw = (req.body?.services_json || '').toString();
    const waitlistEnabled = String(req.body?.waitlist_enabled || '') === '1';
    // Normalize booking questions: ensure array of strings and prepend Name if absent
    let qjsonSave = '';
    try {
      const arr = JSON.parse(qjsonRaw || '[]');
      let qs = Array.isArray(arr) ? arr.map(x => String(x||'').trim()).filter(x => !!x) : [];
      const hasName = qs.some(q => /name/i.test(q));
      if (!hasName) qs = ["What's your name?", ...qs];
      // Limit to 10 questions to keep flow reasonable
      qjsonSave = JSON.stringify(qs.slice(0, 10));
    } catch { qjsonSave = JSON.stringify(["What's your name?","What's the reason for the booking?"]); }
    // Normalize services: ensure array of {name, minutes, price?}
    let servicesSave = '[]';
    try {
      const arr = JSON.parse(servicesRaw || '[]');
      const svcs = Array.isArray(arr)
        ? arr.map(x => ({ name: String(x?.name||'').trim(), minutes: Number(x?.minutes||0), price: x?.price ? String(x.price).trim() : null }))
            .filter(x => x.name && x.minutes > 0)
        : [];
      servicesSave = JSON.stringify(svcs.slice(0, 20));
    } catch { servicesSave = '[]'; }
    try {
      await upsertSettingsForUser(userId, {
        booking_max_per_day: isNaN(maxPerDay) ? 0 : maxPerDay,
        booking_days_ahead: isNaN(daysAhead) ? 60 : daysAhead,
        booking_display_interval_minutes: isNaN(displayInterval) ? 30 : displayInterval,
        booking_capacity_window_minutes: isNaN(capacityWindow) ? 60 : capacityWindow,
        booking_capacity_limit: isNaN(capacityLimit) ? 0 : capacityLimit,
        booking_questions_json: qjsonSave,
        services_json: servicesSave,
        waitlist_enabled: !!waitlistEnabled
      });
    } catch {}
    const wantsJson = String(req.headers['accept']||'').includes('application/json')
      || String(req.headers['x-requested-with']||'') === 'XMLHttpRequest';
    if (wantsJson) return res.json({ ok: true });
    return res.redirect('/bookings');
  });
}


