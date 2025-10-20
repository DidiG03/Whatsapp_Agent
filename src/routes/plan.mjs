import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, renderTopbar, escapeHtml } from "../utils.mjs";
import { getCurrentUsage, getUserPlan, getUsageHistory, getPlanPricing, updateUserPlan } from "../services/usage.mjs";
import { isStripeEnabled, getStripePublishableKey } from "../services/stripe.mjs";

export default function registerPlanRoutes(app) {
  app.get("/plan", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    
    // Get current usage and plan info
    const usage = getCurrentUsage(userId);
    const plan = getUserPlan(userId);
    const history = getUsageHistory(userId, 6);
    const pricing = getPlanPricing();
    
    // Calculate usage percentage
    const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;
    const usagePercentage = plan.monthly_limit > 0 ? Math.round((totalMessages / plan.monthly_limit) * 100) : 0;
    
    // Get current plan details
    const currentPlanDetails = pricing[plan.plan_name] || pricing.free;
    const stripeEnabled = isStripeEnabled();
    const stripePublishableKey = getStripePublishableKey();
    
    // Format usage history for display
    const historyRows = history.map(h => {
      const total = h.inbound_messages + h.outbound_messages + h.template_messages;
      const date = new Date(h.month_year + '-01');
      return `
        <tr>
          <td>${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</td>
          <td>${h.inbound_messages}</td>
          <td>${h.outbound_messages}</td>
          <td>${h.template_messages}</td>
          <td><strong>${total}</strong></td>
        </tr>
      `;
    }).join('');
    
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>WhatsApp Agent - Plan & Usage</title><link rel="stylesheet" href="/styles.css"></head><body>
        <script src="/toast.js"></script>
        <script src="/notifications.js"></script>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <div class="container">
          ${renderTopbar('Plan & Usage', email)}
          <div class="layout">
            ${renderSidebar('plan')}
            <main class="main">
              <div class="main-content">
                <div class="card">
                <h2>Current Plan: ${currentPlanDetails.name}</h2>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 16px 0;">
                  <div class="usage-stat">
                    <div class="usage-stat-label">Monthly Messages</div>
                    <div class="usage-stat-value">${totalMessages} / ${plan.monthly_limit}</div>
                    <div class="usage-progress">
                      <div class="usage-progress-bar" style="width: ${Math.min(usagePercentage, 100)}%; background-color: ${usagePercentage > 90 ? '#ef4444' : usagePercentage > 75 ? '#f59e0b' : '#10b981'};"></div>
                    </div>
                  </div>
                  <div class="usage-stat">
                    <div class="usage-stat-label">WhatsApp Numbers</div>
                    <div class="usage-stat-value">1 / ${plan.whatsapp_numbers}</div>
                  </div>
                  <div class="usage-stat">
                    <div class="usage-stat-label">Plan Cost</div>
                    <div class="usage-stat-value">$${currentPlanDetails.price}/month</div>
                  </div>
                </div>
                
                ${usagePercentage > 90 ? `
                  <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; margin: 16px 0;">
                    <strong style="color: #dc2626;">⚠️ Usage Warning</strong>
                    <p style="margin: 4px 0 0 0; color: #991b1b;">You've used ${usagePercentage}% of your monthly limit. Consider upgrading your plan to avoid interruptions.</p>
                  </div>
                ` : ''}
              </div>
              
              <div class="card">
                <h3>Usage Breakdown</h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 16px 0;">
                  <div class="usage-breakdown">
                    <div class="usage-breakdown-label">Inbound</div>
                    <div class="usage-breakdown-value">${usage.inbound_messages}</div>
                    <div class="usage-breakdown-desc">Messages received</div>
                  </div>
                  <div class="usage-breakdown">
                    <div class="usage-breakdown-label">Outbound</div>
                    <div class="usage-breakdown-value">${usage.outbound_messages}</div>
                    <div class="usage-breakdown-desc">Messages sent</div>
                  </div>
                  <div class="usage-breakdown">
                    <div class="usage-breakdown-label">Templates</div>
                    <div class="usage-breakdown-value">${usage.template_messages}</div>
                    <div class="usage-breakdown-desc">Template messages</div>
                  </div>
                </div>
              </div>
              
              <div class="card">
                <h3>Usage History</h3>
                <div style="overflow-x: auto;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                      <tr style="background: #f9fafb;">
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb;">Month</th>
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb;">Inbound</th>
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb;">Outbound</th>
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb;">Templates</th>
                        <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb;">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${historyRows || '<tr><td colspan="5" style="padding: 16px; text-align: center; color: #6b7280;">No usage data yet</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
              
              <div class="card">
                <h3>Available Plans</h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin: 16px 0;">
                  ${Object.entries(pricing).map(([planKey, planDetails]) => `
                    <div class="plan-card ${plan.plan_name === planKey ? 'plan-current' : ''}" style="border: 2px solid ${plan.plan_name === planKey ? '#4f46e5' : '#e5e7eb'}; border-radius: 12px; padding: 20px; background: ${plan.plan_name === planKey ? '#f8faff' : 'white'};">
                      <div style="display: flex; justify-content: between; align-items: center; margin-bottom: 12px;">
                        <h4 style="margin: 0;">${planDetails.name}</h4>
                        ${plan.plan_name === planKey ? '<span style="background: #4f46e5; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Current</span>' : ''}
                      </div>
                      <div style="font-size: 24px; font-weight: bold; margin-bottom: 8px;">
                        $${planDetails.price}<span style="font-size: 14px; font-weight: normal; color: #6b7280;">/month</span>
                      </div>
                      <ul style="list-style: none; padding: 0; margin: 16px 0;">
                        ${planDetails.features.map(feature => `<li style="padding: 4px 0; color: #374151;">✓ ${escapeHtml(feature)}</li>`).join('')}
                      </ul>
                      ${plan.plan_name !== planKey ? `
                        ${stripeEnabled && planKey !== 'free' ? `
                          <button onclick="subscribeToPlan('${planKey}')" style="width: 100%; padding: 8px 16px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer;">
                            Subscribe to ${planDetails.name}
                          </button>
                        ` : `
                          <button onclick="upgradePlan('${planKey}')" style="width: 100%; padding: 8px 16px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer;">
                            ${planKey === 'free' ? 'Downgrade' : 'Upgrade'} to ${planDetails.name}
                          </button>
                        `}
                      ` : plan.plan_name === 'starter' && stripeEnabled ? `
                        <button onclick="cancelSubscription()" style="width: 100%; padding: 8px 16px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer;">
                          Cancel Subscription
                        </button>
                      ` : ''}
                    </div>
                  `).join('')}
                </div>
              </div>
            </main>
          </div>
        </div>
        
        <script${stripeEnabled ? ` src="https://js.stripe.com/v3/"` : ''}></script>
        <script>
          ${stripeEnabled ? `const stripe = Stripe('${stripePublishableKey}');` : ''}
          
          async function upgradePlan(planName) {
            if (!confirm('Are you sure you want to ' + (planName === 'free' ? 'downgrade' : 'upgrade') + ' to the ' + planName + ' plan?')) {
              return;
            }
            
            try {
              const response = await fetch('/plan/update', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ plan_name: planName })
              });
              
              if (response.ok) {
                location.reload();
              } else {
                const error = await response.text();
                alert('Failed to update plan: ' + error);
              }
            } catch (error) {
              alert('Error updating plan: ' + error.message);
            }
          }
          
          ${stripeEnabled ? `
          async function subscribeToPlan(planName) {
            try {
              const response = await fetch('/stripe/create-checkout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ plan_name: planName })
              });
              
              const data = await response.json();
              
              if (data.success) {
                if (data.checkout_url) {
                  // Redirect to Stripe Checkout
                  window.location.href = data.checkout_url;
                } else {
                  // Free plan upgrade
                  location.reload();
                }
              } else {
                alert('Failed to create checkout session: ' + (data.error || 'Unknown error'));
              }
            } catch (error) {
              alert('Error creating checkout session: ' + error.message);
            }
          }
          
          async function cancelSubscription() {
            if (!confirm('Are you sure you want to cancel your subscription? You will be downgraded to the Free plan.')) {
              return;
            }
            
            // Get subscription ID from the current plan data
            const subscriptionId = '${plan.stripe_subscription_id}';
            
            if (!subscriptionId) {
              alert('No active subscription found');
              return;
            }
            
            try {
              const response = await fetch('/stripe/cancel-subscription', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ subscription_id: subscriptionId })
              });
              
              const data = await response.json();
              
              if (data.success) {
                alert('Subscription canceled successfully. You have been downgraded to the Free plan.');
                location.reload();
              } else {
                alert('Failed to cancel subscription: ' + (data.error || 'Unknown error'));
              }
            } catch (error) {
              alert('Error canceling subscription: ' + error.message);
            }
          }
          ` : ''}
        </script>
        
        <style>
          .usage-stat {
            background: #f9fafb;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
          }
          
          .usage-stat-label {
            font-size: 14px;
            color: #6b7280;
            margin-bottom: 4px;
          }
          
          .usage-stat-value {
            font-size: 20px;
            font-weight: bold;
            color: #111827;
          }
          
          .usage-progress {
            width: 100%;
            height: 8px;
            background: #e5e7eb;
            border-radius: 4px;
            margin-top: 8px;
            overflow: hidden;
          }
          
          .usage-progress-bar {
            height: 100%;
            transition: width 0.3s ease;
          }
          
          .usage-breakdown {
            text-align: center;
            padding: 16px;
            background: #f9fafb;
            border-radius: 8px;
          }
          
          .usage-breakdown-label {
            font-size: 14px;
            color: #6b7280;
            margin-bottom: 4px;
          }
          
          .usage-breakdown-value {
            font-size: 24px;
            font-weight: bold;
            color: #111827;
            margin-bottom: 4px;
          }
          
          .usage-breakdown-desc {
            font-size: 12px;
            color: #6b7280;
          }
          
          .plan-card {
            transition: transform 0.2s ease, box-shadow 0.2s ease;
          }
          
          .plan-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          }
          
          .plan-current {
            position: relative;
          }
        </style>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });
  
  // Handle plan updates
  app.post("/plan/update", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { plan_name } = req.body;
    
    if (!plan_name || !['free', 'starter'].includes(plan_name)) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }
    
    try {
      const pricing = getPlanPricing();
      const planDetails = pricing[plan_name];
      
      if (!planDetails) {
        return res.status(400).json({ error: 'Plan not found' });
      }
      
      // Update user plan
      updateUserPlan(userId, {
        plan_name: plan_name,
        monthly_limit: planDetails.monthly_limit,
        whatsapp_numbers: planDetails.whatsapp_numbers,
        billing_cycle_start: Math.floor(Date.now() / 1000) // Reset billing cycle
      });
      
      res.json({ success: true, message: `Plan updated to ${planDetails.name}` });
    } catch (error) {
      console.error('Plan update error:', error);
      res.status(500).json({ error: 'Failed to update plan' });
    }
  });
}
