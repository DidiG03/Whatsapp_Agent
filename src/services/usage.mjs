/**
 * Usage tracking service for monitoring message counts and plan limits.
 */
import { db } from "../db.mjs";

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
export function getCurrentUsage(userId) {
  if (!userId) return null;
  
  const monthYear = getCurrentMonthYear();
  const usage = db.prepare(`
    SELECT * FROM usage_stats 
    WHERE user_id = ? AND month_year = ?
  `).get(userId, monthYear);
  
  if (!usage) {
    // Create new usage record for this month
    db.prepare(`
      INSERT INTO usage_stats (user_id, month_year, inbound_messages, outbound_messages, template_messages)
      VALUES (?, ?, 0, 0, 0)
    `).run(userId, monthYear);
    
    return {
      user_id: userId,
      month_year: monthYear,
      inbound_messages: 0,
      outbound_messages: 0,
      template_messages: 0,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000)
    };
  }
  
  return usage;
}

/**
 * Increment usage counter for a specific message type
 */
export function incrementUsage(userId, messageType) {
  if (!userId || !messageType) return;
  
  const monthYear = getCurrentMonthYear();
  const validTypes = ['inbound_messages', 'outbound_messages', 'template_messages'];
  
  if (!validTypes.includes(messageType)) {
    console.error(`Invalid message type: ${messageType}`);
    return;
  }
  
  // First ensure the record exists
  getCurrentUsage(userId);
  
  // Then increment the counter
  db.prepare(`
    UPDATE usage_stats 
    SET ${messageType} = ${messageType} + 1, updated_at = strftime('%s','now')
    WHERE user_id = ? AND month_year = ?
  `).run(userId, monthYear);
}

/**
 * Get user's plan information
 */
export function getUserPlan(userId) {
  if (!userId) return null;
  
  const plan = db.prepare(`
    SELECT * FROM user_plans WHERE user_id = ?
  `).get(userId);
  
  if (!plan) {
    // Create default free plan for new users
    db.prepare(`
      INSERT INTO user_plans (user_id, plan_name, status, monthly_limit, whatsapp_numbers, billing_cycle_start)
      VALUES (?, 'free', 'active', 100, 1, strftime('%s','now'))
    `).run(userId);
    
    return {
      user_id: userId,
      plan_name: 'free',
      status: 'active',
      monthly_limit: 100,
      whatsapp_numbers: 1,
      billing_cycle_start: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000)
    };
  }
  
  return plan;
}

/**
 * Update user's plan
 */
export function updateUserPlan(userId, planData) {
  if (!userId) return null;
  
  const current = getUserPlan(userId);
  const updated = {
    ...current,
    ...planData,
    updated_at: Math.floor(Date.now() / 1000)
  };
  
  db.prepare(`
    UPDATE user_plans 
    SET plan_name = ?, status = ?, monthly_limit = ?, whatsapp_numbers = ?, billing_cycle_start = ?, 
        stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = ?
    WHERE user_id = ?
  `).run(
    updated.plan_name,
    updated.status,
    updated.monthly_limit,
    updated.whatsapp_numbers,
    updated.billing_cycle_start,
    updated.stripe_customer_id || null,
    updated.stripe_subscription_id || null,
    updated.updated_at,
    userId
  );
  
  return updated;
}

/**
 * Check if user has exceeded their monthly limit
 */
export function isUsageExceeded(userId) {
  const usage = getCurrentUsage(userId);
  const plan = getUserPlan(userId);
  
  if (!usage || !plan) return false;
  
  const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;
  return totalMessages >= plan.monthly_limit;
}

/**
 * Get usage statistics for multiple months
 */
export function getUsageHistory(userId, months = 6) {
  if (!userId) return [];
  
  const history = db.prepare(`
    SELECT * FROM usage_stats 
    WHERE user_id = ? 
    ORDER BY month_year DESC 
    LIMIT ?
  `).all(userId, months);
  
  return history;
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
