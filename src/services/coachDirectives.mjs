
import { upsertKbItem } from "../services/kb.mjs";
import { upsertSettingsForUser, getSettingsForUser } from "../services/settings.mjs";

export function parseDirectives(text = "") {
  const lines = String(text || "").split("\n");
  const trimmed = lines.map(l => l.trim());
  const addLines = trimmed.filter(l => /^ADD_KB\|/.test(l));
  const setLines = trimmed.filter(l => /^SET\|/.test(l));
  const complete = trimmed.some(l => /^COMPLETE$/.test(l));
  const visible = lines
    .filter(l => {
      const t = l.trim();
      return !/^ADD_KB\|/.test(t) && !/^SET\|/.test(t) && t !== "COMPLETE";
    })
    .join("\n")
    .trim();

  const adds = addLines.map(l => {
    const m = /^ADD_KB\|(.*)\|(.*)$/.exec(l);
    if (!m) return null;
    const title = (m[1] || "").trim().slice(0, 120) || "Untitled";
    const content = (m[2] || "").trim();
    if (!content) return null;
    return { title, content };
  }).filter(Boolean);

  const sets = {};
  for (const l of setLines) {
    const m = /^SET\|(.*?)\|(.*)$/.exec(l);
    if (!m) continue;
    const key = (m[1] || "").trim();
    const value = (m[2] || "").trim();
    if (key) sets[key] = value;
  }

  return { adds, sets, complete, visible };
}
export async function applyDirectives(userId, { adds = [], sets = {}, visible = "" }) {
  const summaries = [];
  for (const a of adds) {
    const ok = await upsertKbItem(userId, a.title, a.content);
    if (ok) summaries.push(`Saved “${a.title}” to KB.`);
  }
  if (Object.keys(sets).length) {
    await upsertSettingsForUser(userId, sets);
    try {
      if (sets.business_name) summaries.push('Saved “Business Name” to KB.');
      if (sets.website_url) summaries.push('Saved “Website” to KB.');
      if (sets.business_phone) summaries.push('Saved “Contact” to KB.');
    } catch {}
    if (!visible) {
      const current = await getSettingsForUser(userId);
      visible = sets.entry_greeting || `Updated settings for ${current?.business_name || 'your business'}.`;
    }
  }
  return { summaries, visible };
}

export default { parseDirectives, applyDirectives };

