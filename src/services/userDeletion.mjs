
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
export async function wipeUserData(userId) {
  if (!userId) return;
  const uid = String(userId);
  const tasks = [];
  const deleteMany = (model, filter) => tasks.push(model.deleteMany(filter).catch(e => console.warn(`[wipeUserData] ${model.modelName}.deleteMany failed:`, e?.message || e)));
  const deleteOne = (model, filter) => tasks.push(model.deleteOne(filter).catch(e => console.warn(`[wipeUserData] ${model.modelName}.deleteOne failed:`, e?.message || e)));
  deleteMany(MessageStatus, { user_id: uid });
  deleteMany(MessageReaction, { user_id: uid });
  try {
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
  deleteMany(BookingSession, { user_id: uid });
  deleteMany(Appointment, { user_id: uid });
  deleteMany(Staff, { user_id: uid });
  deleteMany(Calendar, { user_id: uid });
  deleteMany(ContactState, { user_id: uid });
  deleteMany(Customer, { user_id: uid });
  deleteMany(ContactTag, { user_id: uid });
  deleteMany(ContactInteraction, { user_id: uid });
  deleteMany(Handoff, { user_id: uid });
  deleteMany(KBItem, { user_id: uid });
  deleteOne(OnboardingState, { user_id: uid });
  deleteOne(SettingsMulti, { user_id: uid });
  deleteMany(Notification, { user_id: uid });
  deleteMany(UsageStats, { user_id: uid });
  deleteOne(UserPlan, { user_id: uid });
  deleteMany(QuickReply, { user_id: uid });
  deleteMany(AIRequest, { user_id: uid });

  await Promise.all(tasks);
  try {
    const dbNative = getDB();
    await Promise.all([
      dbNative.collection('csat_ratings').deleteMany({ user_id: uid }).catch(() => {}),
      dbNative.collection('wa_templates').deleteMany({ user_id: uid }).catch(() => {})
    ]);
  } catch (e) {
    console.warn('[wipeUserData] native collections delete failed:', e?.message || e);
  }
  try { await redisCache.del(`user:${uid}`); } catch {}
  try { await redisCache.del(`kb:${uid}`); } catch {}
}

export default { wipeUserData };

