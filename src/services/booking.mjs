/**
 * Booking service
 * - Compute availability (via Google FreeBusy + working hours)
 * - Create, cancel, and reschedule appointments (mirrors in Google Calendar)
 */
import { getDB } from "../db-mongodb.mjs";
import mongoose from 'mongoose';
import { Staff, Calendar, Appointment } from "../schemas/mongodb.mjs";
import { freeBusy, createEvent, updateEvent, deleteEvent } from "./google.mjs";

// (removed unused toISO)

function getDowKeyInTz(dateObj, timeZone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(dateObj).toLowerCase();
    // sun, mon, tue, wed, thu, fri, sat
    return part.slice(0,3);
  } catch {
    return ["sun","mon","tue","wed","thu","fri","sat"][dateObj.getDay()];
  }
}

function computeDaySlots(dayDate, slotMinutes, tz, workingHours, busyBlocks) {
  // workingHours example: { mon:["09:00-17:00"], ... } with keys sun..sat
  const dow = getDowKeyInTz(dayDate, tz);
  const spans = Array.isArray(workingHours?.[dow]) ? workingHours[dow] : [];
  const slots = [];
  for (const span of spans) {
    const [startStr, endStr] = String(span||"").split("-");
    if (!startStr || !endStr) continue;
    const [sh, sm] = startStr.split(":").map(n => Number(n||0));
    const [eh, em] = endStr.split(":").map(n => Number(n||0));
    const start = new Date(dayDate); start.setHours(sh, sm||0, 0, 0);
    const end = new Date(dayDate); end.setHours(eh, em||0, 0, 0);
    for (let t = new Date(start); t < end; t = new Date(t.getTime() + slotMinutes*60000)) {
      const next = new Date(t.getTime() + slotMinutes*60000);
      if (next > end) break;
      const overlapsBusy = busyBlocks.some(b => {
        const bs = new Date(b.start);
        const be = new Date(b.end);
        return t < be && next > bs;
      });
      if (!overlapsBusy) slots.push({ start: new Date(t), end: next });
    }
  }
  return slots;
}

export function getStaffById(staffId, userId) {
  try {
    if (mongoose.Types.ObjectId.isValid(String(staffId))) {
      return Staff.findOne({ _id: new mongoose.Types.ObjectId(String(staffId)), user_id: String(userId) }).lean();
    }
    // Fallback: treat as legacy numeric id stored in a shadow field
    return Staff.findOne({ legacy_id: Number(staffId), user_id: String(userId) }).lean();
  } catch { return null; }
}

export function getCalendarById(calendarId, userId) {
  try {
    if (mongoose.Types.ObjectId.isValid(String(calendarId))) {
      return Calendar.findOne({ _id: new mongoose.Types.ObjectId(String(calendarId)), user_id: String(userId) }).lean();
    }
    return Calendar.findOne({ legacy_id: Number(calendarId), user_id: String(userId) }).lean();
  } catch { return null; }
}

export async function listAvailability({ userId, staffId, dateISO, days = 1, slotMinutes }) {
  const staff = await getStaffById(staffId, userId);
  if (!staff) return [];
  const calendar = staff.calendar_id ? await getCalendarById(staff.calendar_id, userId) : null;
  const tz = staff.timezone || calendar?.timezone || "UTC";
  const minutes = Number(slotMinutes || staff.slot_minutes || 30);
  const working = (() => { try { return JSON.parse(staff.working_hours_json || '{}'); } catch { return {}; } })();

  const startDay = new Date(dateISO);
  startDay.setHours(0,0,0,0);
  const results = [];
  for (let d = 0; d < Number(days||1); d++) {
    const day = new Date(startDay.getTime() + d*86400000);
    const tMin = new Date(day); tMin.setHours(0,0,0,0);
    const tMax = new Date(day); tMax.setHours(23,59,59,999);
    const busy = calendar ? await freeBusy(calendar, tMin.toISOString(), tMax.toISOString()) : [];
    const slots = computeDaySlots(day, minutes, tz, working, busy);
    try { if (!slots.length) console.log('availability-debug', { userId, staffId, tz, date: day.toISOString().slice(0,10), minutes, spans: (working && working[getDowKeyInTz(day, tz)] || []).length, busy: busy.length }); } catch {}
    results.push({ date: day.toISOString().slice(0,10), slots: slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() })) });
  }
  return results;
}

