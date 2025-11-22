import { z } from "zod";

const reminderOptions = ["2h", "4h", "1d"];

const HolidayRuleSchema = z.object({
  name: z.string().trim().max(80).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/)
});

const SettingsSchema = z.object({
  name: nullableString(120),
  phone_number_id: nullableDigits(6, 32),
  waba_id: nullableDigits(6, 32),
  whatsapp_token: nullableString(512),
  verify_token: nullableString(128),
  app_secret: nullableString(256),
  business_phone: nullableString(32),
  business_name: nullableString(160),
  website_url: nullableUrl(),
  terms_url: nullableUrl(),
  ai_tone: nullableString(160),
  ai_blocked_topics: nullableString(160),
  ai_style: nullableString(200),
  entry_greeting: nullableString(280),
  conversation_mode: z.enum(["full", "escalation"]),
  bookings_enabled: z.boolean().default(false),
  reminders_enabled: z.boolean().default(false),
  reschedule_min_lead_minutes: nullableNumber(5, 10080),
  cancel_min_lead_minutes: nullableNumber(5, 10080),
  reminder_windows: z.array(z.enum(reminderOptions)).max(reminderOptions.length),
  wa_template_name: nullableString(120),
  wa_template_language: nullableString(16),
  escalation_email_enabled: z.boolean().default(false),
  escalation_additional_message: nullableString(280),
  escalation_out_of_hours_message: nullableString(280),
  escalation_questions: z.array(z.string().trim().max(280)).max(10),
  holidays_json_url: nullableUrl(),
  closed_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(365),
  holiday_rules: z.array(HolidayRuleSchema).max(64),
  smtp_host: nullableString(160),
  smtp_port: nullableNumber(1, 65535),
  smtp_secure: z.boolean().default(false),
  smtp_user: nullableString(160),
  smtp_pass: nullableString(256)
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

function normalizePayload(raw = {}) {
  return {
    name: raw.name,
    phone_number_id: raw.phone_number_id,
    waba_id: raw.waba_id,
    whatsapp_token: raw.whatsapp_token,
    verify_token: raw.verify_token,
    app_secret: raw.app_secret,
    business_phone: raw.business_phone,
    business_name: raw.business_name,
    website_url: raw.website_url,
    terms_url: raw.terms_url,
    ai_tone: raw.ai_tone,
    ai_blocked_topics: raw.ai_blocked_topics,
    ai_style: raw.ai_style,
    entry_greeting: raw.entry_greeting,
    conversation_mode: raw.conversation_mode === "escalation" ? "escalation" : "full",
    bookings_enabled: coerceBoolean(raw.bookings_enabled),
    reminders_enabled: coerceBoolean(raw.reminders_enabled),
    reschedule_min_lead_minutes: raw.reschedule_min_lead_minutes,
    cancel_min_lead_minutes: raw.cancel_min_lead_minutes,
    reminder_windows: parseReminderWindows(raw.reminder_windows),
    wa_template_name: raw.wa_template_name,
    wa_template_language: raw.wa_template_language,
    escalation_email_enabled: coerceBoolean(raw.escalation_email_enabled),
    escalation_additional_message: raw.escalation_additional_message,
    escalation_out_of_hours_message: raw.escalation_out_of_hours_message,
    escalation_questions: parseEscalationQuestions(raw.escalation_questions_json),
    holidays_json_url: raw.holidays_json_url,
    closed_dates: parseClosedDates(raw.closed_dates_json),
    holiday_rules: parseHolidayRules(raw),
    smtp_host: raw.smtp_host,
    smtp_port: raw.smtp_port,
    smtp_secure: coerceBoolean(raw.smtp_secure),
    smtp_user: raw.smtp_user,
    smtp_pass: raw.smtp_pass
  };
}

export function validateSettingsPayload(rawBody = {}) {
  const normalized = normalizePayload(rawBody);
  const parsed = SettingsSchema.safeParse(normalized);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.flatten() };
  }
  const data = parsed.data;

  const bookingsEnabled = data.conversation_mode === "escalation" ? false : data.bookings_enabled;
  const remindersEnabled = bookingsEnabled && data.reminders_enabled;

  const payload = {
    name: data.name,
    phone_number_id: data.phone_number_id,
    waba_id: data.waba_id,
    whatsapp_token: data.whatsapp_token,
    verify_token: data.verify_token,
    app_secret: data.app_secret,
    business_phone: data.business_phone,
    business_name: data.business_name,
    website_url: data.website_url,
    terms_url: data.terms_url,
    ai_tone: data.ai_tone,
    ai_blocked_topics: data.ai_blocked_topics,
    ai_style: data.ai_style,
    entry_greeting: data.entry_greeting,
    conversation_mode: data.conversation_mode,
    bookings_enabled: bookingsEnabled,
    reminders_enabled: remindersEnabled,
    reschedule_min_lead_minutes: data.reschedule_min_lead_minutes,
    cancel_min_lead_minutes: data.cancel_min_lead_minutes,
    reminder_windows: data.reminder_windows.length ? JSON.stringify(data.reminder_windows) : null,
    wa_template_name: data.wa_template_name,
    wa_template_language: data.wa_template_language,
    escalation_email_enabled: data.escalation_email_enabled,
    escalation_additional_message: data.escalation_additional_message,
    escalation_out_of_hours_message: data.escalation_out_of_hours_message,
    escalation_questions_json: data.escalation_questions.length ? JSON.stringify(data.escalation_questions) : null,
    holidays_json_url: data.holidays_json_url,
    closed_dates_json: JSON.stringify(data.closed_dates),
    holidays_rules_json: data.holiday_rules.length ? JSON.stringify(data.holiday_rules) : null,
    smtp_host: data.smtp_host,
    smtp_port: data.smtp_port ?? 587,
    smtp_secure: data.smtp_secure,
    smtp_user: data.smtp_user,
    smtp_pass: data.smtp_pass
  };

  return { success: true, data: payload };
}

export default {
  validateSettingsPayload
};

