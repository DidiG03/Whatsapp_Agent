import { buildBusinessSettingsSnippet, isBookingsEnabled } from "./settings.mjs";
import { buildGoogleBusinessCoachBlock } from "./googleBusinessImport.mjs";
import { fetchWebsiteTextSnippet } from "./websiteContext.mjs";
import { listBookingFieldsSummary } from "./bookingFields.mjs";

function pushUniqueLine(lines, line) {
  const value = String(line || "").trim();
  if (!value) return;
  if (!lines.includes(value)) lines.push(value);
}

function buildCoachBookingFieldsBlock(cfg = {}) {
  const fields = listBookingFieldsSummary(cfg);
  if (!fields.length) return null;
  const lines = fields.map((f) => {
    const req = f.required ? "required" : "optional";
    return `- ${f.label} (${req}): ${f.prompt}`;
  });
  return lines.join("\n");
}

function buildCoachEscalationBlock(cfg = {}) {
  let questions = [];
  try {
    questions = JSON.parse(cfg.escalation_questions_json || "[]");
    if (!Array.isArray(questions)) questions = [];
  } catch {}
  questions = questions.map((q) => String(q || "").trim()).filter(Boolean);
  if (!questions.length) return null;
  return questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
}

export function buildCoachSettingsContextBlock(cfg = {}) {
  const lines = [];
  const snippet = buildBusinessSettingsSnippet(cfg, { includeGoogleProfile: false });
  if (snippet?.content) {
    for (const line of String(snippet.content).split("\n")) {
      pushUniqueLine(lines, line);
    }
  }

  const phone = String(cfg.business_phone || "").trim();
  if (phone) pushUniqueLine(lines, `WhatsApp / business phone: ${phone}`);

  if (cfg.business_place_id) {
    pushUniqueLine(lines, `Google Place ID: ${String(cfg.business_place_id).slice(0, 80)}`);
  }

  const tone = String(cfg.ai_tone || "").trim();
  const style = String(cfg.ai_style || "").trim();
  if (tone) pushUniqueLine(lines, `AI tone: ${tone}`);
  if (style) pushUniqueLine(lines, `AI style: ${style}`);

  const blocked = String(cfg.ai_blocked_topics || "").trim();
  if (blocked) pushUniqueLine(lines, `Blocked topics: ${blocked}`);

  const mode = String(cfg.conversation_mode || "").trim();
  if (mode) pushUniqueLine(lines, `Conversation mode: ${mode}`);

  if (isBookingsEnabled(cfg)) {
    pushUniqueLine(lines, "Bookings: enabled (WhatsApp calendar reservations are active)");
  } else {
    pushUniqueLine(lines, "Bookings: disabled (turn on in Settings → Bookings before the bot can take reservations or use booking questions)");
  }

  if (Number(cfg.booking_max_per_day) > 0) {
    pushUniqueLine(lines, `Max bookings per day: ${cfg.booking_max_per_day}`);
  }
  if (Number(cfg.booking_days_ahead) > 0) {
    pushUniqueLine(lines, `Booking horizon (days): ${cfg.booking_days_ahead}`);
  }
  if (Number(cfg.reschedule_min_lead_minutes) > 0) {
    pushUniqueLine(lines, `Reschedule lead time (minutes): ${cfg.reschedule_min_lead_minutes}`);
  }
  if (Number(cfg.cancel_min_lead_minutes) > 0) {
    pushUniqueLine(lines, `Cancel lead time (minutes): ${cfg.cancel_min_lead_minutes}`);
  }

  const escalation = String(cfg.escalation_additional_message || "").trim();
  if (escalation) pushUniqueLine(lines, `Escalation message: ${escalation.slice(0, 240)}`);

  const outOfHours = String(cfg.escalation_out_of_hours_message || "").trim();
  if (outOfHours) pushUniqueLine(lines, `Out-of-hours message: ${outOfHours.slice(0, 240)}`);

  return lines.length ? lines.join("\n") : null;
}

export async function buildCoachBusinessContext(cfg = {}, options = {}) {
  const parts = [];
  const settingsBlock = buildCoachSettingsContextBlock(cfg);
  if (settingsBlock) {
    parts.push(`Dashboard settings (Business Information + scheduling):\n${settingsBlock}`);
  }

  const googleBlock = buildGoogleBusinessCoachBlock(cfg);
  if (googleBlock) {
    parts.push(`Google Business Profile (imported):\n${googleBlock}`);
  }

  const bookingFieldsBlock = buildCoachBookingFieldsBlock(cfg);
  if (isBookingsEnabled(cfg)) {
    if (bookingFieldsBlock) {
      parts.push(`Current WhatsApp booking questions:\n${bookingFieldsBlock}`);
    }
  } else {
    parts.push(
      "WhatsApp booking questions: inactive — Bookings is disabled in Settings, so intake questions are not used until reservations are enabled."
    );
  }

  const escalationBlock = buildCoachEscalationBlock(cfg);
  if (escalationBlock) {
    parts.push(`Escalation intake questions (human handoff):\n${escalationBlock}`);
  }

  const websiteUrl = String(cfg.website_url || "").trim();
  if (websiteUrl) {
    const websiteText = await fetchWebsiteTextSnippet(websiteUrl, options);
    if (websiteText) {
      parts.push(`Website content (${websiteUrl}):\n${websiteText}`);
    } else {
      parts.push(`Website URL on file: ${websiteUrl} (content could not be fetched right now)`);
    }
  }

  return parts.length ? parts.join("\n\n") : null;
}