export async function createBooking({ userId, staffId, startISO, endISO, contactPhone, notes }) {
  const staff = await getStaffById(staffId, userId);
  if (!staff) throw new Error("staff not found");
  const calendar = staff.calendar_id ? await getCalendarById(staff.calendar_id, userId) : null;
  // Double-check FreeBusy for the requested range
  if (calendar) {
    const busy = await freeBusy(calendar, startISO, endISO);
    const overlaps = (Array.isArray(busy) ? busy : []).some(b => {
      const bs = new Date(b.start); const be = new Date(b.end);
      const ss = new Date(startISO); const ee = new Date(endISO);
      return ss < be && ee > bs;
    });
    if (overlaps) throw new Error("time slot no longer available");
  }
  let gcalId = null;
  if (calendar) {
    const evt = {
      summary: notes ? `Appointment (${notes.slice(0, 60)})` : "Appointment",
      description: notes || undefined,
      start: { dateTime: startISO },
      end: { dateTime: endISO }
    };
    const r = await createEvent(calendar, evt);
    gcalId = r?.id || null;
  }
  // Create appointment in Mongo; include a legacy-compatible 'id' field (numeric seconds) to reference in flows
  const startTs = Math.floor(new Date(startISO).getTime() / 1000);
  const endTs = Math.floor(new Date(endISO).getTime() / 1000);
  const db = getDB();
  let legacyId = Math.floor(Date.now() / 1000);
  try {
    // ensure uniqueness by bumping if collision for this user
    // eslint-disable-next-line no-constant-condition
    for (let i = 0; i < 5; i++) {
      const exists = await db.collection('appointments').findOne({ user_id: String(userId), id: legacyId });
      if (!exists) break;
      legacyId += 1;
    }
  } catch {}
  const apptDoc = await Appointment.create({
    user_id: String(userId),
    staff_id: mongoose.Types.ObjectId.isValid(String(staffId)) ? new mongoose.Types.ObjectId(String(staffId)) : undefined,
    contact_phone: contactPhone || null,
    start_ts: startTs,
    end_ts: endTs,
    gcal_event_id: gcalId,
    status: 'confirmed',
    notes: notes || null,
    notify_24h_sent: false,
    notify_4h_sent: false,
    notify_2h_sent: false,
    id: legacyId
  });
  return { id: legacyId, gcal_event_id: gcalId, _id: apptDoc._id };
}

export async function cancelBooking({ userId, appointmentId }) {
  const db = getDB();
  const appt = await db.collection('appointments').findOne({ user_id: String(userId), id: Number(appointmentId) });
  if (!appt) return false;
  // Try to delete Google event when possible
  try {
    if (appt.gcal_event_id && appt.staff_id) {
      const calOwner = await Staff.findOne({ _id: appt.staff_id }).lean();
      if (calOwner?.calendar_id) {
        const cal = await getCalendarById(calOwner.calendar_id, userId);
        if (cal) { try { await deleteEvent(cal, appt.gcal_event_id); } catch {} }
      }
    }
  } catch {}
  await Appointment.updateOne({ _id: appt._id }, { $set: { status: 'canceled', updatedAt: new Date() } });
  return true;
}

export async function rescheduleBooking({ userId, appointmentId, startISO, endISO }) {
  const db = getDB();
  const appt = await db.collection('appointments').findOne({ user_id: String(userId), id: Number(appointmentId) });
  if (!appt) throw new Error("appointment not found");
  const calOwner = appt.staff_id ? await Staff.findOne({ _id: appt.staff_id }).lean() : null;
  const cal = calOwner?.calendar_id ? await getCalendarById(calOwner.calendar_id, userId) : null;
  if (cal) {
    const busy = await freeBusy(cal, startISO, endISO);
    const overlaps = (Array.isArray(busy) ? busy : []).some(b => {
      const bs = new Date(b.start); const be = new Date(b.end);
      const ss = new Date(startISO); const ee = new Date(endISO);
      return ss < be && ee > bs;
    });
    if (overlaps) throw new Error("time slot no longer available");
  }
  if (cal && appt.gcal_event_id) {
    await updateEvent(cal, appt.gcal_event_id, { start: { dateTime: startISO }, end: { dateTime: endISO } });
  }
  const startTs = Math.floor(new Date(startISO).getTime() / 1000);
  const endTs = Math.floor(new Date(endISO).getTime() / 1000);
  await Appointment.updateOne({ _id: appt._id }, { $set: { start_ts: startTs, end_ts: endTs, status: 'confirmed', updatedAt: new Date() } });
  return true;
}

/** Build the next 7 day-list rows for booking or reschedule. */
export function buildDayRows(staffId, apptId = null) {
  const base = new Date();
  return Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    const id = apptId
      ? `RESCHED_PICK_DAY_${iso}_${staffId}_${apptId}`
      : `PICK_DAY_${iso}_${staffId}`;
    return { id, title: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), description: 'Tap to view times' };
  });
}

/** Build time rows for a given date using availability. */
export async function buildTimeRows({ userId, staffId, dateISO, limit = 10, apptId = null }) {
  const avail = await listAvailability({ userId, staffId, dateISO, days: 1 });
  const slots = Array.isArray(avail) ? (avail[0]?.slots || []) : [];
  const upcoming = slots.filter(s => new Date(s.start).getTime() > Date.now()).slice(0, Number(limit||10));
  const rows = upcoming.map(s => ({
    id: apptId
      ? `RESCHED_PICK_TIME_${apptId}_${staffId}_${s.start}_${s.end}`
      : `BOOK_SLOT_${s.start}_${s.end}_${staffId}`,
    title: apptId
      ? new Date(s.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : new Date(s.start).toLocaleString(),
    description: apptId ? 'Tap to confirm' : 'Tap to book'
  }));
  return rows;
}

/** Return true if too close to start time per lead minutes. */
export function isTooCloseToStart(nowSecs, startTs, minLeadMinutes) {
  const minsToStart = Math.floor(((startTs||0) - (nowSecs||0)) / 60);
  return minsToStart < Number(minLeadMinutes || 60);
}


