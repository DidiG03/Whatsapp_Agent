import { z } from "zod";

const reminderOptions = ["2h", "4h", "1d"];

const HolidayRuleSchema = z.object({
  name: z.string().trim().max(80).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/)
});

const ServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  minutes: z.number().int().min(5).max(480),
  price: z.string().trim().max(40).nullable().optional()
});

const DISPLAY_INTERVALS = [15, 20, 30, 40, 60, 90, 120];
const CAPACITY_WINDOWS = [30, 60, 90, 120];

const SettingsSchema = z.object({
  business_type: nullableString(80),
  phone_number_id: nullableDigits(6, 32),
  waba_id: nullableDigits(6, 32),
  whatsapp_token: nullableString(512),
  verify_token: nullableString(128),
  app_secret: nullableString(256),
  business_phone: nullableString(32),
  business_name: nullableString(160),
  business_categories: z.array(z.string().trim().max(50)).max(20),
  website_url: nullableUrl(),
  business_address: nullableString(500),
  business_latitude: nullableFloat(-90, 90),
  business_longitude: nullableFloat(-180, 180),
  business_place_id: nullableString(200),
  ai_tone: nullableString(160),
  ai_blocked_topics: nullableString(160),
  ai_style: nullableString(200),
  conversation_mode: z.enum(["full", "escalation"]),
  bookings_enabled: z.boolean().default(false),
  reminders_enabled: z.boolean().default(false),
  reschedule_min_lead_minutes: nullableNumber(5, 10080),
  cancel_min_lead_minutes: nullableNumber(5, 10080),
  reminder_windows: z.array(z.enum(reminderOptions)).max(reminderOptions.length),
  wa_template_name: nullableString(120),
  wa_template_language: nullableString(16),
  escalation_additional_message: nullableString(280),
  escalation_out_of_hours_message: nullableString(280),
  escalation_questions: z.array(z.string().trim().max(280)).max(10),
  holidays_json_url: nullableUrl(),
  closed_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(365),
  holiday_rules: z.array(HolidayRuleSchema).max(64),
  booking_max_per_day: nullableNumber(0, 500),
  booking_days_ahead: nullableNumber(1, 365),
  booking_display_interval_minutes: z.number().int().refine((n) => DISPLAY_INTERVALS.includes(n)),
  booking_capacity_window_minutes: z.number().int().refine((n) => CAPACITY_WINDOWS.includes(n)),
  booking_capacity_limit: nullableNumber(0, 500),
  waitlist_enabled: z.boolean().default(false),
  staff_whatsapp_group_id: nullableString(256),
  staff_whatsapp_group_enabled: z.boolean().default(false),
  services: z.array(ServiceSchema).max(20)
});

function nullableString(max) {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return null;
    const trimmed = String(val).trim();
    return trimmed.length ? trimmed : null;
  }, z.string().max(max).nullable());
}

function nullableDigits(minLength, maxLength) {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return null;
    const trimmed = String(val).trim();
    return trimmed.length ? trimmed : null;
  }, z.union([
    z.string().regex(/^\d+$/).min(minLength).max(maxLength),
    z.null()
  ]));
}

function nullableUrl() {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return null;
    let str = String(val).trim();
    if (!str) return null;
    if (!/^https?:\/\//i.test(str)) {
      str = `https://${str}`;
    }
    try {
      return new URL(str).toString();
    } catch {
      return null;
    }
  }, z.string().url().nullable());
}

function nullableNumber(min, max) {
  return z.preprocess((val) => {
    if (val === undefined || val === null || val === "") return null;
    const num = Number(val);
    if (Number.isNaN(num)) return null;
    return num;
  }, z.number().int().min(min).max(max).nullable());
}

function nullableFloat(min, max) {
  return z.preprocess((val) => {
    if (val === undefined || val === null || val === "") return null;
    const num = Number(val);
    if (Number.isNaN(num)) return null;
    return num;
  }, z.number().min(min).max(max).nullable());
}

function coerceBoolean(value) {
  if (Array.isArray(value)) {
    value = value[value.length - 1];
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["1", "true", "on", "yes"].includes(normalized)) return true;
    if (["0", "false", "off", "no"].includes(normalized)) return false;
  }
  return Boolean(value);
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseReminderWindows(raw) {
  const unique = new Set();
  toArray(raw).forEach((entry) => {
    const normalized = String(entry || "").toLowerCase();
    if (reminderOptions.includes(normalized)) unique.add(normalized);
  });
  return Array.from(unique);
}

function parseEscalationQuestions(raw) {
  const text = typeof raw === "string" ? raw : "";
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length);
}

function parseCategories(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return [];
  return text
    .split(/,|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseClosedDates(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .map((date) => String(date || "").trim())
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
    }
  } catch {
    return [];
  }
  return [];
}

function parseHolidayRules(body) {
  const names = toArray(body.holiday_name);
  const dates = toArray(body.holiday_date);
  const starts = toArray(body.holiday_start);
  const ends = toArray(body.holiday_end);
  const rules = [];
  const max = Math.max(names.length, dates.length, starts.length, ends.length);
  for (let i = 0; i < max; i++) {
    const date = String(dates[i] || "").trim();
    const start = String(starts[i] || "").trim();
    const end = String(ends[i] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) continue;
    rules.push({
      name: String(names[i] || "").trim() || null,
      date,
      start,
      end
    });
  }
  return rules;
}

function snapToAllowed(value, allowed, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return allowed.includes(num) ? num : fallback;
}

