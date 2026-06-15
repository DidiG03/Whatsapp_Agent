import { normalizePhone } from '../utils.mjs';
import { Handoff } from '../schemas/mongodb.mjs';

export function sanitizeContactParam(value) {
  let cleaned = String(value || '').trim();
  cleaned = cleaned.split('?')[0].split('#')[0];
  cleaned = cleaned.replace(/[?&](?:type|toast|status|state|code)=[^&?#]*/gi, '');
  cleaned = cleaned.replace(/(?:type|toast|status|state|code)=[a-z0-9_+-]+/gi, '');
  return cleaned.trim();
}

export function contactIdVariants(phone) {
  const raw = sanitizeContactParam(phone);
  const digits = normalizePhone(raw);
  const variants = new Set();
  if (raw) variants.add(raw);
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
  }
  return [...variants];
}

export function canonicalContactId(phone) {
  const cleaned = sanitizeContactParam(phone);
  const digits = normalizePhone(cleaned);
  return digits || cleaned;
}

export async function findHandoffForContact(userId, phone, select = 'is_human human_expires_ts contact_id updatedAt') {
  const variants = contactIdVariants(phone);
  if (!variants.length) return null;

  const rows = await Handoff.find({ user_id: userId, contact_id: { $in: variants } })
    .select(select)
    .sort({ updatedAt: -1 })
    .lean();

  if (!rows.length) return null;

  const now = Math.floor(Date.now() / 1000);
  const active = rows.find((row) => row.is_human && Number(row.human_expires_ts || 0) > now);
  if (active) return active;

  return rows[0];
}

export async function upsertHandoffForContact(userId, phone, update, options = {}) {
  const variants = contactIdVariants(phone);
  const canonical = canonicalContactId(phone);
  const payload = { ...update, updatedAt: new Date() };

  if (variants.length) {
    await Handoff.updateMany(
      { user_id: userId, contact_id: { $in: variants } },
      { $set: payload }
    );
  }

  return Handoff.findOneAndUpdate(
    { user_id: userId, contact_id: canonical },
    { $set: payload },
    { upsert: true, new: true, ...options }
  );
}

export function resolveHumanMode(handoffRow) {
  const isHumanFlag = !!handoffRow?.is_human;
  const expTs = Number(handoffRow?.human_expires_ts || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const remain = expTs > nowSec ? expTs - nowSec : 0;
  const isHuman = isHumanFlag && expTs > 0 && remain > 0;
  return { isHuman, expTs, remain, expired: isHumanFlag && expTs > 0 && remain <= 0 };
}
