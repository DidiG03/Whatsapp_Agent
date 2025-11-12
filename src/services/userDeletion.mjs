/**
 * User Deletion Service
 * Wipes all user-scoped data across MongoDB collections and clears caches.
 */
import {
  Message,
  MessageStatus,
  MessageReaction,
  MessageReply,
  KBItem,
  Handoff,
  AIRequest,
  SettingsMulti,
  OnboardingState,
  Calendar,
  Staff,
  Appointment,
  BookingSession,
  ContactState,
  Customer,
  ContactTag,
  ContactInteraction,
  Notification,
  UsageStats,
  UserPlan,
  QuickReply
} from "../schemas/mongodb.mjs";
import { cache as redisCache } from "../scalability/redis.mjs";
import { getDB } from "../db-mongodb.mjs";

/**
 * Delete all data for a given Clerk user id across MongoDB collections.
 * Best effort: continues on errors and logs them to console.
 * @param {string} userId
 */
export async function wipeUserData(userId) {
  if (!userId) return;
  const uid = String(userId);
  const tasks = [];
  const deleteMany = (model, filter) => tasks.push(model.deleteMany(filter).catch(e => console.warn(`[wipeUserData] ${model.modelName}.deleteMany failed:`, e?.message || e)));
  const deleteOne = (model, filter) => tasks.push(model.deleteOne(filter).catch(e => console.warn(`[wipeUserData] ${model.modelName}.deleteOne failed:`, e?.message || e)));

  // Messaging
  deleteMany(MessageStatus, { user_id: uid });
  deleteMany(MessageReaction, { user_id: uid });
  try {
    // Delete message replies that reference this user's messages
    const userMessageIds = await Message.find({ user_id: uid }).distinct('id').catch(() => []);
    if (Array.isArray(userMessageIds) && userMessageIds.length) {
      tasks.push(
        MessageReply.deleteMany({
          $or: [
            { original_message_id: { $in: userMessageIds } },
            { reply_message_id: { $in: userMessageIds } }
          ]
        }).catch(e => console.warn('[wipeUserData] MessageReply.deleteMany failed:', e?.message || e))
      );
    }
  } catch (e) {
    console.warn('[wipeUserData] collect userMessageIds failed:', e?.message || e);
  }
  deleteMany(Message, { user_id: uid });

  // Bookings
  deleteMany(BookingSession, { user_id: uid });
  deleteMany(Appointment, { user_id: uid });
  deleteMany(Staff, { user_id: uid });
  deleteMany(Calendar, { user_id: uid });

  // Contacts and inbox
  deleteMany(ContactState, { user_id: uid });
  deleteMany(Customer, { user_id: uid });
  deleteMany(ContactTag, { user_id: uid });
  deleteMany(ContactInteraction, { user_id: uid });
  deleteMany(Handoff, { user_id: uid });

  // Knowledge base and onboarding/settings
  deleteMany(KBItem, { user_id: uid });
  deleteOne(OnboardingState, { user_id: uid });
  deleteOne(SettingsMulti, { user_id: uid });

  // Notifications, usage, plans, quick replies, AI requests
  deleteMany(Notification, { user_id: uid });
  deleteMany(UsageStats, { user_id: uid });
  deleteOne(UserPlan, { user_id: uid });
  deleteMany(QuickReply, { user_id: uid });
  deleteMany(AIRequest, { user_id: uid });

  await Promise.all(tasks);

  // Native collections not covered by Mongoose models
  try {
    const dbNative = getDB();
    await Promise.all([
      dbNative.collection('csat_ratings').deleteMany({ user_id: uid }).catch(() => {}),
      dbNative.collection('wa_templates').deleteMany({ user_id: uid }).catch(() => {})
    ]);
  } catch (e) {
    console.warn('[wipeUserData] native collections delete failed:', e?.message || e);
  }

  // Clear caches (best-effort)
  try { await redisCache.del(`user:${uid}`); } catch {}
  try { await redisCache.del(`kb:${uid}`); } catch {}
}

export default { wipeUserData };


