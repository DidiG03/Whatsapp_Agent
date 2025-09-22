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
    website_url: values.website_url ?? current.website_url ?? null,
    ai_tone: values.ai_tone ?? current.ai_tone ?? null,
    ai_blocked_topics: values.ai_blocked_topics ?? current.ai_blocked_topics ?? null,
    ai_style: values.ai_style ?? current.ai_style ?? null,
    entry_greeting: values.entry_greeting ?? current.entry_greeting ?? null,
  };
  db.prepare(`
    INSERT INTO settings_multi (user_id, phone_number_id, whatsapp_token, verify_token, app_secret, business_phone, website_url, ai_tone, ai_blocked_topics, ai_style, entry_greeting, updated_at)
    VALUES (@user_id, @phone_number_id, @whatsapp_token, @verify_token, @app_secret, @business_phone, @website_url, @ai_tone, @ai_blocked_topics, @ai_style, @entry_greeting, strftime('%s','now'))
    ON CONFLICT(user_id) DO UPDATE SET
      phone_number_id = excluded.phone_number_id,
      whatsapp_token = excluded.whatsapp_token,
      verify_token = excluded.verify_token,
      app_secret = excluded.app_secret,
      business_phone = excluded.business_phone,
      website_url = excluded.website_url,
      ai_tone = excluded.ai_tone,
      ai_blocked_topics = excluded.ai_blocked_topics,
      ai_style = excluded.ai_style,
      entry_greeting = excluded.entry_greeting,
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

