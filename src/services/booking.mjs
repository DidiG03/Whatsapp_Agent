/**
 * Booking service
 * - Compute availability (via Google FreeBusy + working hours)
 * - Create, cancel, and reschedule appointments (mirrors in Google Calendar)
 */
import { db } from "../db.mjs";
import { freeBusy, createEvent, updateEvent, deleteEvent } from "./google.mjs";

function toISO(tsSeconds, tz) {
  // tsSeconds is epoch seconds; if not provided, compute at runtime
  const d = new Date(tsSeconds * 1000);
  // Return UTC ISO; Google accepts Z with start/end set to dateTime and timeZone
  return d.toISOString();
}

function computeDaySlots(dayDate, slotMinutes, tz, workingHours, busyBlocks) {
  // workingHours example: { mon:["09:00-17:00"], ... } with keys sun..sat
  const dow = ["sun","mon","tue","wed","thu","fri","sat"][dayDate.getDay()];
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
  return db.prepare(`SELECT * FROM staff WHERE id = ? AND user_id = ?`).get(staffId, userId) || null;
}

export function getCalendarById(calendarId, userId) {
  return db.prepare(`SELECT * FROM calendars WHERE id = ? AND user_id = ?`).get(calendarId, userId) || null;
}

export async function listAvailability({ userId, staffId, dateISO, days = 1, slotMinutes }) {
  const staff = getStaffById(staffId, userId);
  if (!staff) return [];
  const calendar = staff.calendar_id ? getCalendarById(staff.calendar_id, userId) : null;
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
    results.push({ date: day.toISOString().slice(0,10), slots: slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() })) });
  }
  return results;
}

export async function createBooking({ userId, staffId, startISO, endISO, contactPhone, notes }) {
  const staff = getStaffById(staffId, userId);
  if (!staff) throw new Error("staff not found");
  const calendar = staff.calendar_id ? getCalendarById(staff.calendar_id, userId) : null;
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
  const ins = db.prepare(`INSERT INTO appointments (user_id, staff_id, contact_phone, start_ts, end_ts, gcal_event_id, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, strftime('%s', ?), strftime('%s', ?), ?, 'confirmed', ?, strftime('%s','now'), strftime('%s','now'))`);
  const info = ins.run(userId, staffId, contactPhone || null, startISO, endISO, gcalId, notes || null);
  const id = info.lastInsertRowid;
  return { id, gcal_event_id: gcalId };
}

export async function cancelBooking({ userId, appointmentId }) {
  const row = db.prepare(`SELECT a.*, s.calendar_id, c.calendar_id AS cal_key FROM appointments a
    JOIN staff s ON s.id = a.staff_id
    LEFT JOIN calendars c ON c.id = s.calendar_id
    WHERE a.id = ? AND a.user_id = ?`).get(appointmentId, userId);
  if (!row) return false;
  if (row.gcal_event_id && row.calendar_id) {
    const cal = getCalendarById(row.calendar_id, userId);
    if (cal) { try { await deleteEvent(cal, row.gcal_event_id); } catch {} }
  }
  try {
    db.prepare(`UPDATE appointments SET status = 'canceled', updated_at = strftime('%s','now') WHERE id = ?`).run(appointmentId);
  } catch {}
  return true;
}

export async function rescheduleBooking({ userId, appointmentId, startISO, endISO }) {
  const row = db.prepare(`SELECT a.*, s.calendar_id FROM appointments a
    JOIN staff s ON s.id = a.staff_id WHERE a.id = ? AND a.user_id = ?`).get(appointmentId, userId);
  if (!row) throw new Error("appointment not found");
  const cal = row.calendar_id ? getCalendarById(row.calendar_id, userId) : null;
  if (cal) {
    const busy = await freeBusy(cal, startISO, endISO);
    const overlaps = (Array.isArray(busy) ? busy : []).some(b => {
      const bs = new Date(b.start); const be = new Date(b.end);
      const ss = new Date(startISO); const ee = new Date(endISO);
      return ss < be && ee > bs;
    });
    if (overlaps) throw new Error("time slot no longer available");
  }
  if (cal && row.gcal_event_id) {
    await updateEvent(cal, row.gcal_event_id, { start: { dateTime: startISO }, end: { dateTime: endISO } });
  }
  db.prepare(`UPDATE appointments SET start_ts = strftime('%s', ?), end_ts = strftime('%s', ?), status = 'confirmed', updated_at = strftime('%s','now') WHERE id = ?`).run(startISO, endISO, appointmentId);
  return true;
}


