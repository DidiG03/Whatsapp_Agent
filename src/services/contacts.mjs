import { getDB } from "../db-mongodb.mjs";

/** Update last activity timestamp for a contact (Mongo). */
export async function updateContactActivity(userId, contactId) {
  if (!userId || !contactId) return;
  try {
    const db = getDB();
    await db.Contact.updateOne(
      { user_id: userId, contact_id: contactId },
      { $set: { last_activity_at: new Date() } }
    );
  } catch (_) {}
}
