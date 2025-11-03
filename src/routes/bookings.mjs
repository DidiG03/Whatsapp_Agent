import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { renderSidebar, renderTopbar, escapeHtml, getProfessionalHead } from "../utils.mjs";

export default function registerBookingsTab(app) {
  app.get("/bookings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const s = await getSettingsForUser(userId);
    const db = getDB();

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
          { $project: { id: 1, start_ts: 1, end_ts: 1, contact_phone: 1, status: 1, notes: 1, staff_name: 1 } },
          { $sort: { start_ts: 1 } }
        ]).toArray();
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
                  <form method="post" action="/bookings/settings" style="display:grid; gap:12px;" onsubmit="return true;">
                    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px;">
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
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                      <label class="settings-label">Closed dates (JSON array of YYYY-MM-DD)
                        <textarea class="settings-field" name="closed_dates_json" rows="4" placeholder='["2025-12-25","2025-12-31"]'>${escapeHtml(closedDatesJson)}</textarea>
                      </label>
                      <label class="settings-label">Holiday rules (JSON array of {"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM"})
                        <textarea class="settings-field" name="holidays_rules_json" rows="4" placeholder='[{"date":"2025-12-24","start":"12:00","end":"23:59"}]'>${escapeHtml(holidayRulesJson)}</textarea>
                      </label>
                    </div>
                    <div>
                      <label class="settings-label">Booking questions (JSON array of strings)
                        <textarea class="settings-field" name="booking_questions_json" rows="4" placeholder='["What\'s your name?","What\'s your email?","What\'s the reason for the booking?"]'>${escapeHtml(bookingQuestionsJson)}</textarea>
                        <div class="small" style="color:#6b7280;margin-top:4px;">Name is mandatory and will be asked first even if omitted.</div>
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
    const closed = (req.body?.closed_dates_json || '').toString();
    const rules = (req.body?.holidays_rules_json || '').toString();
    const qjsonRaw = (req.body?.booking_questions_json || '').toString();
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
    try {
      await upsertSettingsForUser(userId, {
        booking_max_per_day: isNaN(maxPerDay) ? 0 : maxPerDay,
        booking_days_ahead: isNaN(daysAhead) ? 60 : daysAhead,
        booking_display_interval_minutes: isNaN(displayInterval) ? 30 : displayInterval,
        booking_capacity_window_minutes: isNaN(capacityWindow) ? 60 : capacityWindow,
        booking_capacity_limit: isNaN(capacityLimit) ? 0 : capacityLimit,
        closed_dates_json: closed,
        holidays_rules_json: rules,
        booking_questions_json: qjsonSave
      });
    } catch {}
    const wantsJson = String(req.headers['accept']||'').includes('application/json')
      || String(req.headers['x-requested-with']||'') === 'XMLHttpRequest';
    if (wantsJson) return res.json({ ok: true });
    return res.redirect('/bookings');
  });
}