function parseServicesJson(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        name: String(x?.name || "").trim(),
        minutes: Number(x?.minutes || 0),
        price: x?.price ? String(x.price).trim() : null,
      }))
      .filter((x) => x.name && x.minutes > 0)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function normalizePayload(raw = {}) {
  return {
    business_type: raw.business_type,
    phone_number_id: raw.phone_number_id,
    waba_id: raw.waba_id,
    whatsapp_token: raw.whatsapp_token,
    verify_token: raw.verify_token,
    app_secret: raw.app_secret,
    business_phone: raw.business_phone,
    business_name: raw.business_name,
    business_categories: parseCategories(raw.business_categories),
    website_url: raw.website_url,
    business_address: raw.business_address,
    business_latitude: raw.business_latitude,
    business_longitude: raw.business_longitude,
    business_place_id: raw.business_place_id,
    ai_tone: raw.ai_tone,
    ai_blocked_topics: raw.ai_blocked_topics,
    ai_style: raw.ai_style,
    conversation_mode: raw.conversation_mode === "escalation" ? "escalation" : "full",
    bookings_enabled: coerceBoolean(raw.bookings_enabled),
    reminders_enabled: coerceBoolean(raw.reminders_enabled),
    reschedule_min_lead_minutes: raw.reschedule_min_lead_minutes,
    cancel_min_lead_minutes: raw.cancel_min_lead_minutes,
    reminder_windows: parseReminderWindows(raw.reminder_windows),
    wa_template_name: raw.wa_template_name,
    wa_template_language: raw.wa_template_language,
    escalation_additional_message: raw.escalation_additional_message,
    escalation_out_of_hours_message: raw.escalation_out_of_hours_message,
    escalation_questions: parseEscalationQuestions(raw.escalation_questions_json),
    holidays_json_url: raw.holidays_json_url,
    closed_dates: parseClosedDates(raw.closed_dates_json),
    holiday_rules: parseHolidayRules(raw),
    booking_max_per_day: raw.booking_max_per_day,
    booking_days_ahead: raw.booking_days_ahead,
    booking_display_interval_minutes: snapToAllowed(raw.booking_display_interval_minutes, DISPLAY_INTERVALS, 30),
    booking_capacity_window_minutes: snapToAllowed(raw.booking_capacity_window_minutes, CAPACITY_WINDOWS, 60),
    booking_capacity_limit: raw.booking_capacity_limit,
    waitlist_enabled: coerceBoolean(raw.waitlist_enabled),
    staff_whatsapp_group_id: raw.staff_whatsapp_group_id,
    staff_whatsapp_group_enabled: coerceBoolean(raw.staff_whatsapp_group_enabled),
    services: parseServicesJson(raw.services_json)
  };
}

export function validateSettingsPayload(rawBody = {}) {
  const normalized = normalizePayload(rawBody);
  const parsed = SettingsSchema.safeParse(normalized);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.flatten() };
  }
  const data = parsed.data;

  const bookingsEnabled = data.conversation_mode !== "escalation";
  const remindersEnabled = bookingsEnabled && data.reminders_enabled;

  const payload = {
    business_type: data.business_type,
    phone_number_id: data.phone_number_id,
    waba_id: data.waba_id,
    whatsapp_token: data.whatsapp_token,
    verify_token: data.verify_token,
    app_secret: data.app_secret,
    business_phone: data.business_phone,
    business_name: data.business_name,
    business_categories_json: data.business_categories.length ? JSON.stringify(data.business_categories) : null,
    website_url: data.website_url,
    business_address: data.business_address,
    business_latitude: data.business_latitude,
    business_longitude: data.business_longitude,
    business_place_id: data.business_place_id,
    ai_tone: data.ai_tone,
    ai_blocked_topics: data.ai_blocked_topics,
    ai_style: data.ai_style,
    conversation_mode: data.conversation_mode,
    bookings_enabled: bookingsEnabled,
    reminders_enabled: remindersEnabled,
    reschedule_min_lead_minutes: data.reschedule_min_lead_minutes,
    cancel_min_lead_minutes: data.cancel_min_lead_minutes,
    reminder_windows: data.reminder_windows.length ? JSON.stringify(data.reminder_windows) : null,
    wa_template_name: data.wa_template_name,
    wa_template_language: data.wa_template_language,
    escalation_additional_message: data.escalation_additional_message,
    escalation_out_of_hours_message: data.escalation_out_of_hours_message,
    escalation_questions_json: data.escalation_questions.length ? JSON.stringify(data.escalation_questions) : null,
    holidays_json_url: data.holidays_json_url,
    closed_dates_json: JSON.stringify(data.closed_dates),
    holidays_rules_json: data.holiday_rules.length ? JSON.stringify(data.holiday_rules) : null,
    booking_max_per_day: data.booking_max_per_day ?? 0,
    booking_days_ahead: data.booking_days_ahead ?? 60,
    booking_display_interval_minutes: data.booking_display_interval_minutes,
    booking_capacity_window_minutes: data.booking_capacity_window_minutes,
    booking_capacity_limit: data.booking_capacity_limit ?? 0,
    waitlist_enabled: data.waitlist_enabled,
    staff_whatsapp_group_id: data.staff_whatsapp_group_id,
    staff_whatsapp_group_enabled: data.staff_whatsapp_group_enabled,
    services_json: data.services.length ? JSON.stringify(data.services) : null
  };

  return { success: true, data: payload };
}

export default {
  validateSettingsPayload
};

