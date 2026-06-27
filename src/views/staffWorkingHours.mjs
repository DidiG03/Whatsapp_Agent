const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function parseWorkingHoursJson(json) {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function splitRange(range) {
  const match = String(range || '').match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!match) return null;
  return { start: match[1], end: match[2] };
}

function parseTimeField(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatRange(start, end) {
  const startTime = parseTimeField(start);
  const endTime = parseTimeField(end);
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if ((eh * 60 + em) <= (sh * 60 + sm)) return null;
  return `${startTime}-${endTime}`;
}

function parseLegacyWorkingHours(raw) {
  const matches = [...String(raw || '').replace(/–/g, '-').matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
  const ranges = [];
  for (const match of matches) {
    const range = formatRange(`${match[1]}:${match[2]}`, `${match[3]}:${match[4]}`);
    if (range) ranges.push(range);
  }
  return ranges;
}

export function parseWorkingHoursFromFields(body = {}) {
  const out = {};
  for (const day of DAYS) {
    const open = body[`hours_${day}_open`];
    if (open === '1' || open === 'on') {
      const ranges = [];
      for (const suffix of ['', '_2']) {
        const range = formatRange(
          body[`hours_${day}_start${suffix}`],
          body[`hours_${day}_end${suffix}`]
        );
        if (range) ranges.push(range);
      }
      if (ranges.length) out[day] = ranges;
      continue;
    }

    const legacy = parseLegacyWorkingHours(body[`hours_${day}`]);
    if (legacy.length) out[day] = legacy;
  }
  return JSON.stringify(out);
}

function renderDayRow(day, label, workingHours, options = {}) {
  const ranges = Array.isArray(workingHours?.[day]) ? workingHours[day] : [];
  const first = splitRange(ranges[0]) || { start: '09:00', end: '17:00' };
  const second = splitRange(ranges[1]);
  const defaultOpenWeekdays = options.defaultOpenWeekdays !== false;
  const dayIndex = DAYS.indexOf(day);
  const isOpen = ranges.length > 0 || (defaultOpenWeekdays && dayIndex >= 0 && dayIndex < 5 && !options.hasExistingHours);
  const showSecond = !!second;

  return `
    <div class="staff-hours__row" data-day="${day}">
      <label class="staff-hours__day-toggle">
        <input type="checkbox" name="hours_${day}_open" value="1"${isOpen ? ' checked' : ''} />
        <span>${label}</span>
      </label>
      <div class="staff-hours__slots"${isOpen ? '' : ' hidden'}>
        <div class="staff-hours__slot">
          <input type="time" class="settings-field staff-hours__time" name="hours_${day}_start" value="${escapeAttr(first.start)}"${isOpen ? '' : ' disabled'} />
          <span class="staff-hours__sep">to</span>
          <input type="time" class="settings-field staff-hours__time" name="hours_${day}_end" value="${escapeAttr(first.end)}"${isOpen ? '' : ' disabled'} />
        </div>
        <div class="staff-hours__slot staff-hours__slot--extra"${showSecond ? '' : ' hidden'}>
          <input type="time" class="settings-field staff-hours__time" name="hours_${day}_start_2" value="${escapeAttr(second?.start || '18:00')}"${isOpen && showSecond ? '' : ' disabled'} />
          <span class="staff-hours__sep">to</span>
          <input type="time" class="settings-field staff-hours__time" name="hours_${day}_end_2" value="${escapeAttr(second?.end || '20:00')}"${isOpen && showSecond ? '' : ' disabled'} />
          <button type="button" class="btn-ghost staff-hours__remove-slot">Remove</button>
        </div>
      </div>
      <button type="button" class="btn-ghost staff-hours__add-slot"${isOpen && !showSecond ? '' : ' hidden'}>Split shift</button>
    </div>
  `;
}

export function renderStaffWorkingHoursFields(workingHoursJson = '{}', options = {}) {
  const workingHours = parseWorkingHoursJson(workingHoursJson);
  const hasExistingHours = DAYS.some((day) => Array.isArray(workingHours[day]) && workingHours[day].length);
  const rows = DAYS.map((day, index) => renderDayRow(day, DAY_LABELS[index], workingHours, {
    ...options,
    hasExistingHours,
  })).join('');

  return `
    <div class="staff-hours" data-staff-hours>
      <div class="staff-hours__header">
        <div class="small staff-hours__hint">Choose open days and set start/end times. Use split shift for lunch breaks or evening hours.</div>
        <button type="button" class="btn-ghost staff-hours__copy-btn">Copy Mon to weekdays</button>
      </div>
      <div class="staff-hours__grid">
        ${rows}
      </div>
    </div>
  `;
}
