/**
 * Settings service for multi-tenant configuration (per Clerk user).
 * Provides helpers to get, upsert, and find settings by various keys.
 */
import { SettingsMulti } from "../schemas/mongodb.mjs";
import { dataCache } from "../scalability/redis.mjs";

/** Fetch settings for a given user id. */
export async function getSettingsForUser(userId) {
  if (!userId) return {};
  const cacheKey = `settings:${userId}`;
  const cached = await dataCache.getUserData(cacheKey);
  if (cached) return cached;
  const row = await SettingsMulti.findOne({ user_id: userId }).lean();
  const value = row || {};
  // cache for 5 minutes
  try { await dataCache.cacheUserData(cacheKey, value, 300); } catch {}
  return value;
}

/** Upsert settings for a given user id, merging with existing values. */
export async function upsertSettingsForUser(userId, values) {
  if (!userId) return {};
  const current = await getSettingsForUser(userId);
  const merged = {
    user_id: userId,
    name: values.name ?? current.name ?? null,
    phone_number_id: values.phone_number_id ?? current.phone_number_id ?? null,
    whatsapp_token: values.whatsapp_token ?? current.whatsapp_token ?? null,
    verify_token: values.verify_token ?? current.verify_token ?? null,
    app_secret: values.app_secret ?? current.app_secret ?? null,
    business_phone: values.business_phone ?? current.business_phone ?? null,
    business_name: values.business_name ?? current.business_name ?? null,
    website_url: values.website_url ?? current.website_url ?? null,
    ai_tone: values.ai_tone ?? current.ai_tone ?? null,
    ai_blocked_topics: values.ai_blocked_topics ?? current.ai_blocked_topics ?? null,
    ai_style: values.ai_style ?? current.ai_style ?? null,
    entry_greeting: values.entry_greeting ?? current.entry_greeting ?? null,
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
    // Booking advanced controls
    booking_max_per_day: values.booking_max_per_day ?? current.booking_max_per_day ?? 0,
    booking_days_ahead: values.booking_days_ahead ?? current.booking_days_ahead ?? 60,
    booking_display_interval_minutes: values.booking_display_interval_minutes ?? current.booking_display_interval_minutes ?? 30,
    booking_capacity_window_minutes: values.booking_capacity_window_minutes ?? current.booking_capacity_window_minutes ?? 60,
    booking_capacity_limit: values.booking_capacity_limit ?? current.booking_capacity_limit ?? 0,
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

/** Locate a tenant settings row using the Meta verify token. */
export async function findSettingsByVerifyToken(token) {
  if (!token) return null;
  return (await SettingsMulti.findOne({ verify_token: token }).lean()) || null;
}

/** Locate a tenant settings row using the Meta phone_number_id. */
export async function findSettingsByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return (await SettingsMulti.findOne({ phone_number_id: phoneNumberId }).lean()) || null;
}

/** Locate a tenant by normalized business phone digits. */
export async function findSettingsByBusinessPhone(digits) {
  if (!digits) return null;
  // Check digits-only and exact match
  const or = [
    { business_phone: digits },
    { business_phone: new RegExp(`\\+?${digits}$`) }
  ];
  return (await SettingsMulti.findOne({ $or: or }).lean()) || null;
}

