/**
 * Whether a plan change may be applied directly (without Stripe Checkout / webhooks).
 * Paid upgrades must go through Stripe when billing is configured.
 */
export function allowDirectPlanChange(targetPlan, options = {}) {
  const plan = String(targetPlan || "").toLowerCase();
  if (!["free", "starter"].includes(plan)) return false;
  if (plan === "free") return true;
  if (options.stripeEnabled) return false;
  return options.allowUnpaidUpgrades === true;
}
