import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { listAvailability, createBooking, cancelBooking, rescheduleBooking } from "../services/booking.mjs";

export default function registerBookingRoutes(app) {
  // Public read: availability (admin-auth optional). If authed, uses their user_id.
  app.get("/booking/availability", async (req, res) => {
    try {
      const userId = getCurrentUserId(req) || (req.query.user_id || null);
      const staffId = Number(req.query.staff_id || 0);
      const date = (req.query.date || new Date().toISOString().slice(0,10)).toString();
      const days = Number(req.query.days || 1);
      const slot = Number(req.query.slot_minutes || 30);
      if (!userId || !staffId) return res.status(400).json({ error: "user_id and staff_id required" });
      const slots = await listAvailability({ userId, staffId, dateISO: `${date}T00:00:00.000Z`, days, slotMinutes: slot });
      return res.json({ availability: slots });
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // Create booking (authed admin; can be adapted for public with token)
  app.post("/booking/create", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const { staff_id, start, end, contact_phone, notes } = req.body || {};
      if (!staff_id || !start || !end) return res.status(400).json({ error: "staff_id, start, end required" });
      const r = await createBooking({ userId, staffId: Number(staff_id), startISO: String(start), endISO: String(end), contactPhone: contact_phone || null, notes: notes || null });
      return res.json({ ok: true, id: r.id, gcal_event_id: r.gcal_event_id });
    } catch (e) {
      return res.status(409).json({ error: String(e && e.message || e) });
    }
  });

  // Cancel booking
  app.delete("/booking/:id", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const id = Number(req.params.id || 0);
      if (!id) return res.status(400).json({ error: "invalid id" });
      const ok = await cancelBooking({ userId, appointmentId: id });
      return res.json({ ok });
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // Reschedule booking
  app.put("/booking/:id", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const id = Number(req.params.id || 0);
      const { start, end } = req.body || {};
      if (!id || !start || !end) return res.status(400).json({ error: "id, start, end required" });
      await rescheduleBooking({ userId, appointmentId: id, startISO: String(start), endISO: String(end) });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(409).json({ error: String(e && e.message || e) });
    }
  });
}


