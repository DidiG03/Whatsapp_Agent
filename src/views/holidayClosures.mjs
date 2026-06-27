function parseJsonArray(text, fallback = []) {
  try {
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

export function mergeHolidaysForDisplay(holidaysRulesJson = '[]', closedDatesJson = '[]') {
  const rules = parseJsonArray(holidaysRulesJson).map((rule) => ({
    name: String(rule?.name || '').trim(),
    date: String(rule?.date || '').trim(),
    start: String(rule?.start || '').trim(),
    end: String(rule?.end || '').trim(),
  })).filter((rule) => rule.date || rule.name || rule.start || rule.end);

  const closedDates = parseJsonArray(closedDatesJson)
    .map((date) => String(date || '').trim())
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

  const ruleDates = new Set(rules.map((rule) => rule.date).filter(Boolean));
  for (const date of closedDates) {
    if (!ruleDates.has(date)) {
      rules.push({ name: '', date, start: '00:00', end: '23:59' });
    }
  }

  return rules.map((rule) => ({
    ...rule,
    fullDay: closedDates.includes(rule.date)
      || (rule.start === '00:00' && rule.end === '23:59'),
  }));
}

function renderHolidayRow(rule = {}) {
  const fullDay = !!rule.fullDay;
  const start = fullDay ? '00:00' : (rule.start || '');
  const end = fullDay ? '23:59' : (rule.end || '');

  return `
    <input class="settings-field" name="holiday_name" value="${escapeAttr(rule.name || '')}" placeholder="Christmas" />
    <input class="settings-field" name="holiday_date" type="date" value="${escapeAttr(rule.date || '')}" />
    <label class="holiday-full-day">
      <input type="hidden" name="holiday_full_day" class="holiday-full-day-value" value="${fullDay ? '1' : '0'}" />
      <input type="checkbox" class="holiday-full-day-toggle"${fullDay ? ' checked' : ''} />
      <span>Full day</span>
    </label>
    <input class="settings-field holiday-time-input" name="holiday_start" value="${escapeAttr(start)}" placeholder="00:00"${fullDay ? ' disabled' : ''} />
    <input class="settings-field holiday-time-input" name="holiday_end" value="${escapeAttr(end)}" placeholder="23:59"${fullDay ? ' disabled' : ''} />
    <button type="button" class="btn-ghost holiday-remove-btn">Remove</button>
  `;
}

export function renderHolidayClosureFields(holidaysRulesJson = '[]', closedDatesJson = '[]') {
  const rows = mergeHolidaysForDisplay(holidaysRulesJson, closedDatesJson);
  const displayRows = rows.length ? rows : [{ name: '', date: '', start: '', end: '', fullDay: false }];

  return `
    <div class="holiday-closures">
      <p class="small settings-lead">Add closures by date. Check <strong>Full day</strong> to block the entire day for bookings and out-of-hours replies.</p>
      <div id="holiday-rows" class="holiday-rows">
        <div class="text-xs holiday-rows__head">Name</div>
        <div class="text-xs holiday-rows__head">Date</div>
        <div class="text-xs holiday-rows__head">Closure</div>
        <div class="text-xs holiday-rows__head">Start (HH:MM)</div>
        <div class="text-xs holiday-rows__head">End (HH:MM)</div>
        <div class="holiday-rows__head"></div>
        ${displayRows.map((row) => renderHolidayRow(row)).join('')}
      </div>
      <div class="holiday-closures__actions">
        <button type="button" id="add-holiday-row-btn" class="btn-primary">Add Holiday</button>
        <div class="small">Partial closures use start/end times. Full-day closures disable booking for that date.</div>
      </div>
    </div>
  `;
}

export function parseClosedDatesFromHolidays(body = {}) {
  const toArray = (val) => {
    if (val == null) return [];
    return Array.isArray(val) ? val : [val];
  };
  const dates = toArray(body.holiday_date);
  const fullDays = toArray(body.holiday_full_day);
  const max = Math.max(dates.length, fullDays.length);
  const closed = [];

  for (let i = 0; i < max; i += 1) {
    const date = String(dates[i] || '').trim();
    const fullDay = String(fullDays[i] || '') === '1';
    if (fullDay && /^\d{4}-\d{2}-\d{2}$/.test(date) && !closed.includes(date)) {
      closed.push(date);
    }
  }

  return closed;
}
