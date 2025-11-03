/**
 * Usage tracking service for monitoring message counts and plan limits.
 */
import { UsageStats, UserPlan } from "../schemas/mongodb.mjs";

/**
 * Get current month/year string in format "2024-01"
 */
function getCurrentMonthYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get or create usage stats for a user for the current month
 */
export async function getCurrentUsage(userId) {
  if (!userId) return null;
  const monthYear = getCurrentMonthYear();
  let usage = await UsageStats.findOne({ user_id: userId, month_year: monthYear }).lean();
  if (!usage) {
    const doc = await UsageStats.create({
      user_id: userId,
      month_year: monthYear,
      inbound_messages: 0,
      outbound_messages: 0,
      template_messages: 0
    });
    usage = {
      user_id: doc.user_id,
      month_year: doc.month_year,
      inbound_messages: doc.inbound_messages,
      outbound_messages: doc.outbound_messages,
      template_messages: doc.template_messages,
      created_at: Math.floor(new Date(doc.createdAt || Date.now()).getTime() / 1000),
      updated_at: Math.floor(new Date(doc.updatedAt || Date.now()).getTime() / 1000)
    };
  }
  return usage;
}

/**
 * Increment usage counter for a specific message type
 */
export async function incrementUsage(userId, messageType) {
  if (!userId || !messageType) return;
  const monthYear = getCurrentMonthYear();
  const validTypes = ['inbound_messages', 'outbound_messages', 'template_messages'];
  if (!validTypes.includes(messageType)) {
    console.error(`Invalid message type: ${messageType}`);
    return;
  }
  await UsageStats.updateOne(
    { user_id: userId, month_year: monthYear },
    { $inc: { [messageType]: 1 } },
    { upsert: true }
  );
}

/**
 * Get user's plan information
 */
export async function getUserPlan(userId) {
  if (!userId) return null;
  let plan = await UserPlan.findOne({ user_id: userId }).lean();
  if (!plan) {
    const doc = await UserPlan.create({
      user_id: userId,
      plan_name: 'free',
      status: 'active',
      monthly_limit: 100,
      whatsapp_numbers: 1,
      billing_cycle_start: Math.floor(Date.now() / 1000)
    });
    plan = doc.toObject();
  }
  return plan;
}

/**
 * Update user's plan
 */
export async function updateUserPlan(userId, planData) {
  if (!userId) return null;
  const current = await getUserPlan(userId);
  const updated = {
    ...current,
    ...planData,
    updated_at: Math.floor(Date.now() / 1000)
  };
  await UserPlan.findOneAndUpdate(
    { user_id: userId },
    { $set: {
      plan_name: updated.plan_name,
      status: updated.status,
      monthly_limit: updated.monthly_limit,
      whatsapp_numbers: updated.whatsapp_numbers,
      billing_cycle_start: updated.billing_cycle_start,
      stripe_customer_id: updated.stripe_customer_id || null,
      stripe_subscription_id: updated.stripe_subscription_id || null
    } },
    { upsert: true, new: true }
  );
  return updated;
}

/**
 * Check if user has exceeded their monthly limit
 */
export async function isUsageExceeded(userId) {
  const usage = await getCurrentUsage(userId);
  const plan = await getUserPlan(userId);
  if (!usage || !plan) return false;
  const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;
  return totalMessages >= plan.monthly_limit;
}

/**
 * Get usage statistics for multiple months
 */
export async function getUsageHistory(userId, months = 6) {
  if (!userId) return [];
  const rows = await UsageStats.find({ user_id: userId }).sort({ month_year: -1 }).limit(months).lean();
  return rows || [];
}

/**
 * Get plan pricing information
 */
export function getPlanPricing() {
  return {
    free: {
      name: 'Free',
      price: 0,
      monthly_limit: 100,
      whatsapp_numbers: 1,
      kb_docs_limit: 20,
      kb_chars_limit: 5 * 1024 * 1024, // ~5 MB of text
      features: [
        'Basic AI responses',
        'Email notifications',
        '1 WhatsApp number',
        'Community support'
      ]
    },
    starter: {
      name: 'Starter',
      price: 29,
      monthly_limit: 1000,
      whatsapp_numbers: 1,
      kb_docs_limit: 500,
      kb_chars_limit: 200 * 1024 * 1024, // ~200 MB of text
      features: [
        'Advanced AI customization',
        'Email + web notifications',
        'Calendar integration',
        'Basic analytics',
        'Priority support'
      ]
    }
  };
}
