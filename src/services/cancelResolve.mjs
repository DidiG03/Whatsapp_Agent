/**
 * Resolve which upcoming appointment a customer means when several exist
 * (cancel, reschedule, name change, etc.).
 */

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isRecentBookingCancelRequest(text) {
  return isRecentOrTargetedBookingRequest(text);
}

/** User points at a specific booking (just made, latest, "the one at 9:30", etc.). */
export function isRecentOrTargetedBookingRequest(text) {
  const sq = stripAccentsLower(text);
  if (/\b(just\s+made|just\s+booked|i\s+just|the\s+one\s+i\s+just|booking\s+i\s+just|latest|last\s+one|most\s+recent|qe\s+sapo|sapo\s+bera|sapo\s+kryer|rezervimin\s+qe\s+sapo)\b/.test(sq)) {
    return true;
  }
  if (/\b(that|this|the)\s+one\b/.test(sq) && /\b(booking|appointment|reservation|rezervim)\b/.test(sq)) {
    return true;
  }
  if (/\b(reschedule|change|modify|move|update|ndrysh|ndrro|zhvendos|anul|cancel)\b/.test(sq)
    && /\b(just\s+made|just\s+booked|i\s+just|latest|last\s+one|qe\s+sapo|the\s+one|that\s+one)\b/.test(sq)) {
    return true;
  }
  return false;
}

/** Time phrase referring to an existing booking (not the new requested time). */
export function extractExistingBookingTimeHint(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const beforeTo = raw.split(/\bto\b/i)[0] || raw;
  for (const src of [beforeTo, raw]) {
    const atMatch = /\b(?:at|for|@|në|ne)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(src);
    if (atMatch) return atMatch[1].trim();
    const bookingMatch = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:booking|appointment|reservation|rezervim|one)\b/i.exec(src);
    if (bookingMatch) return bookingMatch[1].trim();
    const myMatch = /\bmy\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(src);
    if (myMatch) return myMatch[1].trim();
    const theMatch = /\bthe\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(src);
    if (theMatch) return theMatch[1].trim();
  }
  return null;
}

export function parseAppointmentRefFromText(text) {
  const m = /(?:ref\s*#?\s*|#)(\d{6,12})\b/i.exec(String(text || ""));
  return m ? m[1] : null;
}

export function getWallClockInTimeZone(dateObj, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dateObj);
  return {
    year: Number(parts.find((p) => p.type === "year")?.value || "1970"),
    month: Number(parts.find((p) => p.type === "month")?.value || "1"),
    day: Number(parts.find((p) => p.type === "day")?.value || "1"),
    hour: Number(parts.find((p) => p.type === "hour")?.value || "0"),
    minute: Number(parts.find((p) => p.type === "minute")?.value || "0"),
  };
}

export function matchAppointmentByWallClock(appointments, { dateISO, hour, minute = 0 }, timezone = "UTC") {
  if (hour == null || !Array.isArray(appointments) || !appointments.length) return null;
  const matches = [];
  for (const appt of appointments) {
    const w = getWallClockInTimeZone(new Date((appt.start_ts || 0) * 1000), timezone);
    const apptDate = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
    if (hour === w.hour && Number(minute || 0) === w.minute && (!dateISO || dateISO === apptDate)) {
      matches.push(appt);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return [...matches].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  }
  return null;
}

export function pickMostRecentlyBooked(appointments) {
  if (!Array.isArray(appointments) || !appointments.length) return null;
  return [...appointments].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
}

export function findAppointmentByRef(appointments, ref) {
  const key = String(ref || "").trim();
  if (!key) return null;
  return (appointments || []).find((a) => String(a.id) === key) || null;
}
