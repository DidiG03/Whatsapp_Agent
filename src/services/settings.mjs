/**
 * Settings service for multi-tenant configuration (per Clerk user).
 * Provides helpers to get, upsert, and find settings by various keys.
 */
import { db } from "../db.mjs";

/** Fetch settings for a given user id. */
export function getSettingsForUser(userId) {
  if (!userId) return {};
  const row = db.prepare(`SELECT * FROM settings_multi WHERE user_id = ?`).get(userId);
  return row || {};
}

/** Upsert settings for a given user id, merging with existing values. */
export function upsertSettingsForUser(userId, values) {
  if (!userId) return {};
  const current = getSettingsForUser(userId);
  const merged = {
    user_id: userId,
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
  };
  db.prepare(`
    INSERT INTO settings_multi (user_id, phone_number_id, whatsapp_token, verify_token, app_secret, business_phone, business_name, website_url, ai_tone, ai_blocked_topics, ai_style, entry_greeting, bookings_enabled, booking_questions_json, reschedule_min_lead_minutes, cancel_min_lead_minutes, reminders_enabled, reminder_windows, wa_template_name, wa_template_language, updated_at)
    VALUES (@user_id, @phone_number_id, @whatsapp_token, @verify_token, @app_secret, @business_phone, @business_name, @website_url, @ai_tone, @ai_blocked_topics, @ai_style, @entry_greeting, @bookings_enabled, @booking_questions_json, @reschedule_min_lead_minutes, @cancel_min_lead_minutes, @reminders_enabled, @reminder_windows, @wa_template_name, @wa_template_language, strftime('%s','now'))
    ON CONFLICT(user_id) DO UPDATE SET
      phone_number_id = excluded.phone_number_id,
      whatsapp_token = excluded.whatsapp_token,
      verify_token = excluded.verify_token,
      app_secret = excluded.app_secret,
      business_phone = excluded.business_phone,
      business_name = excluded.business_name,
      website_url = excluded.website_url,
      ai_tone = excluded.ai_tone,
      ai_blocked_topics = excluded.ai_blocked_topics,
      ai_style = excluded.ai_style,
      entry_greeting = excluded.entry_greeting,
      bookings_enabled = excluded.bookings_enabled,
      booking_questions_json = excluded.booking_questions_json,
      reschedule_min_lead_minutes = excluded.reschedule_min_lead_minutes,
      cancel_min_lead_minutes = excluded.cancel_min_lead_minutes,
      reminders_enabled = excluded.reminders_enabled,
      reminder_windows = excluded.reminder_windows,
      wa_template_name = excluded.wa_template_name,
      wa_template_language = excluded.wa_template_language,
      updated_at = excluded.updated_at
  `).run(merged);
  return merged;
}

/** Locate a tenant settings row using the Meta verify token. */
export function findSettingsByVerifyToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE verify_token = ?`).get(token) || null;
}

/** Locate a tenant settings row using the Meta phone_number_id. */
export function findSettingsByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE phone_number_id = ?`).get(phoneNumberId) || null;
}

/** Locate a tenant by normalized business phone digits. */
export function findSettingsByBusinessPhone(digits) {
  if (!digits) return null;
  return db.prepare(`SELECT * FROM settings_multi WHERE REPLACE(business_phone, '+', '') = ? OR business_phone = ?`).get(digits, digits) || null;
}

