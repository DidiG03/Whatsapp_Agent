import { ensureAuthed, getSignedInEmail, getCurrentUserId } from "../middleware/auth.mjs";
import { renderSidebar, escapeHtml } from "../utils.mjs";
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
        return `
          <li class="inbox-item">
            <div class="wa-row">
              <div class="wa-col">
                <div class="wa-top">
                  <div class="wa-name">${headline}</div>
                  <div class="item-ts small">${start}</div>
                </div>
                <div class="item-preview small">${meta}</div>
                ${detail ? `<div class=\"item-preview small\">${detail}</div>` : ''}
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
          <form method="post" action="/dashboard/booking-questions" style="display:grid; gap:8px;">
            <textarea name="booking_questions_json" class="settings-field" rows="4" placeholder='["What\'s your name?","What\'s the reason?"]'>${q}</textarea>
            <div><button type="submit">Save questions</button></div>
            <div class="small">Format: JSON array of short questions. Example: ["Full name","Reason for visit","Email"]</div>
          </form>
        </div>
      `;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <script>
          async function checkAuthThenSubmit(form){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs">Home / Dashboard</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('dashboard')}
            <main class="main">
              <div class="card">Welcome! Use the sidebar to navigate.</div>
              ${apptHtml}
              ${intakeHtml}
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

