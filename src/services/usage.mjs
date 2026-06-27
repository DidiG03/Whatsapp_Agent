
import { UsageStats, UserPlan } from "../schemas/mongodb.mjs";
function getCurrentMonthYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
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
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0
    });
    usage = {
      user_id: doc.user_id,
      month_year: doc.month_year,
      inbound_messages: doc.inbound_messages,
      outbound_messages: doc.outbound_messages,
      template_messages: doc.template_messages,
      payg_charged_units: doc.payg_charged_units,
      payg_charged_cents: doc.payg_charged_cents,
      created_at: Math.floor(new Date(doc.createdAt || Date.now()).getTime() / 1000),
      updated_at: Math.floor(new Date(doc.updatedAt || Date.now()).getTime() / 1000)
    };
  }
  return usage;
}
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
  try {
    const plan = await getUserPlan(userId);
    if (plan?.payg_enabled) {
      const usage = await getCurrentUsage(userId);
      const total = (usage?.inbound_messages || 0) + (usage?.outbound_messages || 0) + (usage?.template_messages || 0);
      const monthlyLimit = Number(plan.monthly_limit) || 0;
      if (monthlyLimit > 0 && total > monthlyLimit) {
        await settleOutstandingPaygCharges(userId);
      }
    }
  } catch {}
}
export async function settleOutstandingPaygCharges(userId, opts = {}) {
  const plan = await getUserPlan(userId);
  if (!plan) {
    return { success: true, chargedUnits: 0, chargedCents: 0, remainingUnits: 0, remainingCents: 0 };
  }
  if (!plan.payg_enabled && !opts.allowWhenDisabled) {
    return { success: true, chargedUnits: 0, chargedCents: 0, remainingUnits: 0, remainingCents: 0 };
  }
  const out = await getCurrentMonthPaygOutstanding(userId);
  if (out.outstandingUnits <= 0) {
    return { success: true, chargedUnits: 0, chargedCents: 0, remainingUnits: 0, remainingCents: 0 };
  }
  const { chargePayAsYouGo } = await import("./stripe.mjs");
  const monthYear = getCurrentMonthYear();
  const rateCents = Math.max(1, Math.floor(Number(plan.payg_rate_cents ?? Number(process.env.PAYG_RATE_CENTS || 5))));

  if (opts.bulkCharge) {
    const bulkKey = opts.bulkIdempotencyKey || `payg_${String(userId)}_${monthYear}_bulk_${Number(out.chargedUnits) + Number(out.outstandingUnits)}`;
    const res = await chargePayAsYouGo(userId, Number(out.outstandingUnits), { idempotencyKey: bulkKey });
    if (!res?.charged) {
      return {
        success: false,
        chargedUnits: 0,
        chargedCents: 0,
        remainingUnits: out.outstandingUnits,
        remainingCents: out.outstandingCents,
        reason: res?.reason || "payment_failed",
      };
    }
    await recordPaygCharge(userId, Number(out.outstandingUnits), Number(out.outstandingCents));
    return {
      success: true,
      chargedUnits: out.outstandingUnits,
      chargedCents: out.outstandingCents,
      remainingUnits: 0,
      remainingCents: 0,
    };
  }

  let chargedUnits = 0;
  let chargedCents = 0;
  const firstUnit = Number(out.chargedUnits || 0) + 1;
  const lastUnit = Number(out.chargedUnits || 0) + Number(out.outstandingUnits);

  for (let unit = firstUnit; unit <= lastUnit; unit++) {
    const idKey = `payg_${String(userId)}_${monthYear}_unit_${unit}`;
    const res = await chargePayAsYouGo(userId, 1, { idempotencyKey: idKey });
    if (!res?.charged) {
      const remaining = await getCurrentMonthPaygOutstanding(userId);
      return {
        success: false,
        chargedUnits,
        chargedCents,
        remainingUnits: remaining.outstandingUnits,
        remainingCents: remaining.outstandingCents,
        reason: res?.reason || "payment_failed",
      };
    }
    const update = await UsageStats.updateOne(
      { user_id: userId, month_year: monthYear, payg_charged_units: { $lt: unit } },
      { $inc: { payg_charged_units: 1, payg_charged_cents: rateCents } }
    );
    if (Number(update?.modifiedCount || 0) > 0) {
      chargedUnits += 1;
      chargedCents += rateCents;
    }
  }

  const remaining = await getCurrentMonthPaygOutstanding(userId);
  return {
    success: remaining.outstandingUnits === 0,
    chargedUnits,
    chargedCents,
    remainingUnits: remaining.outstandingUnits,
    remainingCents: remaining.outstandingCents,
  };
}
export async function hasPaygBillingHold(userId) {
  const plan = await getUserPlan(userId);
  if (!plan?.payg_enabled) return false;
  const out = await getCurrentMonthPaygOutstanding(userId);
  return out.outstandingUnits > 0;
}
export async function getCurrentMonthPaygOutstanding(userId) {
  const usage = await getCurrentUsage(userId);
  const plan = await getUserPlan(userId);
  if (!usage || !plan) {
    return { overageUnits: 0, overageCents: 0, chargedUnits: 0, chargedCents: 0, outstandingUnits: 0, outstandingCents: 0 };
  }
  const totalMessages = (usage.inbound_messages || 0) + (usage.outbound_messages || 0) + (usage.template_messages || 0);
  const overageUnits = Math.max(0, totalMessages - (Number(plan.monthly_limit) || 0));
  const rateCents = Number(plan.payg_rate_cents ?? Number(process.env.PAYG_RATE_CENTS || 5));
  const overageCents = overageUnits * Math.max(1, Math.floor(rateCents));
  const chargedUnits = Number(usage.payg_charged_units || 0);
  const chargedCents = Number(usage.payg_charged_cents || 0);
  const outstandingUnits = Math.max(0, overageUnits - chargedUnits);
  const outstandingCents = Math.max(0, overageCents - chargedCents);
  return { overageUnits, overageCents, chargedUnits, chargedCents, outstandingUnits, outstandingCents };
}
export async function recordPaygCharge(userId, units, cents) {
  if (!userId || !units || !cents) return;
  await UsageStats.updateOne(
    { user_id: userId, month_year: getCurrentMonthYear() },
    { $inc: { payg_charged_units: Math.max(0, Number(units) || 0), payg_charged_cents: Math.max(0, Number(cents) || 0) } },
    { upsert: true }
  );
}
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
      stripe_subscription_id: updated.stripe_subscription_id || null,
      payg_enabled: !!updated.payg_enabled,
      payg_rate_cents: typeof updated.payg_rate_cents === 'number' ? updated.payg_rate_cents : (current.payg_rate_cents ?? Number(process.env.PAYG_RATE_CENTS || 5)),
      payg_currency: (updated.payg_currency || current.payg_currency || String(process.env.PAYG_CURRENCY || 'usd')).toLowerCase()
    } },
    { upsert: true, new: true }
  );
  return updated;
}
const SUBSCRIPTION_BLOCKED_STATUSES = new Set(["past_due", "unpaid"]);

