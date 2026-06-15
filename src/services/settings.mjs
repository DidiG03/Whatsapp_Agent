
import { SettingsMulti } from "../schemas/mongodb.mjs";
import { dataCache } from "../scalability/redis.mjs";
import { buildGoogleBusinessContextLines, parseGoogleBusinessSnapshot } from "./googleBusinessImport.mjs";
export async function getSettingsForUser(userId) {
  if (!userId) return {};
  const cacheKey = `settings:${userId}`;
  const cached = await dataCache.getUserData(cacheKey);
  if (cached) return cached;
  const row = await SettingsMulti.findOne({ user_id: userId }).lean();
  const value = row ? { ...row } : {};
  delete value.entry_greeting;
  try { await dataCache.cacheUserData(cacheKey, value, 300); } catch {}
  return value;
}
export async function upsertSettingsForUser(userId, values) {
  if (!userId) return {};
  const current = await getSettingsForUser(userId);
  const merged = {
    user_id: userId,
    name: values.name ?? current.name ?? null,
    business_type: values.business_type ?? current.business_type ?? null,
    phone_number_id: values.phone_number_id ?? current.phone_number_id ?? null,
    waba_id: values.waba_id ?? current.waba_id ?? null,
    whatsapp_token: values.whatsapp_token ?? current.whatsapp_token ?? null,
    verify_token: values.verify_token ?? current.verify_token ?? null,
    app_secret: values.app_secret ?? current.app_secret ?? null,
    business_phone: values.business_phone ?? current.business_phone ?? null,
    business_name: values.business_name ?? current.business_name ?? null,
    business_categories_json: values.business_categories_json ?? current.business_categories_json ?? null,
    website_url: values.website_url ?? current.website_url ?? null,
    business_address: values.business_address ?? current.business_address ?? null,
    business_latitude: values.business_latitude ?? current.business_latitude ?? null,
    business_longitude: values.business_longitude ?? current.business_longitude ?? null,
    business_place_id: values.business_place_id ?? current.business_place_id ?? null,
    google_business_json: values.google_business_json ?? current.google_business_json ?? null,
    ai_tone: values.ai_tone ?? current.ai_tone ?? null,
    ai_blocked_topics: values.ai_blocked_topics ?? current.ai_blocked_topics ?? null,
    ai_style: values.ai_style ?? current.ai_style ?? null,
    bookings_enabled: values.bookings_enabled ?? current.bookings_enabled ?? 0,
    booking_questions_json: values.booking_questions_json ?? current.booking_questions_json ?? null,
    reschedule_min_lead_minutes: values.reschedule_min_lead_minutes ?? current.reschedule_min_lead_minutes ?? 60,
    cancel_min_lead_minutes: values.cancel_min_lead_minutes ?? current.cancel_min_lead_minutes ?? 60,
    reminders_enabled: values.reminders_enabled ?? current.reminders_enabled ?? 0,
    reminder_windows: values.reminder_windows ?? current.reminder_windows ?? null,
    wa_template_name: values.wa_template_name ?? current.wa_template_name ?? null,
    wa_template_language: values.wa_template_language ?? current.wa_template_language ?? null,
    escalation_email_enabled: values.escalation_email_enabled ?? current.escalation_email_enabled ?? 0,
    escalation_email: values.escalation_email ?? current.escalation_email ?? null,
    smtp_host: values.smtp_host ?? current.smtp_host ?? null,
    smtp_port: values.smtp_port ?? current.smtp_port ?? 587,
    smtp_secure: values.smtp_secure ?? current.smtp_secure ?? 0,
    smtp_user: values.smtp_user ?? current.smtp_user ?? null,
    smtp_pass: values.smtp_pass ?? current.smtp_pass ?? null,
    conversation_mode: values.conversation_mode ?? current.conversation_mode ?? 'full',
    escalation_additional_message: values.escalation_additional_message ?? current.escalation_additional_message ?? null,
    escalation_out_of_hours_message: values.escalation_out_of_hours_message ?? current.escalation_out_of_hours_message ?? null,
    escalation_questions_json: values.escalation_questions_json ?? current.escalation_questions_json ?? null,
    holidays_json_url: values.holidays_json_url ?? current.holidays_json_url ?? null,
    closed_dates_json: values.closed_dates_json ?? current.closed_dates_json ?? null,
    holidays_rules_json: values.holidays_rules_json ?? current.holidays_rules_json ?? null,
    booking_max_per_day: values.booking_max_per_day ?? current.booking_max_per_day ?? 0,
    booking_days_ahead: values.booking_days_ahead ?? current.booking_days_ahead ?? 60,
    booking_display_interval_minutes: values.booking_display_interval_minutes ?? current.booking_display_interval_minutes ?? 30,
    booking_capacity_window_minutes: values.booking_capacity_window_minutes ?? current.booking_capacity_window_minutes ?? 60,
    booking_capacity_limit: values.booking_capacity_limit ?? current.booking_capacity_limit ?? 0,
    services_json: values.services_json ?? current.services_json ?? null,
    waitlist_enabled: values.waitlist_enabled ?? current.waitlist_enabled ?? false,
    staff_whatsapp_group_id: values.staff_whatsapp_group_id ?? current.staff_whatsapp_group_id ?? null,
    staff_whatsapp_group_enabled: values.staff_whatsapp_group_enabled ?? current.staff_whatsapp_group_enabled ?? false,
  };
  try {
    const res = await SettingsMulti.findOneAndUpdate(
      { user_id: userId },
      { $set: merged },
      { upsert: true, new: true }
    );
    try { await dataCache.cacheUserData(`settings:${userId}`, merged, 300); } catch {}
    return merged;
  } catch (e) {
    console.error('[settings.upsert] error', e?.message || e);
    throw e;
  }
}
export async function findSettingsByVerifyToken(token) {
  if (!token) return null;
  return (await SettingsMulti.findOne({ verify_token: token }).lean()) || null;
}
export async function findSettingsByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return (await SettingsMulti.findOne({ phone_number_id: phoneNumberId }).lean()) || null;
}
export async function findSettingsByBusinessPhone(digits) {
  if (!digits) return null;
  const or = [
    { business_phone: digits },
    { business_phone: new RegExp(`\\+?${digits}$`) }
  ];
  return (await SettingsMulti.findOne({ $or: or }).lean()) || null;
}

