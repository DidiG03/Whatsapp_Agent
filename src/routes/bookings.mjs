import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { getPlanStatus } from "../services/usage.mjs";
import { renderSidebar, renderTopbar, getProfessionalHead, renderPageHeader } from "../utils.mjs";

export default function registerBookingsTab(app) {
  app.get("/bookings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const s = await getSettingsForUser(userId);
    const { isUpgraded } = await getPlanStatus(userId);
    const bookingsEnabled = !!s?.bookings_enabled;
    const db = getDB();
    const nowSec = Math.floor(Date.now()/1000);
    const fromSec = nowSec - 30*86400;
    const toSec = nowSec + 90*86400;
    let appts = [];
    try {
      appts = await db.collection('appointments')
        .aggregate([
          { $match: { user_id: String(userId), status: { $ne: 'canceled' }, start_ts: { $gte: fromSec, $lte: toSec } } },
          { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
          { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
          { $addFields: { _id_str: { $toString: '$_id' } } },
          { $project: { _id_str: 1, id: 1, start_ts: 1, end_ts: 1, contact_phone: 1, status: 1, notes: 1, staff_name: 1, gcal_event_id: 1 } },
          { $sort: { start_ts: 1 } }
        ]).toArray();
    } catch {}
    const apptJson = JSON.stringify(appts || []);
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
            ${renderSidebar('bookings', { showBookings: true, isUpgraded })}
            <main class="main">
              <div class="main-content">
                ${!bookingsEnabled ? `
                  <div class="alert-banner alert-banner--warning">
                    <h4 class="alert-banner__title">Reservations are disabled</h4>
                    <p class="alert-banner__copy">Turn on Full AI Assistant mode and configure reservations in Settings to manage availability and appointments.</p>
                    <a class="btn btn-primary" href="/settings#bookings_section">Open reservation settings</a>
                  </div>
                ` : `
                  <div class="alert-banner alert-banner--info">
                    <p class="alert-banner__copy" style="margin:0;">Configure scheduling rules, services, and staff in <a href="/settings#bookings_section">Settings → Reservations</a>.</p>
                  </div>
                `}
                <div class="workspace-panel">
                  <div class="workspace-panel__head">
                    <h3 class="workspace-panel__title">Calendar</h3>
                    <div class="workspace-panel__hint">Past 30 days to next 90 days</div>
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

  app.post("/bookings/settings", ensureAuthed, async (_req, res) => {
    return res.redirect(303, "/settings#bookings_section");
  });
}

