import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { listAvailability, createBooking, cancelBooking, rescheduleBooking } from "../services/booking.mjs";
import { sendBookingNotification } from "../services/email.mjs";
import { sendStaffGroupBookingNotification } from "../services/staffGroupNotifications.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { db } from "../db-mongodb.mjs";
import mongoose from 'mongoose';

export default function registerBookingRoutes(app) {
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
  app.post("/booking/create", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const { staff_id, start, end, contact_phone, notes } = req.body || {};
      if (!staff_id || !start || !end) return res.status(400).json({ error: "staff_id, start, end required" });
      const r = await createBooking({ userId, staffId: Number(staff_id), startISO: String(start), endISO: String(end), contactPhone: contact_phone || null, notes: notes || null });
      const staff = db.prepare(`SELECT name FROM staff WHERE id = ?`).get(staff_id);
      const customerName = contact_phone || 'Customer';
      try {
        await sendBookingNotification(userId, {
          customerName,
          customerPhone: contact_phone || 'N/A',
          startTime: start,
          endTime: end,
          notes: notes || '',
          appointmentId: r.id,
          staffName: staff?.name || null
        });
      } catch (e) {
        console.error('[Booking API] Failed to send booking email:', e.message);
      }
      try {
        const settings = await getSettingsForUser(userId);
        await sendStaffGroupBookingNotification(userId, {
          customerName,
          customerPhone: contact_phone || 'N/A',
          startTime: start,
          endTime: end,
          notes: notes || '',
          appointmentId: r.id,
          staffName: staff?.name || null,
        }, settings);
      } catch (e) {
        console.error('[Booking API] Failed to send staff group alert:', e.message);
      }
      try {
        const formattedTime = new Date(start).toLocaleString();
        db.prepare(`INSERT INTO notifications (user_id, type, title, message, link, metadata) 
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          userId,
          'booking',
          'New Booking Confirmed',
          `${customerName} booked an appointment for ${formattedTime} (Ref #${r.id})`,
          `/bookings`,
          JSON.stringify({ 
            contact_phone: contact_phone || null, 
            appointment_id: r.id,
            start_time: start,
            customer_name: customerName
          })
        );
      } catch (e) {
        console.error('[Booking API] Failed to create booking notification:', e.message);
      }
      
      return res.json({ ok: true, id: r.id, gcal_event_id: r.gcal_event_id });
    } catch (e) {
      if (e?.code === "BOOKING_ENFORCED") {
        return res.status(403).json({ error: e.reply || e.message, enforced: true });
      }
      return res.status(409).json({ error: String(e && e.message || e) });
    }
  });
  app.get("/booking/:id", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const id = Number(req.params.id || 0);
      if (!id) return res.status(400).json({ error: "invalid id" });
      const dbh = db;      try {
        const mongo = (await import('../db-mongodb.mjs')).getDB();
        const row = await mongo.collection('appointments')
          .aggregate([
            { $match: { user_id: String(userId), id } },
            { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
            { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
            { $project: { id: 1, start_ts: 1, end_ts: 1, contact_phone: 1, status: 1, notes: 1, staff_name: 1, staff_id: 1 } }
          ])
          .limit(1)
          .next();
        if (!row) return res.status(404).json({ error: 'not found' });
        return res.json({ booking: row });
      } catch (e) {
        return res.status(500).json({ error: String(e && e.message || e) });
      }
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  });
  app.patch("/booking/:id/notes", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const id = Number(req.params.id || 0);
      const notes = String((req.body && req.body.notes) || '').slice(0, 2000);
      if (!id) return res.status(400).json({ error: "invalid id" });
      const mongo = (await import('../db-mongodb.mjs')).getDB();
      const r = await mongo.collection('appointments').updateOne({ user_id: String(userId), id }, { $set: { notes, updatedAt: new Date() } });
      return res.json({ ok: r && (r.modifiedCount > 0) });
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  });
  app.delete("/booking/:id", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const raw = String(req.params.id || '').trim();
      console.log('[Bookings][DELETE] incoming cancel', { userId: String(userId), raw });
      let ok = false;
      if (/^\d+$/.test(raw)) {
        try { ok = await cancelBooking({ userId, appointmentId: Number(raw) }); } catch (e) { console.warn('[Bookings][DELETE] legacy cancel failed', e?.message || e); }
        if (ok) { console.log('[Bookings][DELETE] legacy path success'); return res.json({ ok: true }); }
      }
      try {
        const mongo = (await import('../db-mongodb.mjs')).getDB();
        const or = [];
        if (/^\d+$/.test(raw)) or.push({ id: Number(raw) });
        if (mongoose.Types.ObjectId.isValid(raw)) or.push({ _id: new mongoose.Types.ObjectId(raw) });
        if (or.length === 0) { console.warn('[Bookings][DELETE] invalid id format'); return res.status(400).json({ error: 'invalid id' }); }
        const appt = await mongo.collection('appointments').findOne({ user_id: String(userId), $or: or });
        if (!appt) { console.warn('[Bookings][DELETE] appointment not found for', { userId: String(userId), raw }); return res.json({ ok: false }); }
        console.log('[Bookings][DELETE] canceling appt', { _id: String(appt._id), id: appt.id });
        await mongo.collection('appointments').updateOne({ _id: appt._id }, { $set: { status: 'canceled', updatedAt: new Date() } });
        console.log('[Bookings][DELETE] marked canceled in DB');
        return res.json({ ok: true });
      } catch (e) {
        console.error('[Bookings][DELETE] server error', e?.message || e);
        return res.status(500).json({ error: String(e && e.message || e) });
      }
    } catch (e) {
      console.error('[Bookings][DELETE] outer error', e?.message || e);
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  });
  app.put("/booking/:id", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const raw = String(req.params.id || '').trim();
      const { start, end } = req.body || {};
      if (!start || !end) return res.status(400).json({ error: "start, end required" });
      if (/^\d+$/.test(raw)) {
        await rescheduleBooking({ userId, appointmentId: Number(raw), startISO: String(start), endISO: String(end) });
      } else {
        const mongo = (await import('../db-mongodb.mjs')).getDB();
        if (!mongoose.Types.ObjectId.isValid(raw)) return res.status(400).json({ error: "invalid id" });
        const _id = new mongoose.Types.ObjectId(raw);
        const appt = await mongo.collection('appointments').findOne({ _id, user_id: String(userId) });
        if (!appt) return res.status(404).json({ error: 'not found' });
        if (appt.id && Number(appt.id)) {
          await rescheduleBooking({ userId, appointmentId: Number(appt.id), startISO: String(start), endISO: String(end) });
        } else {
          await rescheduleBooking({ userId, mongoId: raw, startISO: String(start), endISO: String(end) });
        }
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(409).json({ error: String(e && e.message || e) });
    }
  });
}