/** Structured snippet injected into AI context so the bot can answer from dashboard settings. */
export function buildBusinessSettingsSnippet(cfg = {}) {
  const lines = [];
  const name = String(cfg.business_name || "").trim();
  const type = String(cfg.business_type || "").trim();
  const website = String(cfg.website_url || "").trim();
  let categories = [];
  try {
    const arr = JSON.parse(cfg.business_categories_json || "[]");
    categories = Array.isArray(arr) ? arr.map((c) => String(c || "").trim()).filter(Boolean) : [];
  } catch {}

  if (name) lines.push(`Business name: ${name}`);
  if (type) lines.push(`Business type: ${type}`);
  if (categories.length) lines.push(`Categories: ${categories.join(", ")}`);
  if (website) lines.push(`Website: ${website}`);
  const address = String(cfg.business_address || "").trim();
  if (address) lines.push(`Address: ${address}`);

  for (const line of buildGoogleBusinessContextLines(cfg)) {
    if (line && !lines.includes(line)) lines.push(line);
  }

  try {
    const snap = typeof cfg.google_business_json === "string" ? JSON.parse(cfg.google_business_json) : cfg.google_business_json;
    if (snap?.syncedAt) lines.push(`Google profile last synced: ${String(snap.syncedAt).slice(0, 10)}`);
  } catch {}

  if (cfg.bookings_enabled) lines.push("Bookings: enabled");
  if (cfg.reminders_enabled) lines.push("Appointment reminders: enabled");

  try {
    const services = JSON.parse(cfg.services_json || "[]");
    if (Array.isArray(services) && services.length) {
      const parts = services.slice(0, 12).map((s) => {
        const n = String(s?.name || "").trim();
        if (!n) return "";
        const m = Number(s?.minutes || 0);
        const p = String(s?.price || "").trim();
        const bits = [];
        if (m > 0) bits.push(`${m} min`);
        if (p) bits.push(p);
        return bits.length ? `${n} (${bits.join(", ")})` : n;
      }).filter(Boolean);
      if (parts.length) lines.push(`Services: ${parts.join("; ")}`);
    }
  } catch {}

  if (!lines.length) return null;
  return { title: "Business Settings", content: lines.join("\n") };
}

/** Parsed map pin from dashboard settings, or null if coordinates are missing/invalid. */
export function getBusinessLocation(cfg = {}) {
  const lat = Number(cfg.business_latitude);
  const lng = Number(cfg.business_longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const address = String(cfg.business_address || "").trim();
  const name = String(cfg.business_name || "").trim();
  return {
    latitude: lat,
    longitude: lng,
    address: address || undefined,
    name: name || undefined,
  };
}

