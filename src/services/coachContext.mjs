import { buildBusinessSettingsSnippet } from "./settings.mjs";
import { fetchWebsiteTextSnippet } from "./websiteContext.mjs";

function pushUniqueLine(lines, line) {
  const value = String(line || "").trim();
  if (!value) return;
  if (!lines.includes(value)) lines.push(value);
}

export function buildCoachSettingsContextBlock(cfg = {}) {
  const lines = [];
  const snippet = buildBusinessSettingsSnippet(cfg);
  if (snippet?.content) {
    for (const line of String(snippet.content).split("\n")) {
      pushUniqueLine(lines, line);
    }
  }

  const phone = String(cfg.business_phone || "").trim();
  if (phone) pushUniqueLine(lines, `Phone: ${phone}`);

  const tone = String(cfg.ai_tone || "").trim();
  const style = String(cfg.ai_style || "").trim();
  if (tone) pushUniqueLine(lines, `AI tone: ${tone}`);
  if (style) pushUniqueLine(lines, `AI style: ${style}`);

  const blocked = String(cfg.ai_blocked_topics || "").trim();
  if (blocked) pushUniqueLine(lines, `Blocked topics: ${blocked}`);

  const mode = String(cfg.conversation_mode || "").trim();
  if (mode && mode !== "full") pushUniqueLine(lines, `Conversation mode: ${mode}`);

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
    parts.push(`Business profile (from dashboard settings):\n${settingsBlock}`);
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
