/**
 * Clock-time parsing helpers for booking (e.g. "tomorrow at 5" → 5 PM).
 */

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Resolve bare hours without am/pm for reservations.
 * Restaurant-style: 1–11 → PM; 12 → noon; explicit am/pm cues win.
 */
export function disambiguateBookingHour(hh, normalizedText) {
  let hour = Number(hh);
  if (!Number.isFinite(hour)) return hour;
  const s = stripAccentsLower(normalizedText);
  const hasPmCue = /\b(pm|pasdites?|mbremje|naten|dark|dinner|evening|night)\b/.test(s);
  const hasAmCue = /\b(am|paradite|mengjes|morning|breakfast)\b/.test(s);
  if (hasPmCue && !hasAmCue && hour >= 1 && hour <= 11) hour += 12;
  else if (hasAmCue && !hasPmCue) {
    if (hour === 12) hour = 0;
  } else if (!hasPmCue && !hasAmCue) {
    if (hour >= 1 && hour <= 11) hour += 12;
  }
  return hour;
}

export function isAdditionalBookingConfirm(text) {
  const sq = stripAccentsLower(String(text || ""));
  return /\b(yes|yeah|yep|yup|sure|confirm|another|additional|extra|ok|okay|po|po\s*patjet[eë]r|patjet[eë]r)\b/.test(sq);
}
