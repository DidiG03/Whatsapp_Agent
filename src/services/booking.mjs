
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser } from "./../services/settings.mjs";
import mongoose from 'mongoose';
import { Staff, Calendar, Appointment } from "../schemas/mongodb.mjs";
import { freeBusy, createEvent, updateEvent, deleteEvent } from "./google.mjs";
import { getYmdPartsInTimeZone } from "../utils.mjs";

function localMinutesOfDay(dateObj, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dateObj);
    const hh = Number(parts.find(p => p.type === 'hour')?.value || '0');
    const mm = Number(parts.find(p => p.type === 'minute')?.value || '0');
    return hh * 60 + mm;
  } catch {
    return dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();
  }
}

function getDowKeyInTz(dateObj, timeZone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(dateObj).toLowerCase();
    return part.slice(0,3);
  } catch {
    return ["sun","mon","tue","wed","thu","fri","sat"][dateObj.getDay()];
  }
}

function computeDaySlots(dayDate, slotMinutes, tz, workingHours, busyBlocks) {
  const dow = getDowKeyInTz(dayDate, tz);
  const spans = Array.isArray(workingHours?.[dow]) ? workingHours[dow] : [];
  if (process.env.DEBUG_BOOKINGS === '1') try { console.log('[availability] spans', { date: dayDate.toISOString().slice(0,10), dow, spans }); } catch {}
  const slots = [];
  const { year: y, month: m, day: d } = getYmdPartsInTimeZone(dayDate, tz || 'UTC');
  for (const span of spans) {
    const [startStr, endStr] = String(span||"").split("-");
    if (!startStr || !endStr) continue;
    const [sh, sm] = startStr.split(":").map(n => Number(n||0));
    const [eh, em] = endStr.split(":").map(n => Number(n||0));
    const start = new Date(Date.UTC(y, m-1, d, sh, sm||0, 0, 0));
    const end = new Date(Date.UTC(y, m-1, d, eh, em||0, 0, 0));
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
  let calendar = staff.calendar_id ? await getCalendarById(staff.calendar_id, userId) : null;
  if (!calendar) {
    try {
      const db = getDB();
      calendar = await db.collection('calendars').findOne({ user_id: String(userId) });
    } catch {}
  }
  const tz = staff.timezone || calendar?.timezone || "UTC";
  const settings = await (async () => { try { return await getSettingsForUser(userId); } catch { return {}; } })();

  const minutes = Number(slotMinutes || settings?.booking_display_interval_minutes || staff.slot_minutes || 30);
  let working = (() => { try { return JSON.parse(staff.working_hours_json || '{}'); } catch { return {}; } })();
  try {
    const hasAny = working && Object.values(working).some(v => Array.isArray(v) && v.length > 0);
    if (!hasAny) {
      working = { mon:["09:00-17:00"], tue:["09:00-17:00"], wed:["09:00-17:00"], thu:["09:00-17:00"], fri:["09:00-17:00"] };
    }
  } catch {}
  const maxPerDay = Number(settings?.booking_max_per_day || 0);
  const daysAhead = Number(settings?.booking_days_ahead || 0);
  const capWindowMin = Number(settings?.booking_capacity_window_minutes || minutes || 60);
  const capLimit = Number(settings?.booking_capacity_limit || 0);
  const DBG = process.env.DEBUG_BOOKINGS === '1';
  if (DBG) console.log('[availability] input', { userId, staffId: String(staffId), tz, minutes, days, startDate: dateISO, maxPerDay, daysAhead, capWindowMin, capLimit });
  const closedDatesSet = (() => {
    try {
      const arr = JSON.parse(settings?.closed_dates_json || '[]');
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch { return new Set(); }
  })();
  const holidayRules = (() => {
    try {
      const arr = JSON.parse(settings?.holidays_rules_json || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  })();

  const startDay = new Date(dateISO);
  startDay.setHours(0,0,0,0);
  const results = [];
  for (let d = 0; d < Number(days||1); d++) {
    const day = new Date(startDay.getTime() + d*86400000);
    if (daysAhead > 0) {
      const diffDays = Math.floor((day.getTime() - Date.now()) / 86400000);
      if (diffDays > daysAhead) { results.push({ date: day.toISOString().slice(0,10), slots: [] }); continue; }
    }
    const ymdParts = getYmdPartsInTimeZone(day, tz || 'UTC');
    const ymdKey = `${ymdParts.year}-${String(ymdParts.month).padStart(2,'0')}-${String(ymdParts.day).padStart(2,'0')}`;
    if (closedDatesSet.has(ymdKey)) {
      results.push({ date: day.toISOString().slice(0,10), slots: [] });
      continue;
    }
    const tMin = new Date(day); tMin.setHours(0,0,0,0);
    const tMax = new Date(day); tMax.setHours(23,59,59,999);
    const busy = calendar ? await freeBusy(calendar, tMin.toISOString(), tMax.toISOString()) : [];
    let dayAppts = [];
    try {
      const db = getDB();
      const dayStartSec = Math.floor(tMin.getTime()/1000);
      const dayEndSec = Math.floor(tMax.getTime()/1000);
      dayAppts = await db.collection('appointments')
        .find({ user_id: String(userId), status: 'confirmed', start_ts: { $gte: dayStartSec, $lte: dayEndSec } })
        .project({ start_ts: 1, end_ts: 1 })
        .toArray();
    } catch {}
    const slots = computeDaySlots(day, minutes, tz, working, busy);
    try { if (!slots.length) console.log('availability-debug', { userId, staffId, tz, date: day.toISOString().slice(0,10), minutes, spans: (working && working[getDowKeyInTz(day, tz)] || []).length, busy: busy.length }); } catch {}
    let mapped = slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
    if (DBG) console.log('[availability] pre-filter', { date: day.toISOString().slice(0,10), slotCount: mapped.length, busyCount: (busy||[]).length, apptCount: (dayAppts||[]).length });
    try {
      const dayRules = holidayRules.filter(r => String(r?.date) === ymdKey);
      if (dayRules.length) {
        mapped = mapped.filter(s => {
          const sm = localMinutesOfDay(new Date(s.start), tz);
          const em = localMinutesOfDay(new Date(s.end), tz);
          const overlapsClosed = dayRules.some(r => {
            const m1 = /^\s*(\d{2}):(\d{2})\s*$/.exec(String(r?.start||'00:00'));
            const m2 = /^\s*(\d{2}):(\d{2})\s*$/.exec(String(r?.end||'23:59'));
            if (!m1 || !m2) return false;
            const rs = Number(m1[1]) * 60 + Number(m1[2]);
            const re = Number(m2[1]) * 60 + Number(m2[2]);
            return (sm < re) && (em > rs);
          });
          return !overlapsClosed;
        });
      }
    } catch {}
    if (maxPerDay > 0) {
      try {
        const db = getDB();
        const ymd = day.toISOString().slice(0,10);
        const dayStart = Math.floor(new Date(`${ymd}T00:00:00.000Z`).getTime()/1000);
        const dayEnd = Math.floor(new Date(`${ymd}T23:59:59.999Z`).getTime()/1000);
        const count = await db.collection('appointments').countDocuments({ user_id: String(userId), status: 'confirmed', start_ts: { $gte: dayStart, $lte: dayEnd } });
        if (count >= maxPerDay) mapped = [];
      } catch {}
    }
    if (capLimit > 0 && capWindowMin > 0) {
      const filtered = [];
      const winMs = capWindowMin * 60000;
      for (const s of mapped) {
        const ss = new Date(s.start).getTime();
        const se = ss + winMs;
        const count = (dayAppts||[]).filter(a => {
          const as = (a.start_ts||0)*1000; const ae = (a.end_ts||0)*1000;
          return ss < ae && se > as;        }).length;
        if (count < capLimit) filtered.push(s);
      }
      mapped = filtered;
    }
    if (DBG) console.log('[availability] post-filter', { date: day.toISOString().slice(0,10), slotCount: mapped.length });
    results.push({ date: day.toISOString().slice(0,10), slots: mapped });
  }
  return results;
}

export async function createBooking({ userId, staffId, startISO, endISO, contactPhone, notes, replaceExistingForContact = true }) {
  const staff = await getStaffById(staffId, userId);
  if (!staff) throw new Error("staff not found");
  const calendar = staff.calendar_id ? await getCalendarById(staff.calendar_id, userId) : null;
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
  try {
    if (replaceExistingForContact && contactPhone) {
      const db = getDB();
      const digits = String(contactPhone || '').replace(/\D/g, '');
      const nowSec = Math.floor(Date.now() / 1000);
      const existing = await db.collection('appointments')
        .find({
          user_id: String(userId),
          status: 'confirmed',
          start_ts: { $gte: nowSec },
          $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ]
        })
        .project({ _id: 1, gcal_event_id: 1, staff_id: 1 })
        .toArray();
      for (const ex of (existing || [])) {
        try {
          if (ex.gcal_event_id && ex.staff_id) {
            const calOwner = await Staff.findOne({ _id: ex.staff_id }).lean();
            if (calOwner?.calendar_id) {
              const cal = await getCalendarById(calOwner.calendar_id, userId);
              if (cal) { try { await deleteEvent(cal, ex.gcal_event_id); } catch {} }
            }
          }
          await Appointment.updateOne({ _id: ex._id }, { $set: { status: 'canceled', updatedAt: new Date() } });
        } catch {}
      }
    }
  } catch {}
  const startTs = Math.floor(new Date(startISO).getTime() / 1000);
  const endTs = Math.floor(new Date(endISO).getTime() / 1000);
  const db = getDB();
  let legacyId = Math.floor(Date.now() / 1000);
  try {
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
  try {
    const digits = String(appt.contact_phone || '').replace(/\D/g, '');
    const nowSec = Math.floor(Date.now() / 1000);
    const others = await db.collection('appointments')
      .find({
        user_id: String(userId),
        status: 'confirmed',
        id: { $ne: Number(appointmentId) },
        start_ts: { $gte: nowSec },
        $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ]
      })
      .project({ _id: 1, gcal_event_id: 1, staff_id: 1 })
      .toArray();
    for (const ex of (others || [])) {
      try {
        if (ex.gcal_event_id && ex.staff_id) {
          const owner = await Staff.findOne({ _id: ex.staff_id }).lean();
          if (owner?.calendar_id) {
            const c = await getCalendarById(owner.calendar_id, userId);
            if (c) { try { await deleteEvent(c, ex.gcal_event_id); } catch {} }
          }
        }
        await Appointment.updateOne({ _id: ex._id }, { $set: { status: 'canceled', updatedAt: new Date() } });
      } catch {}
    }
  } catch {}
  return true;
}
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
export async function buildTimeRows({ userId, staffId, dateISO, limit = 10, apptId = null, slotMinutes = undefined }) {
  const avail = await listAvailability({ userId, staffId, dateISO, days: 1, slotMinutes });
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
export function isTooCloseToStart(nowSecs, startTs, minLeadMinutes) {
  const minsToStart = Math.floor(((startTs||0) - (nowSecs||0)) / 60);
  return minsToStart < Number(minLeadMinutes || 60);
}

