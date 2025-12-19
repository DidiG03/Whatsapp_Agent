import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, renderTopbar, escapeHtml, getVercelWebAnalyticsSnippet } from "../utils.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { getCurrentUsage, getUserPlan, getUsageHistory, getPlanPricing, updateUserPlan, isPlanUpgraded, getCurrentMonthPaygOutstanding, recordPaygCharge } from "../services/usage.mjs";
import { isStripeEnabled, getStripePublishableKey, getSubscription, getSubscriptionScheduleForSubscription, ensureCustomerForUser, createPayAsYouGoSetupSession, hasDefaultPaymentMethod, chargePayAsYouGo } from "../services/stripe.mjs";

export default function registerPlanRoutes(app) {
  app.get("/plan", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    
    // Get current usage and plan info
    const [usage, plan, settings] = await Promise.all([
      getCurrentUsage(userId),
      getUserPlan(userId),
      getSettingsForUser(userId)
    ]);
    const history = await getUsageHistory(userId, 6);
    const pricing = getPlanPricing();
    const isUpgraded = isPlanUpgraded(plan);
    
    // Calculate usage percentage
    const totalMessages = usage.inbound_messages + usage.outbound_messages + usage.template_messages;
    const usagePercentage = plan.monthly_limit > 0 ? Math.round((totalMessages / plan.monthly_limit) * 100) : 0;
    
    // Get current plan details
    const currentPlanDetails = pricing[plan.plan_name] || pricing.free;
    const stripeEnabled = isStripeEnabled();
    const stripePublishableKey = getStripePublishableKey();
    const paygEnabled = !!plan?.payg_enabled;
    const paygRateCents = Number(plan?.payg_rate_cents ?? (process.env.PAYG_RATE_CENTS || 5));
    const paygCurrency = String(plan?.payg_currency || process.env.PAYG_CURRENCY || 'usd').toLowerCase();
    // Prepare a safe currency code and formatted PAYG price text for display
    let paygCurrencyCode = 'USD';
    try {
      const c = (paygCurrency || 'usd').toUpperCase();
      if (/^[A-Z]{3}$/.test(c)) paygCurrencyCode = c;
    } catch {}
    let paygPriceText = `$${(paygRateCents/100).toFixed(2)}`;
    try {
      paygPriceText = new Intl.NumberFormat('en-US', { style: 'currency', currency: paygCurrencyCode }).format(paygRateCents / 100);
    } catch {}
    let currentPaidInterval = null;
    let scheduledTargetInterval = null;
    let scheduledStartTs = null;
    let willCancelAtEnd = false;
    let cancelAtTs = null;
    if (stripeEnabled && plan?.stripe_subscription_id) {
      try {
        const sub = await getSubscription(plan.stripe_subscription_id);
        currentPaidInterval = sub?.items?.data?.[0]?.price?.recurring?.interval || null;
        if (sub?.cancel_at_period_end) {
          willCancelAtEnd = true;
          cancelAtTs = Number(sub?.current_period_end || 0) || null;
        }
        try {
          const schedule = await getSubscriptionScheduleForSubscription(plan.stripe_subscription_id);
          if (schedule && Array.isArray(schedule.phases)) {
            const now = Math.floor(Date.now()/1000);
            const next = schedule.phases.find(p => Number(p.start_date || 0) > now);
            if (next) {
              const interval = (next.items?.[0]?.price?.recurring?.interval) || null;
              scheduledTargetInterval = interval || null;
              scheduledStartTs = Number(next.start_date || 0) || null;
            } else if (String(schedule.end_behavior || '') === 'cancel') {
              // No next phase, but schedule is set to cancel at end of current phase
              const currentPhase = schedule.phases.find(p => !p.end_date || Number(p.end_date) > now) || schedule.phases[0];
              if (currentPhase?.end_date) {
                willCancelAtEnd = true;
                cancelAtTs = Number(currentPhase.end_date || 0) || cancelAtTs;
              }
            }
          }
        } catch {}
      } catch {}
    }
    const isStarterCurrentMonthly = (plan.plan_name === 'starter') && (currentPaidInterval !== 'year');
    const isStarterCurrentYearly = (plan.plan_name === 'starter') && (currentPaidInterval === 'year');
    // currentPaidInterval already set above
    
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
    const STARTER_YEARLY_PRICE_ID = (process.env.STRIPE_PRICE_ID_STARTER_YEARLY || process.env.STRIPE_PRICE_ID_STARTER_ANNUAL || process.env.STRIPE_PRICE_ID_STARTER_YEAR || '').toString();
    // Prefer real Stripe Price for monthly too so coupons restricted to a product/price can apply
    const STARTER_MONTHLY_PRICE_ID = (process.env.STRIPE_PRICE_ID_STARTER_MONTHLY || process.env.STRIPE_PRICE_ID_STARTER || process.env.STRIPE_PRICE_ID_STARTER_MONTH || process.env.STRIPE_PRICE_ID || '').toString();
    // PAYG outstanding and progress vs plan cost
    const paygSummary = await getCurrentMonthPaygOutstanding(userId).catch(()=>({ overageUnits:0, overageCents:0, chargedUnits:0, chargedCents:0, outstandingUnits:0, outstandingCents:0 }));
    const paygTotalCents = Number(paygSummary?.overageCents || 0);
    const paygChargedCents = Number(paygSummary?.chargedCents || 0);
    const paygOutstandingCents = Math.max(0, paygTotalCents - paygChargedCents);
    const planMonthlyPriceDollars = Number((currentPlanDetails?.price || 0));
    const paygPercentOfPlan = planMonthlyPriceDollars > 0 ? Math.min(100, Math.round((paygTotalCents / (planMonthlyPriceDollars * 100)) * 100)) : 0;
    const paygTotalFormatted = (()=>{ try { return new Intl.NumberFormat('en-US',{style:'currency', currency: paygCurrencyCode}).format(paygTotalCents/100); } catch { return `$${(paygTotalCents/100).toFixed(2)}`; } })();
    const paygOutstandingFormatted = (()=>{ try { return new Intl.NumberFormat('en-US',{style:'currency', currency: paygCurrencyCode}).format(paygOutstandingCents/100); } catch { return `$${(paygOutstandingCents/100).toFixed(2)}`; } })();
    res.end(`
      <html><head><title>WhatsApp Agent - Plan & Usage</title><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}</head><body>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{
              const r=await fetch('/auth/status',{credentials:'include', headers:{'Accept':'application/json'}});
              const j=await r.json();
              if(j && j.signedIn === false){ window.location='/auth'; return; }
            }catch(e){
              // Don't force a relogin on transient network/auth-status failures.
              console.warn('Auth status check failed (non-fatal):', e);
            }
          })();
        </script>
        <div class="container">
          ${renderTopbar('Plan & Usage', email)}
          <div class="layout">
            ${renderSidebar('plan', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="main-content">
                <div id="appModal" class="day-modal" style="display:flex;">
                  <div class="day-modal-overlay" onclick="Modal.close()"></div>
                  <div class="day-modal-content" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
                    <div class="day-modal-header">
                      <h3 id="modalTitle">Confirm</h3>
                      <button class="day-modal-close" onclick="Modal.close()" aria-label="Close">×</button>
                    </div>
                    <div class="day-modal-body">
                      <div id="modalMessage">Are you sure?</div>
                      <div id="modalButtons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end;">
                        <button id="modalCancel" class="btn btn-ghost">Cancel</button>
                        <button id="modalOk" class="btn btn-primary">OK</button>
                      </div>
                    </div>
                  </div>
                </div>
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
                <section class="card" style="margin-top:12px;">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                    <div>
                      <h3 style="margin:0;">Pay-as-you-go</h3>
                      <div class="small" style="color:#6b7280; margin-top:4px;">
                        Continue sending/receiving after your monthly limit of ${plan.monthly_limit} messages.
                        ${stripeEnabled ? `Charges are ${escapeHtml(paygPriceText)} per message over the limit.` : `Stripe is not configured on this deployment.`}
                      </div>
                      <div style="margin-top:8px;">
                        <div class="small" style="color:#374151;">This month: ${escapeHtml(paygTotalFormatted)} total (${paygPercentOfPlan}% of your monthly fee)</div>
                        <div class="plan-progress" style="margin-top:6px;">
                          <div class="plan-progress-bar ${paygPercentOfPlan > 90 ? 'danger' : paygPercentOfPlan > 75 ? 'warning' : 'success'}" style="width:${paygPercentOfPlan}%"></div>
                        </div>
                        ${paygOutstandingCents > 0 ? `
                          <div class="small" style="margin-top:6px; color:#92400e; background:#fef3c7; display:inline-block; padding:2px 8px; border-radius:9999px; border:1px solid #fcd34d;">
                            Outstanding not yet charged: ${escapeHtml(paygOutstandingFormatted)}
                          </div>
                        ` : ``}
                      </div>
                    </div>
                    <div>
                      <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer;">
                        <span style="font-size:12px; color:#374151;">${paygEnabled ? 'Enabled' : 'Disabled'}</span>
                        <input id="paygToggle" type="checkbox" ${paygEnabled ? 'checked' : ''} ${stripeEnabled ? '' : 'disabled'} style="width:36px; height:20px; accent-color:#111827;" />
                      </label>
                    </div>
                  </div>
                  ${(!paygEnabled && usagePercentage >= 100) ? `
                    <div class="alert alert-warning" style="margin-top:12px;">
                      <strong>You reached the Free plan limit.</strong>
                      <div>Enable pay-as-you-go to continue service without upgrading plans.</div>
                    </div>
                  ` : ''}
                  ${paygEnabled ? `
                    <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
                      <button class="btn btn-ghost" onclick="managePaygPaymentMethod()">Manage payment method</button>
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
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px;">
                    <h3 style="margin:0;">Available Plans</h3>
                    <div style="display:inline-flex; border:1px solid var(--border); border-radius:9999px; overflow:hidden;">
                      <button id="billMonthly" type="button" style="padding:6px 12px; font-size:12px; border:none; background:#111827; color:#fff; cursor:pointer;">Monthly</button>
                      <button id="billYearly" type="button" style="padding:6px 12px; font-size:12px; border:none; background:transparent; color:#111827; cursor:pointer;">Yearly</button>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:8px; margin:8px 0 16px;">
                    <input id="promoCodeInput" class="settings-field" placeholder="Promo code (optional)" style="max-width:200px;" />
                    <span style="font-size:12px; color:#6b7280;">Coupons will be applied in Stripe Checkout</span>
                  </div>
                  <div class="plans-grid">
                    ${Object.entries(pricing).map(([planKey, planDetails]) => `
                      <div class="plan-option ${plan.plan_name === planKey ? 'current' : ''}">
                        <div class="plan-option-head">
                          <h4>${planDetails.name}</h4>
                          ${plan.plan_name === planKey ? (
                            planKey === 'starter'
                              ? `
                                ${isStarterCurrentMonthly ? '<span class="badge-current badge-monthly">Current</span>' : ''}
                                ${isStarterCurrentYearly ? '<span class="badge-current badge-yearly">Current</span>' : ''}
                              `
                              : '<span class="badge-current">Current</span>'
                          ) : ''}
                        </div>
                        <div class="plan-price">
                          <span class="price-monthly" style="display:inline;">
                            $${planDetails.price}<span class="plan-price-period">/month</span>
                          </span>
                          <span class="price-yearly" style="display:none;">
                            ${planKey === 'starter' ? `
                              <div style="display:flex; align-items:center; gap:8px;">
                                <span style="text-decoration:line-through; color:#9ca3af;">$348</span>
                                <strong style="font-size:18px;">$299</strong><span class="plan-price-period">/year</span>
                                <span style="background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; border-radius:9999px; padding:2px 8px; font-size:11px; font-weight:600;">Discounted</span>
                              </div>
                            ` : `
                              $0<span class="plan-price-period">/year</span>
                            `}
                          </span>
                          ${plan.plan_name === 'starter' && planKey === 'starter' && scheduledTargetInterval ? `
                            <div class="small" style="margin-top:4px; color:#065f46; background:#ecfdf5; display:inline-block; padding:2px 8px; border-radius:9999px; border:1px solid #a7f3d0;">
                              Switching on ${scheduledStartTs ? new Date(scheduledStartTs * 1000).toLocaleString() : ''}
                            </div>
                          ` : ``}
                          ${plan.plan_name === 'starter' && planKey === 'starter' && willCancelAtEnd ? `
                            ${
                              currentPaidInterval === 'year'
                                ? `<div class="small cancel-yearly" style="margin-top:4px; color:#b45309; background:#fffbeb; display:inline-block; padding:2px 8px; border-radius:9999px; border:1px solid #fcd34d;">
                                    Subscription will cancel on ${cancelAtTs ? new Date(cancelAtTs * 1000).toLocaleString() : ''}
                                   </div>`
                                : `<div class="small cancel-monthly" style="margin-top:4px; color:#b45309; background:#fffbeb; display:inline-block; padding:2px 8px; border-radius:9999px; border:1px solid #fcd34d;">
                                    Subscription will cancel on ${cancelAtTs ? new Date(cancelAtTs * 1000).toLocaleString() : ''}
                                   </div>`
                            }
                          ` : ``}
                        </div>
                        <ul class="plan-features">
                          ${planDetails.features.map(feature => `<li>✓ ${escapeHtml(feature)}</li>`).join('')}
                        </ul>
                        <div class="cta-row">
                          ${plan.plan_name !== planKey ? `
                            ${stripeEnabled && planKey !== 'free' ? `
                              <button class="btn btn-primary btn-full" onclick="subscribeToPlan('${planKey}')">
                                <span class="cta-monthly">Subscribe to ${planDetails.name}</span>
                                <span class="cta-yearly" style="display:none;">Subscribe to ${planKey === 'starter' ? 'Starter Yearly' : planDetails.name}</span>
                              </button>
                            ` : `
                              <button class="btn-primary btn-full" onclick="upgradePlan('${planKey}')">
                                <span class="cta-monthly">${planKey === 'free' ? 'Downgrade' : 'Upgrade'} to ${planDetails.name}</span>
                                <span class="cta-yearly" style="display:none;">${planKey === 'free' ? 'Downgrade' : 'Upgrade'} to ${planKey === 'starter' ? 'Starter Yearly' : planDetails.name}</span>
                              </button>
                            `}
                          ` : plan.plan_name === 'starter' && stripeEnabled ? `
                            ${
                              scheduledTargetInterval
                                ? `<button class="btn-danger btn-full" onclick="cancelScheduledChange()">Cancel Scheduled Change</button>`
                                : (currentPaidInterval === 'year'
                                    ? `
                                      <button class="btn btn-primary btn-full cta-monthly" onclick="schedulePlanChange('starter','month')">Switch to Starter Monthly</button>
                                      ${willCancelAtEnd
                                        ? `<button class="btn btn-primary btn-full cta-yearly" style="display:none;" onclick="resumeSubscription()">Resume Subscription</button>`
                                        : `<button class="btn btn-danger btn-full cta-yearly" style="display:none;" onclick="cancelSubscription()">Cancel Subscription</button>`}
                                    `
                                    : `
                                      ${willCancelAtEnd
                                        ? `<button class="btn btn-primary btn-full cta-monthly" onclick="resumeSubscription()">Resume Subscription</button>`
                                        : `<button class="btn btn-danger btn-full cta-monthly" onclick="cancelSubscription()">Cancel Subscription</button>`}
                                      <button class="btn-primary btn-full cta-yearly" style="display:none;" onclick="schedulePlanChange('starter','year')">Switch to Starter Yearly</button>
                                    `
                                  )
                            }
                            ${plan.plan_name === 'starter' ? `
                              <button class="btn-ghost btn-full" onclick="managePaymentMethod()" style="margin-top:8px;">Manage Payment Method</button>
                            ` : ``}
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
          const STARTER_YEARLY_PRICE_ID = '${escapeHtml(STARTER_YEARLY_PRICE_ID)}';
          const STARTER_MONTHLY_PRICE_ID = '${escapeHtml(STARTER_MONTHLY_PRICE_ID)}';
          const CURRENT_INTERVAL = '${escapeHtml(currentPaidInterval || '')}';
          const SCHEDULED_TARGET_INTERVAL = '${escapeHtml(scheduledTargetInterval || '')}';
          const SCHEDULED_START_TS = ${scheduledStartTs ? Number(scheduledStartTs) : 'null'};
          const PAYG_ENABLED = ${paygEnabled ? 'true' : 'false'};
          const STRIPE_ENABLED = ${stripeEnabled ? 'true' : 'false'};
          
          // Lightweight modal helper
          const Modal = (function(){
            let resolver = null;
            const root = document.getElementById('appModal');
            const titleEl = root.querySelector('#modalTitle');
            const msgEl = root.querySelector('#modalMessage');
            const okBtn = root.querySelector('#modalOk');
            const cancelBtn = root.querySelector('#modalCancel');
            function hide(){ root.classList.remove('show'); setTimeout(()=>{ root.style.visibility='hidden'; root.style.opacity='0'; }, 0); }
            function show(){ root.style.visibility='visible'; root.style.opacity='1'; root.classList.add('show'); }
            function close(){ if (resolver){ resolver(null); } hide(); }
            function confirm(opts={}){
              return new Promise((resolve)=>{
                resolver = resolve;
                titleEl.textContent = opts.title || 'Confirm';
                msgEl.innerHTML = opts.message || '';
                okBtn.textContent = opts.okText || 'OK';
                cancelBtn.style.display = '';
                cancelBtn.textContent = opts.cancelText || 'Cancel';
                okBtn.onclick = ()=>{ hide(); resolve(true); };
                cancelBtn.onclick = ()=>{ hide(); resolve(false); };
                show();
              });
            }
            function alert(opts={}){
              return new Promise((resolve)=>{
                resolver = resolve;
                titleEl.textContent = opts.title || 'Notice';
                msgEl.innerHTML = opts.message || '';
                okBtn.textContent = opts.okText || 'OK';
                cancelBtn.style.display = 'none';
                okBtn.onclick = ()=>{ hide(); resolve(true); };
                show();
              });
            }
            return { confirm, alert, close };
          })();
          
          // Handle Stripe return query params gracefully
          (function handleStripeReturn(){
            try {
              const p = new URLSearchParams(window.location.search || '');
              const canceled = p.get('canceled');
              const error = p.get('error');
              const success = p.get('success');
              let title = null, message = null;
              if (canceled === 'true') {
                title = 'Checkout Canceled';
                message = 'You canceled the payment or navigated back. Your current plan is unchanged. You can try again anytime.';
              } else if (error === 'payment_not_completed') {
                title = 'Payment Not Completed';
                message = 'We didn’t receive a completed payment. Your plan is unchanged. Please try again or use a different payment method.';
              } else if (error === 'processing_failed') {
                title = 'Processing Error';
                message = 'We encountered a temporary issue processing your payment. Please try again. If the issue persists, contact support.';
              } else if (error === 'no_session_id') {
                title = 'Session Not Found';
                message = 'We could not verify your checkout session. Please try again.';
              } else if (success === 'true') {
                // Optional: soft success notice
                title = null;
              }
              if (title) {
                Modal.alert({ title, message }).then(function(){
                  try { history.replaceState({}, document.title, location.pathname); } catch {}
                });
              } else {
                try { history.replaceState({}, document.title, location.pathname); } catch {}
              }
            } catch {}
          })();
          
          // Billing toggle logic (Monthly <-> Yearly)
          (function initBillingToggle(){
            var monthlyBtn = document.getElementById('billMonthly');
            var yearlyBtn = document.getElementById('billYearly');
            function setMode(mode){
              var isYearly = mode === 'yearly';
              document.querySelectorAll('.price-monthly').forEach(function(el){ el.style.display = isYearly ? 'none' : 'inline'; });
              document.querySelectorAll('.price-yearly').forEach(function(el){ el.style.display = isYearly ? 'inline' : 'none'; });
              document.querySelectorAll('.cta-monthly').forEach(function(el){ el.style.display = isYearly ? 'none' : 'inline'; });
              document.querySelectorAll('.cta-yearly').forEach(function(el){ el.style.display = isYearly ? 'inline' : 'none'; });
              document.querySelectorAll('.badge-monthly').forEach(function(el){ el.style.display = isYearly ? 'none' : 'inline-block'; });
              document.querySelectorAll('.badge-yearly').forEach(function(el){ el.style.display = isYearly ? 'inline-block' : 'none'; });
              document.querySelectorAll('.cancel-monthly').forEach(function(el){ el.style.display = isYearly ? 'none' : 'inline-block'; });
              document.querySelectorAll('.cancel-yearly').forEach(function(el){ el.style.display = isYearly ? 'inline-block' : 'none'; });
              if (monthlyBtn && yearlyBtn) {
                monthlyBtn.style.background = isYearly ? 'transparent' : '#111827';
                monthlyBtn.style.color = isYearly ? '#111827' : '#ffffff';
                yearlyBtn.style.background = isYearly ? '#111827' : 'transparent';
                yearlyBtn.style.color = isYearly ? '#ffffff' : '#111827';
              }
              try { localStorage.setItem('billingMode', isYearly ? 'yearly' : 'monthly'); } catch (e) {}
            }
            if (monthlyBtn) monthlyBtn.addEventListener('click', function(){ setMode('monthly'); });
            if (yearlyBtn) yearlyBtn.addEventListener('click', function(){ setMode('yearly'); });
            var saved = null; try { saved = localStorage.getItem('billingMode'); } catch(e) {}
            setMode(saved === 'yearly' ? 'yearly' : 'monthly');
          })();
          
          // PAYG toggle logic
          (function initPaygToggle(){
            var toggle = document.getElementById('paygToggle');
            if (!toggle) return;
            toggle.addEventListener('change', async function(){
              var enabled = !!toggle.checked;
              try {
                const r = await fetch('/plan/payg', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled })
                });
                const j = await r.json().catch(()=>({}));
                if (!r.ok || !j?.success) {
                  await Modal.alert({ title: 'Error', message: j?.error || 'Failed to update PAYG setting' });
                  toggle.checked = !enabled;
                  return;
                }
                if (enabled && STRIPE_ENABLED && j?.needs_setup) {
                  const ok = await Modal.confirm({
                    title: 'Add Payment Method',
                    message: 'To charge per usage, please add a payment method now.',
                    okText: 'Continue'
                  });
                  if (ok) {
                    try {
                      const r2 = await fetch('/plan/payg/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                      const j2 = await r2.json().catch(()=>({}));
                      if (j2?.url) { window.location.href = j2.url; return; }
                      await Modal.alert({ title: 'Setup Failed', message: j2?.error || 'Unable to start payment method setup.' });
                    } catch (e) {
                      await Modal.alert({ title: 'Error', message: e?.message || String(e) });
                    }
                  }
                  // Keep toggle OFF until setup completes
                  toggle.checked = false;
                  return;
                }
                // Reflect server's final state
                if (j?.enabled === true) {
                  toggle.checked = true;
                  await Modal.alert({ title: 'PAYG Enabled', message: 'Pay-as-you-go has been enabled.' });
                } else {
                  toggle.checked = false;
                  await Modal.alert({ title: 'PAYG Disabled', message: 'Pay-as-you-go has been disabled.' });
                }
                try { location.reload(); } catch {}
              } catch (e) {
                await Modal.alert({ title: 'Error', message: e?.message || String(e) });
                toggle.checked = !enabled;
              }
            });
          })();

          async function managePaygPaymentMethod() {
            try {
              const r = await fetch('/stripe/customer-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
              const j = await r.json().catch(()=>({}));
              if (r.ok && j?.url) {
                window.location.href = j.url; return;
              }
              // If no customer exists, fall back to setup flow
              const ok = await Modal.confirm({
                title: 'Add Payment Method',
                message: (j?.error || 'No payment method found.') + '<br/>Add one now to enable PAYG charges.',
                okText: 'Continue'
              });
              if (ok) {
                const s = await fetch('/plan/payg/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                const sj = await s.json().catch(()=>({}));
                if (sj?.url) { window.location.href = sj.url; return; }
                await Modal.alert({ title: 'Setup Failed', message: sj?.error || 'Unable to start payment method setup.' });
              }
            } catch (e) {
              await Modal.alert({ title: 'Error', message: e?.message || String(e) });
            }
          }

          async function upgradePlan(planName) {
            const ok = await Modal.confirm({ 
              title: (planName === 'free' ? 'Confirm Downgrade' : 'Confirm Upgrade'),
              message: 'Are you sure you want to ' + (planName === 'free' ? 'downgrade' : 'upgrade') + ' to the <strong>' + planName + '</strong> plan?',
              okText: (planName === 'free' ? 'Downgrade' : 'Upgrade')
            });
            if (!ok) return;
            
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
                let data = null; 
                try { data = await response.json(); } catch { }
                if (response.status === 409 && data?.requires_cancel_at_period_end && data?.subscription_id && planName === 'free') {
                  // Auto-initiate cancel-at-period-end so free takes effect after the current period
                  const ok2 = await Modal.confirm({
                    title: 'Schedule Downgrade',
                    message: 'You have an active subscription. We can stop auto-renew now so your plan switches to Free at period end. Proceed?',
                    okText: 'Stop auto-renew'
                  });
                  if (ok2) {
                    try {
                      const r2 = await fetch('/stripe/cancel-subscription', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ subscription_id: data.subscription_id })
                      });
                      const j2 = await r2.json();
                      if (j2?.success) {
                        var endText = '';
                        if (j2.current_period_end) {
                          try { 
                            var d = new Date((Number(j2.current_period_end)||0)*1000);
                            endText = '\\nAccess remains until: ' + d.toLocaleString();
                          } catch(e) {}
                        }
                        await Modal.alert({
                          title: 'Auto-renew Disabled',
                          message: 'Free plan will take effect after the current period.' + (endText ? '<br/>' + endText : '')
                        });
                        location.reload();
                      } else {
                        await Modal.alert({ title: 'Error', message: 'Failed to schedule downgrade: ' + (j2?.error || 'Unknown error') });
                      }
                    } catch (e) {
                      await Modal.alert({ title: 'Error', message: 'Failed to schedule downgrade: ' + (e?.message || e) });
                    }
                  }
                } else {
                  const msg = (data && (data.error || data.message)) || ('Failed to update plan: ' + (await response.text()));
                  await Modal.alert({ title: 'Plan Update Failed', message: msg });
                }
              }
            } catch (error) {
              await Modal.alert({ title: 'Error', message: 'Error updating plan: ' + error.message });
            }
          }
          
          ${stripeEnabled ? `
          async function subscribeToPlan(planName) {
            try {
              // Use yearly price when yearly toggle is active and plan is starter
              var mode = null; try { mode = localStorage.getItem('billingMode'); } catch(e) {}
              var price_id = null;
              if (planName === 'starter') {
                if (mode === 'yearly' && STARTER_YEARLY_PRICE_ID) {
                  price_id = STARTER_YEARLY_PRICE_ID;
                } else if (STARTER_MONTHLY_PRICE_ID) {
                  // Prefer a real Price for monthly when available so promo codes restricted by product/price apply
                  price_id = STARTER_MONTHLY_PRICE_ID;
                }
              }
              const response = await fetch('/stripe/create-checkout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                  plan_name: planName, 
                  price_id: price_id || undefined,
                  promo_code: (document.getElementById('promoCodeInput')?.value || '').trim() || undefined
                })
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
                if (response.status === 409) {
                  var endAt = '';
                  if (data.current_period_end) {
                    try { 
                      var d = new Date((Number(data.current_period_end)||0)*1000);
                      endAt = '\\nCurrent period ends: ' + d.toLocaleString();
                    } catch(e){}
                  }
                  await Modal.alert({
                    title: 'Plan Change Not Allowed',
                    message: 'Plan change is only allowed after your current period ends.' + (endAt ? '<br/>' + endAt : '')
                  });
                } else {
                  await Modal.alert({
                    title: 'Checkout Failed',
                    message: 'Failed to create checkout session: ' + (data.error || 'Unknown error')
                  });
                }
              }
            } catch (error) {
              await Modal.alert({ title: 'Error', message: 'Error creating checkout session: ' + error.message });
            }
          }
          
          async function schedulePlanChange(planName, targetInterval) {
            const ok = await Modal.confirm({
              title: 'Schedule Plan Change',
              message: 'The new billing interval will start after your current period ends. No immediate charges will occur.',
              okText: 'Schedule'
            });
            if (!ok) return;
            try {
              const resp = await fetch('/stripe/schedule-plan-change', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_name: planName, target_interval: targetInterval })
              });
              const data = await resp.json().catch(()=>({}));
              if (!resp.ok || !data?.success) {
                await Modal.alert({ title: 'Scheduling Failed', message: data?.error || 'Unable to schedule plan change.' });
                return;
              }
              var endAt = '';
              if (data.current_period_end) {
                try { 
                  var d = new Date((Number(data.current_period_end)||0)*1000);
                  endAt = 'Your current period ends on: ' + d.toLocaleString();
                } catch(e){}
              }
              await Modal.alert({
                title: 'Plan Change Scheduled',
                message: 'Your plan will switch to ' + (targetInterval === 'year' ? 'Starter Yearly' : 'Starter Monthly') + ' after the current period ends.' + (endAt ? '<br/>' + endAt : '')
              });
              location.reload();
            } catch (e) {
              await Modal.alert({ title: 'Error', message: e?.message || String(e) });
            }
          }
          
          async function cancelScheduledChange() {
            const ok = await Modal.confirm({
              title: 'Cancel Scheduled Change',
              message: 'This will remove the upcoming plan switch and keep your current billing cycle.',
              okText: 'Cancel Change'
            });
            if (!ok) return;
            try {
              const resp = await fetch('/stripe/cancel-scheduled-change', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              const data = await resp.json().catch(()=>({}));
              if (!resp.ok || !data?.success) {
                await Modal.alert({ title: 'Action Failed', message: data?.error || 'Unable to cancel scheduled change.' });
                return;
              }
              await Modal.alert({ title: 'Canceled', message: 'Your scheduled plan change has been canceled.' });
              location.reload();
            } catch (e) {
              await Modal.alert({ title: 'Error', message: e?.message || String(e) });
            }
          }
          
          async function managePaymentMethod() {
            try {
              const resp = await fetch('/stripe/customer-portal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              const data = await resp.json().catch(()=>({}));
              if (!resp.ok || !data?.url) {
                await Modal.alert({ title: 'Unable to Open Portal', message: data?.error || 'Please try again later or contact support.' });
                return;
              }
              window.location.href = data.url;
            } catch (e) {
              await Modal.alert({ title: 'Error', message: e?.message || String(e) });
            }
          }
          
          async function cancelSubscription() {
            const ok = await Modal.confirm({
              title: 'Cancel Auto-renew',
              message: 'You will keep access until the end of the current billing period and will not be rebilled.',
              okText: 'Cancel auto-renew'
            });
            if (!ok) return;
            
            // Get subscription ID from the current plan data
            const subscriptionId = '${plan.stripe_subscription_id}';
            
            if (!subscriptionId) {
              await Modal.alert({ title: 'Not Found', message: 'No active subscription found' });
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
                var endText = '';
                if (data.current_period_end) {
                  try { 
                    var d = new Date((Number(data.current_period_end) || 0) * 1000);
                    endText = '\\nAccess remains until: ' + d.toLocaleString();
                  } catch(e) {}
                }
                await Modal.alert({ title: 'Auto-renew Disabled', message: 'You will not be charged again.' + (endText ? '<br/>' + endText : '') });
                // Reload to reflect any UI/state changes (e.g., show “cancellation scheduled” in future)
                location.reload();
              } else {
                await Modal.alert({ title: 'Error', message: 'Failed to cancel subscription: ' + (data.error || 'Unknown error') });
              }
            } catch (error) {
              await Modal.alert({ title: 'Error', message: 'Error canceling subscription: ' + error.message });
            }
          }

          async function resumeSubscription() {
            const ok = await Modal.confirm({
              title: 'Resume Subscription',
              message: 'Your subscription will continue after the current period. Do you want to resume auto-renew?',
              okText: 'Resume'
            });
            if (!ok) return;
            const subscriptionId = '${plan.stripe_subscription_id}';
            if (!subscriptionId) {
              await Modal.alert({ title: 'Not Found', message: 'No active subscription found' });
              return;
            }
            try {
              const resp = await fetch('/stripe/resume-subscription', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription_id: subscriptionId })
              });
              const data = await resp.json().catch(()=>({}));
              if (!resp.ok || !data?.success) {
                await Modal.alert({ title: 'Resume Failed', message: data?.error || 'Unable to resume subscription.' });
                return;
              }
              await Modal.alert({ title: 'Resumed', message: 'Auto-renew has been resumed. Your subscription will continue.' });
              location.reload();
            } catch (e) {
              await Modal.alert({ title: 'Error', message: e?.message || String(e) });
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
      // If user has an active Stripe subscription, block immediate switches;
      // require period-end cancellation first (only free can be scheduled via cancel endpoint).
      const current = await getUserPlan(userId);
      if (current?.stripe_subscription_id) {
        return res.status(409).json({
          error: 'An active subscription is in place. Cancel auto-renew first; the change will take effect at period end.',
          requires_cancel_at_period_end: true,
          subscription_id: current.stripe_subscription_id
        });
      }
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

  // Toggle PAYG
  app.post("/plan/payg", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { enabled } = req.body || {};
    try {
      const enabledBool = !!enabled;
      const email = await getSignedInEmail(req).catch(()=>null);
      let customerCreated = false;
      let needsSetup = false;
      if (enabledBool) {
        if (!isStripeEnabled()) {
          return res.status(500).json({ error: 'Stripe not configured' });
        }
        try {
          const cid = await ensureCustomerForUser(userId, email);
          customerCreated = !!cid;
        } catch (e) {
          console.error('PAYG ensureCustomer failed:', e?.message || e);
        }
        // Verify a default payment method exists; if not, require setup
        try {
          const planNow = await getUserPlan(userId);
          const cidEff = planNow?.stripe_customer_id || null;
          const ok = await hasDefaultPaymentMethod(cidEff);
          if (!ok) needsSetup = true;
        } catch (e) {
          console.error('PAYG payment method check failed:', e?.message || e);
          needsSetup = true;
        }
      } else {
        // Disabling: charge any outstanding overage now; if charge fails, don't disable
        try {
          const { getCurrentMonthPaygOutstanding } = await import('../services/usage.mjs');
          const out = await getCurrentMonthPaygOutstanding(userId);
          if (out?.outstandingUnits > 0 && isStripeEnabled()) {
            const chargedUnits = Number(out.chargedUnits || 0);
            const monthYear = (await getCurrentUsage(userId))?.month_year || '';
            const idKey = `payg_${String(userId)}_${monthYear}_${chargedUnits + Number(out.outstandingUnits)}`;
            const result = await chargePayAsYouGo(userId, Number(out.outstandingUnits), { idempotencyKey: idKey });
            if (!result?.charged) {
              return res.status(402).json({ error: 'Outstanding PAYG charges could not be collected. Please update payment method and try again.' });
            }
            try { await recordPaygCharge(userId, Number(out.outstandingUnits), Number(out.outstandingCents)); } catch {}
          }
        } catch (e) {
          console.error('PAYG charge-on-disable failed:', e?.message || e);
          return res.status(500).json({ error: 'Failed to settle outstanding PAYG before disabling. Please try again.' });
        }
      }
      const finalEnabled = enabledBool && !needsSetup;
      try {
        await updateUserPlan(userId, {
          payg_enabled: finalEnabled,
          payg_rate_cents: Number(process.env.PAYG_RATE_CENTS || 5),
          payg_currency: String(process.env.PAYG_CURRENCY || 'usd').toLowerCase()
        });
      } catch (e) {
        console.error('PAYG updateUserPlan failed:', e?.message || e);
        return res.status(500).json({ error: 'Failed to persist PAYG setting' });
      }
      return res.json({ success: true, customer_created: customerCreated, needs_setup: enabledBool && needsSetup, enabled: finalEnabled });
    } catch (e) {
      console.error('Failed to toggle PAYG:', e?.message || e);
      return res.status(500).json({ error: 'Failed to update PAYG setting', details: e?.message || String(e) });
    }
  });

  // Start payment method setup for PAYG
  app.post("/plan/payg/setup", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!isStripeEnabled()) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    try {
      const email = await getSignedInEmail(req).catch(()=>null);
      const result = await createPayAsYouGoSetupSession(userId, email);
      return res.json({ success: true, url: result?.url || null, session_id: result?.sessionId || null });
    } catch (e) {
      console.error('Failed to start PAYG setup session:', e?.message || e);
      return res.status(500).json({ error: 'Failed to start setup session' });
    }
  });
}
