/**
 * Onboarding state management per user.
 * Stores step index and transcript text, and defines the set of steps.
 */
import { OnboardingState } from "../schemas/mongodb.mjs";

export const ONBOARD_STEPS = [
  { key: 'business_name', title: 'Business Name', prompt: 'What is your business name?' },
  { key: 'what_you_do', title: 'What We Do', prompt: 'In one line, what do you sell or do?' },
  { key: 'audience', title: 'Audience', prompt: 'Who is your main audience (e.g., ages, location)?' },
  { key: 'hours', title: 'Hours', prompt: 'What are your opening hours?' },
  { key: 'locations', title: 'Locations', prompt: 'Where are you based or which areas do you serve?' },
  { key: 'products_services', title: 'Products & Services', prompt: 'List your key products or services.' },
  { key: 'delivery', title: 'Delivery', prompt: 'Do you offer delivery/shipping? Include times and cost.' },
  { key: 'returns', title: 'Returns', prompt: 'What is your returns/exchanges policy?' },
  { key: 'payments', title: 'Payments', prompt: 'Which payment methods do you accept?' },
  { key: 'faqs', title: 'Top FAQs', prompt: 'List your top customer FAQs (comma-separated).' },
];

/** Get onboarding state for a user. */
export async function getOnboarding(userId) {
  if (!userId) return null;
  return (await OnboardingState.findOne({ user_id: userId }).lean()) || null;
}

/** Update onboarding state fields for a user (creates row if missing). */
export async function setOnboarding(userId, fields) {
  if (!userId) return null;
  const current = (await getOnboarding(userId)) || { user_id: userId, step: 0, transcript: '' };
  const next = {
    user_id: userId,
    step: fields.step ?? current.step,
    transcript: fields.transcript ?? current.transcript,
  };
  await OnboardingState.findOneAndUpdate({ user_id: userId }, { $set: next }, { upsert: true, new: true });
  return next;
}

