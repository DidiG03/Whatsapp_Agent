import { KBItem, Staff } from "../schemas/mongodb.mjs";
import { getSettingsForUser } from "./settings.mjs";
import { buildConnectionStatus } from "./whatsappConnect.mjs";

export const SETUP_CHECKLIST_STEPS = [
  {
    id: "business",
    label: "Add business info",
    hint: "Name, type, and address",
    href: "/settings#business",
  },
  {
    id: "whatsapp",
    label: "Connect WhatsApp",
    hint: "Link your business number",
    href: "/settings#whatsapp",
  },
  {
    id: "knowledge_base",
    label: "Build knowledge base",
    hint: "Teach your bot what to say",
    href: "/kb/ui",
  },
  {
    id: "staff",
    label: "Add staff & hours",
    hint: "Needed for reservations",
    href: "/settings#staff",
    requiresBookings: true,
  },
];

function hasBusinessInfo(settings = {}) {
  return Boolean(String(settings.business_name || "").trim());
}

function hasWhatsAppConnected(settings = {}) {
  return buildConnectionStatus(settings).connected;
}

function bookingsSetupRelevant(settings = {}) {
  return String(settings.conversation_mode || "") === "full" && !!settings.bookings_enabled;
}

export function evaluateSetupChecklist(settings, { kbCount = 0, staffCount = 0 } = {}) {
  const statusById = {
    business: hasBusinessInfo(settings),
    whatsapp: hasWhatsAppConnected(settings),
    knowledge_base: kbCount > 0,
    staff: staffCount > 0,
  };

  const steps = SETUP_CHECKLIST_STEPS.filter((step) => {
    if (step.requiresBookings) return bookingsSetupRelevant(settings);
    return true;
  }).map((step) => ({
    id: step.id,
    label: step.label,
    hint: step.hint,
    href: step.href,
    done: !!statusById[step.id],
  }));

  const completed = steps.filter((step) => step.done).length;
  const total = steps.length;

  return {
    steps,
    completed,
    total,
    allDone: total > 0 && completed === total,
    showChecklist: total > 0 && completed < total,
  };
}

export async function getSetupChecklist(userId) {
  if (!userId) {
    return evaluateSetupChecklist({}, { kbCount: 0, staffCount: 0 });
  }

  const [settings, kbCount, staffCount] = await Promise.all([
    getSettingsForUser(userId),
    KBItem.countDocuments({ user_id: userId }),
    Staff.countDocuments({ user_id: userId }),
  ]);

  return evaluateSetupChecklist(settings, { kbCount, staffCount });
}
