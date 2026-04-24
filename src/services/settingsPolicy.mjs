const PLAN_WEIGHTS = {
  free: 0,
  starter: 1,
  basic: 1,
  pro: 2,
  team: 2,
  business: 3,
  enterprise: 4
};

const FIELD_POLICIES = {
  bookings_enabled: { minPlan: "starter" },
  reminders_enabled: { minPlan: "starter" },
  reschedule_min_lead_minutes: { minPlan: "starter" },
  cancel_min_lead_minutes: { minPlan: "starter" },
  reminder_windows: { minPlan: "starter" },
  wa_template_name: { minPlan: "pro" },
  wa_template_language: { minPlan: "pro" },
  smtp_host: { minPlan: "pro" },
  smtp_port: { minPlan: "pro" },
  smtp_secure: { minPlan: "pro" },
  smtp_user: { minPlan: "pro" },
  smtp_pass: { minPlan: "pro" }
};

function planRank(planName) {
  const key = String(planName || "free").toLowerCase();
  return PLAN_WEIGHTS[key] ?? 0;
}

function meetsPlan(planName, minPlan) {
  if (!minPlan) return true;
  return planRank(planName) >= planRank(minPlan);
}

export function enforceSettingsPolicy(values, context = {}) {
  const planName = context.planName || "free";
  const filtered = {};
  const deniedFields = [];

  for (const [key, value] of Object.entries(values)) {
    const policy = FIELD_POLICIES[key];
    if (!policy) {
      filtered[key] = value;
      continue;
    }
    if (!meetsPlan(planName, policy.minPlan)) {
      deniedFields.push(key);
      continue;
    }
    filtered[key] = value;
  }

  return { filtered, deniedFields };
}

export default {
  enforceSettingsPolicy
};

