import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import {
  getUserPlan,
  getPlanPricing,
  updateUserPlan,
  getCurrentUsage,
  getCurrentMonthPaygOutstanding,
  settleOutstandingPaygCharges,
} from "../services/usage.mjs";
import {
  isStripeEnabled,
  ensureCustomerForUser,
  createPayAsYouGoSetupSession,
  hasDefaultPaymentMethod,
} from "../services/stripe.mjs";
import { allowDirectPlanChange } from "../services/planPolicy.mjs";

function planBillingRedirectUrl(req) {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return `/settings${qs}#billing`;
}

export default function registerPlanRoutes(app) {
  app.get("/plan", ensureAuthed, (req, res) => {
    res.redirect(303, planBillingRedirectUrl(req));
  });

  app.post("/plan/update", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { plan_name } = req.body;

    if (!plan_name || !["free", "starter"].includes(plan_name)) {
      return res.status(400).json({ error: "Invalid plan name" });
    }

    const stripeEnabled = isStripeEnabled();
    const allowUnpaidUpgrades = process.env.ALLOW_PLAN_UPDATE_WITHOUT_STRIPE === "1";
    if (!allowDirectPlanChange(plan_name, { stripeEnabled, allowUnpaidUpgrades })) {
      return res.status(403).json({
        error: stripeEnabled
          ? "Upgrades require Stripe checkout. Use Subscribe in Settings → Plan & billing."
          : "Paid plan updates are disabled on this deployment.",
        requires_checkout: stripeEnabled,
      });
    }

    try {
      const current = await getUserPlan(userId);
      if (current?.stripe_subscription_id) {
        return res.status(409).json({
          error: "An active subscription is in place. Cancel auto-renew first; the change will take effect at period end.",
          requires_cancel_at_period_end: true,
          subscription_id: current.stripe_subscription_id,
        });
      }
      const pricing = getPlanPricing();
      const planDetails = pricing[plan_name];

      if (!planDetails) {
        return res.status(400).json({ error: "Plan not found" });
      }
      await updateUserPlan(userId, {
        plan_name: plan_name,
        monthly_limit: planDetails.monthly_limit,
        whatsapp_numbers: planDetails.whatsapp_numbers,
        billing_cycle_start: Math.floor(Date.now() / 1000),
      });

      res.json({ success: true, message: `Plan updated to ${planDetails.name}` });
    } catch (error) {
      console.error("Plan update error:", error);
      res.status(500).json({ error: "Failed to update plan" });
    }
  });

  app.post("/plan/payg", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { enabled } = req.body || {};
    try {
      const enabledBool = !!enabled;
      const email = await getSignedInEmail(req).catch(() => null);
      let customerCreated = false;
      let needsSetup = false;
      if (enabledBool) {
        if (!isStripeEnabled()) {
          return res.status(500).json({ error: "Stripe not configured" });
        }
        try {
          const cid = await ensureCustomerForUser(userId, email);
          customerCreated = !!cid;
        } catch (e) {
          console.error("PAYG ensureCustomer failed:", e?.message || e);
        }
        try {
          const planNow = await getUserPlan(userId);
          const cidEff = planNow?.stripe_customer_id || null;
          const ok = await hasDefaultPaymentMethod(cidEff);
          if (!ok) needsSetup = true;
        } catch (e) {
          console.error("PAYG payment method check failed:", e?.message || e);
          needsSetup = true;
        }
      } else {
        try {
          if (isStripeEnabled()) {
            const out = await getCurrentMonthPaygOutstanding(userId);
            if (out?.outstandingUnits > 0) {
              const monthYear = (await getCurrentUsage(userId))?.month_year || "";
              const idKey = `payg_${String(userId)}_${monthYear}_bulk_${Number(out.chargedUnits) + Number(out.outstandingUnits)}`;
              const result = await settleOutstandingPaygCharges(userId, { bulkCharge: true, bulkIdempotencyKey: idKey });
              if (!result?.success && Number(result?.remainingUnits || 0) > 0) {
                return res.status(402).json({ error: "Outstanding PAYG charges could not be collected. Please update payment method and try again." });
              }
            }
          }
        } catch (e) {
          console.error("PAYG charge-on-disable failed:", e?.message || e);
          return res.status(500).json({ error: "Failed to settle outstanding PAYG before disabling. Please try again." });
        }
      }
      const finalEnabled = enabledBool && !needsSetup;
      try {
        await updateUserPlan(userId, {
          payg_enabled: finalEnabled,
          payg_rate_cents: Number(process.env.PAYG_RATE_CENTS || 5),
          payg_currency: String(process.env.PAYG_CURRENCY || "usd").toLowerCase(),
        });
      } catch (e) {
        console.error("PAYG updateUserPlan failed:", e?.message || e);
        return res.status(500).json({ error: "Failed to persist PAYG setting" });
      }
      return res.json({ success: true, customer_created: customerCreated, needs_setup: enabledBool && needsSetup, enabled: finalEnabled });
    } catch (e) {
      console.error("Failed to toggle PAYG:", e?.message || e);
      return res.status(500).json({ error: "Failed to update PAYG setting", details: e?.message || String(e) });
    }
  });

  app.post("/plan/payg/setup", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!isStripeEnabled()) {
      return res.status(500).json({ error: "Stripe not configured" });
    }
    try {
      const email = await getSignedInEmail(req).catch(() => null);
      const result = await createPayAsYouGoSetupSession(userId, email);
      return res.json({ success: true, url: result?.url || null, session_id: result?.sessionId || null });
    } catch (e) {
      console.error("Failed to start PAYG setup session:", e?.message || e);
      return res.status(500).json({ error: "Failed to start setup session" });
    }
  });

  app.post("/plan/payg/settle", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!isStripeEnabled()) {
      return res.status(500).json({ error: "Stripe not configured" });
    }
    try {
      const plan = await getUserPlan(userId);
      if (!plan?.payg_enabled) {
        return res.status(400).json({ error: "Pay-as-you-go is not enabled" });
      }
      const outBefore = await getCurrentMonthPaygOutstanding(userId);
      if (Number(outBefore?.outstandingUnits || 0) <= 0) {
        return res.json({
          success: true,
          charged_units: 0,
          charged_cents: 0,
          remaining_units: 0,
          remaining_cents: 0,
        });
      }
      const result = await settleOutstandingPaygCharges(userId);
      if (!result?.success && Number(result?.remainingUnits || 0) > 0) {
        return res.status(402).json({
          error: "Outstanding PAYG charges could not be collected. Please update your payment method and try again.",
          charged_units: result.chargedUnits || 0,
          charged_cents: result.chargedCents || 0,
          remaining_units: result.remainingUnits || 0,
          remaining_cents: result.remainingCents || 0,
          reason: result.reason || "payment_failed",
        });
      }
      return res.json({
        success: true,
        charged_units: result.chargedUnits || 0,
        charged_cents: result.chargedCents || 0,
        remaining_units: result.remainingUnits || 0,
        remaining_cents: result.remainingCents || 0,
      });
    } catch (e) {
      console.error("Failed to settle PAYG balance:", e?.message || e);
      return res.status(500).json({ error: "Failed to settle outstanding balance" });
    }
  });
}