export const MESSAGING_BLOCK_MESSAGES = {
  subscription_payment:
    "Your subscription payment failed. Please update your billing details on the Plan page.",
  usage_limit:
    "You have exceeded your monthly message limit. Please upgrade your plan or enable pay-as-you-go.",
};

export function isSubscriptionBillingBlocked(plan) {
  const status = String(plan?.status || "active").toLowerCase();
  return SUBSCRIPTION_BLOCKED_STATUSES.has(status);
}

async function isUsageLimitExceeded(userId, plan = null, usage = null) {
  const resolvedPlan = plan || (await getUserPlan(userId));
  const resolvedUsage = usage || (await getCurrentUsage(userId));
  if (!resolvedUsage || !resolvedPlan) return false;
  const totalMessages =
    (resolvedUsage.inbound_messages || 0) +
    (resolvedUsage.outbound_messages || 0) +
    (resolvedUsage.template_messages || 0);
  const monthlyLimit = Number(resolvedPlan.monthly_limit) || 0;
  if (!resolvedPlan?.payg_enabled) {
    return monthlyLimit > 0 && totalMessages >= monthlyLimit;
  }
  if (monthlyLimit > 0 && totalMessages > monthlyLimit) {
    const out = await getCurrentMonthPaygOutstanding(userId);
    return out.outstandingUnits > 0;
  }
  return false;
}

