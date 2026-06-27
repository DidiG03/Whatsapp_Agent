import { getDB } from "../db-mongodb.mjs";
import { contactIdVariants } from "./handoff.mjs";
import { normalizePhone } from "../utils.mjs";

function contactIdInFilter(phone) {
  const variants = contactIdVariants(phone);
  const digits = normalizePhone(phone);
  const ids = [...new Set([...variants, digits, digits ? `+${digits}` : null].filter(Boolean))];
  return { $in: ids };
}

function appointmentPhoneFilter(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  return {
    $or: [{ contact_phone: digits }, { contact_phone: `+${digits}` }],
  };
}

/**
 * Wipe everything the bot remembers about a contact (memory, sessions, ratings,
 * waitlist, etc.). Does not delete message history — callers handle that separately.
 */
export async function resetContactBotKnowledge(userId, phone) {
  if (!userId || !phone) return { ok: false };

  const uid = String(userId);
  const contactFilter = contactIdInFilter(phone);
  const db = getDB();
  const nowSec = Math.floor(Date.now() / 1000);
  const apptPhone = appointmentPhoneFilter(phone);

  const results = {};

  try {
    const r = await db.collection("customers").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.customers = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] customers delete failed:", e?.message || e);
  }

  try {
    const r = await db.collection("booking_sessions").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.booking_sessions = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] booking_sessions delete failed:", e?.message || e);
  }

  try {
    const r = await db.collection("contact_state").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.contact_state = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] contact_state delete failed:", e?.message || e);
  }

  try {
    const r = await db.collection("contact_interactions").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.contact_interactions = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] contact_interactions delete failed:", e?.message || e);
  }

  try {
    const r = await db.collection("waitlist").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.waitlist = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] waitlist delete failed:", e?.message || e);
  }

  try {
    const r = await db.collection("csat_ratings").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.csat_ratings = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] csat_ratings delete failed:", e?.message || e);
  }

  if (apptPhone) {
    try {
      const r = await db.collection("appointments").updateMany(
        {
          user_id: uid,
          status: "confirmed",
          start_ts: { $gte: nowSec },
          ...apptPhone,
        },
        { $set: { status: "canceled", updatedAt: new Date() } }
      );
      results.appointments_canceled = r?.modifiedCount || 0;
    } catch (e) {
      console.warn("[ContactReset] appointments cancel failed:", e?.message || e);
    }
  }

  try {
    const r = await db.collection("handoff").deleteMany({
      user_id: uid,
      contact_id: contactFilter,
    });
    results.handoff = r?.deletedCount || 0;
  } catch (e) {
    console.warn("[ContactReset] handoff delete failed:", e?.message || e);
  }

  return { ok: true, ...results };
}

export default { resetContactBotKnowledge };
