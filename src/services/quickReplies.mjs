

import { QuickReply } from "../schemas/mongodb.mjs";
export async function getQuickReplies(userId) {
  try {
    const rows = await QuickReply.find({ user_id: userId }).sort({ category: 1, display_order: 1 }).lean();
    return rows.map(r => ({ id: String(r._id), text: r.text, category: r.category, display_order: r.display_order, created_at: Math.floor(new Date(r.createdAt || Date.now()).getTime() / 1000), updated_at: Math.floor(new Date(r.updatedAt || Date.now()).getTime() / 1000), usage_count: r.usage_count || 0 }));
  } catch (error) {
    console.error('Error getting quick replies:', error);
    return [];
  }
}
export async function getQuickReplyCategories(userId) {
  try {
    const rows = await QuickReply.aggregate([
      { $match: { user_id: userId, category: { $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    return rows.map(r => ({ category: r._id, count: r.count }));
  } catch (error) {
    console.error('Error getting quick reply categories:', error);
    return [];
  }
}
export async function createQuickReply(userId, text, category = 'General') {
  try {
    const maxOrderRow = await QuickReply.find({ user_id: userId, category }).sort({ display_order: -1 }).limit(1).lean();
    const maxOrder = maxOrderRow[0]?.display_order || 0;
    const doc = await QuickReply.create({ user_id: userId, text, category, display_order: maxOrder + 1 });
    return { success: true, id: String(doc._id) };
  } catch (error) {
    console.error('Error creating quick reply:', error);
    return { success: false, error: error.message };
  }
}
export async function updateQuickReply(userId, id, text, category) {
  try {
    const result = await QuickReply.findOneAndUpdate({ _id: id, user_id: userId }, { $set: { text, category } }, { new: true });
    return { success: !!result };
  } catch (error) {
    console.error('Error updating quick reply:', error);
    return { success: false, error: error.message };
  }
}
export async function deleteQuickReply(userId, id) {
  try {
    const result = await QuickReply.findOneAndDelete({ _id: id, user_id: userId });
    return { success: !!result };
  } catch (error) {
    console.error('Error deleting quick reply:', error);
    return { success: false, error: error.message };
  }
}
export async function reorderQuickReplies(userId, category, orderedIds) {
  try {
    const ops = orderedIds.map((id, index) => QuickReply.findOneAndUpdate({ _id: id, user_id: userId, category }, { $set: { display_order: index + 1 } }));
    await Promise.all(ops);
    return { success: true };
  } catch (error) {
    console.error('Error reordering quick replies:', error);
    return { success: false, error: error.message };
  }
}