export async function getMessagingBlockReason(userId) {
  if (!userId) return null;
  const plan = await getUserPlan(userId);
  if (isSubscriptionBillingBlocked(plan)) return "subscription_payment";
  if (await isUsageLimitExceeded(userId, plan)) return "usage_limit";
  return null;
}

export async function getMessagingBlockMessage(userId) {
  const reason = await getMessagingBlockReason(userId);
  return reason ? MESSAGING_BLOCK_MESSAGES[reason] : null;
}

export function getMessagingBlockNoticeI18nKey(reason) {
  if (reason === "subscription_payment") return "messaging_unavailable_subscription";
  if (reason === "usage_limit") return "messaging_unavailable_limit";
  return "messaging_unavailable_limit";
}

export async function shouldNotifyCustomerMessagingBlocked(userId, contactId) {
  const cooldown = Math.max(
    60,
    parseInt(process.env.MESSAGING_BLOCK_NOTICE_COOLDOWN_SEC || "86400", 10)
  );
  try {
    const { getDB } = await import("../db-mongodb.mjs");
    const dbNative = getDB();
    const now = Math.floor(Date.now() / 1000);
    const st = await dbNative
      .collection("contact_state")
      .findOne(
        { user_id: String(userId), contact_id: String(contactId) },
        { projection: { last_messaging_block_notice_ts: 1 } }
      );
    const last = Number(st?.last_messaging_block_notice_ts || 0);
    if (last && now - last <= cooldown) return false;
    await dbNative.collection("contact_state").updateOne(
      { user_id: String(userId), contact_id: String(contactId) },
      {
        $set: { last_messaging_block_notice_ts: now, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    return true;
  } catch {
    return true;
  }
}

export async function isUsageExceeded(userId) {
  if (!userId) return false;
  const plan = await getUserPlan(userId);
  if (isSubscriptionBillingBlocked(plan)) return true;
  return isUsageLimitExceeded(userId, plan);
}
export async function getUsageHistory(userId, months = 6) {
  if (!userId) return [];
  const rows = await UsageStats.find({ user_id: userId }).sort({ month_year: -1 }).limit(months).lean();
  return rows || [];
}
export function getPlanPricing() {
  return {
    free: {
      name: 'Free',
      price: 0,
      monthly_limit: 100,
      whatsapp_numbers: 1,
      kb_docs_limit: 20,
      kb_chars_limit: 5 * 1024 * 1024,      features: [
        'Basic AI responses',
        'Email notifications',
        '1 WhatsApp number',
        'Community support'
      ]
    },
    starter: {
      name: 'Starter',
      price: 14,
      monthly_limit: 1000,
      whatsapp_numbers: 1,
      kb_docs_limit: 500,
      kb_chars_limit: 200 * 1024 * 1024,      features: [
        'Advanced AI customization',
        'Email + web notifications',
        'Calendar integration',
        'Basic analytics',
        'Priority support'
      ]
    }
  };
}

export function isPlanUpgraded(plan) {
  const name = String(plan?.plan_name || 'free').toLowerCase();
  return name !== 'free';
}

export async function getPlanStatus(userId) {
  if (!userId) {
    return { plan: null, isUpgraded: false };
  }
  const plan = await getUserPlan(userId);
  return { plan, isUpgraded: isPlanUpgraded(plan) };
}
