import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, renderTopbar, escapeHtml } from "../utils.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { getCurrentUsage, getUserPlan, getUsageHistory, getPlanPricing, updateUserPlan } from "../services/usage.mjs";
import { isStripeEnabled, getStripePublishableKey } from "../services/stripe.mjs";

export default function registerPlanRoutes(app) {
  app.get("/plan", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    
    // Get current usage and plan info
    const usage = await getCurrentUsage(userId);
    const plan = await getUserPlan(userId);
    const history = await getUsageHistory(userId, 6);
    const pricing = getPlanPricing();
    
    // Calculate usage percentage
    const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;
    const usagePercentage = plan.monthly_limit > 0 ? Math.round((totalMessages / plan.monthly_limit) * 100) : 0;
    
    // Get current plan details
    const currentPlanDetails = pricing[plan.plan_name] || pricing.free;
    const stripeEnabled = isStripeEnabled();
    const stripePublishableKey = getStripePublishableKey();
    
    // Format usage history for display
    const historyRows = (history || []).map(h => {
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
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <div class="container">
          ${renderTopbar('Plan & Usage', email)}
          <div class="layout">
            ${renderSidebar('plan', { showBookings: !!((await getSettingsForUser(userId))?.bookings_enabled) })}
            <main class="main">
              <div class="main-content">
                <section class="plan-card-shell">
                  <h2 style="margin:0 0 12px 0;">Current Plan: ${currentPlanDetails.name}</h2>
                  <div class="plan-stats-grid">
                    <div class="plan-stat ">
                      <div class="plan-stat-label">Monthly Messages</div>
                      <div class="plan-stat-value">${totalMessages} / ${plan.monthly_limit}</div>
                      <div class="plan-progress">
                        <div class="plan-progress-bar ${usagePercentage > 90 ? 'danger' : usagePercentage > 75 ? 'warning' : 'success'}" style="width:${Math.min(usagePercentage, 100)}%"></div>
                      </div>
                    </div>
                    <div class="plan-stat ">
                      <div class="plan-stat-label">WhatsApp Numbers</div>
                      <div class="plan-stat-value">1 / ${plan.whatsapp_numbers}</div>
                    </div>
                    <div class="plan-stat">
                      <div class="plan-stat-label">Plan Cost</div>
                      <div class="plan-stat-value">$${currentPlanDetails.price}/month</div>
                    </div>
                  </div>
                  ${usagePercentage > 90 ? `
                    <div class="alert alert-warning" style="margin-top:12px;">
                      <strong>Usage Warning</strong>
                      <div>You've used ${usagePercentage}% of your monthly limit. Consider upgrading to avoid interruptions.</div>
                    </div>
                  ` : ''}
                </section>
                <hr style="opacity:0.3;" />
                <section>
                  <h3>Usage Breakdown</h3>
                  <div class="plan-breakdown-grid">
                    <div class="plan-breakdown card">
                      <div class="plan-breakdown-label">Inbound</div>
                      <div class="plan-breakdown-value">${usage.inbound_messages}</div>
                      <div class="plan-breakdown-desc">Messages received</div>
                    </div>
                    <div class="plan-breakdown card">
                      <div class="plan-breakdown-label">Outbound</div>
                      <div class="plan-breakdown-value">${usage.outbound_messages}</div>
                      <div class="plan-breakdown-desc">Messages sent</div>
                    </div>
                    <div class="plan-breakdown card">
                      <div class="plan-breakdown-label">Templates</div>
                      <div class="plan-breakdown-value">${usage.template_messages}</div>
                      <div class="plan-breakdown-desc">Template messages</div>
                    </div>
                  </div>
                </section>
                <hr style="opacity:0.3;" />
                <section style="margin-top:12px; margin-bottom:12px;">
                  <h3>Usage History</h3>
                  <div class="table-responsive">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Month</th>
                          <th>Inbound</th>
                          <th>Outbound</th>
                          <th>Templates</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${historyRows || '<tr><td colspan="5" class="table-empty">No usage data yet</td></tr>'}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section class="card">
                  <h3>Available Plans</h3>
                  <div class="plans-grid">
                    ${Object.entries(pricing).map(([planKey, planDetails]) => `
                      <div class="plan-option ${plan.plan_name === planKey ? 'current' : ''}">
                        <div class="plan-option-head">
                          <h4>${planDetails.name}</h4>
                          ${plan.plan_name === planKey ? '<span class="badge-current">Current</span>' : ''}
                        </div>
                        <div class="plan-price">$${planDetails.price}<span class="plan-price-period">/month</span></div>
                        <ul class="plan-features">
                          ${planDetails.features.map(feature => `<li>✓ ${escapeHtml(feature)}</li>`).join('')}
                        </ul>
                        <div class="cta-row">
                          ${plan.plan_name !== planKey ? `
                            ${stripeEnabled && planKey !== 'free' ? `
                              <button class="btn-primary btn-full" onclick="subscribeToPlan('${planKey}')">Subscribe to ${planDetails.name}</button>
                            ` : `
                              <button class="btn-primary btn-full" onclick="upgradePlan('${planKey}')">${planKey === 'free' ? 'Downgrade' : 'Upgrade'} to ${planDetails.name}</button>
                            `}
                          ` : plan.plan_name === 'starter' && stripeEnabled ? `
                            <button class="btn-danger btn-full" onclick="cancelSubscription()">Cancel Subscription</button>
                          ` : ''}
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </section>
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
      await updateUserPlan(userId, {
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
