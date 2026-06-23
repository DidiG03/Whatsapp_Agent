import { upsertKbItem } from "./kb.mjs";
import { upsertSettingsForUser, getSettingsForUser } from "./settings.mjs";

function splitRules(text = "") {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function joinRules(rules = []) {
  return rules.map((r) => r.trim()).filter(Boolean).join("\n");
}

export function parseRefiningDirectives(text = "") {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let reply = "";
  let askMore = "";
  const addRules = [];
  const removeRules = [];
  const addKb = [];
  const sets = {};

  for (const line of lines) {
    if (/^REPLY\|/.test(line)) {
      reply = line.slice(6).trim();
      continue;
    }
    if (/^ASK_MORE\|/.test(line)) {
      askMore = line.slice(9).trim();
      continue;
    }
    if (/^ADD_RULE\|/.test(line)) {
      const rule = line.slice(9).trim();
      if (rule) addRules.push(rule);
      continue;
    }
    if (/^REMOVE_RULE\|/.test(line)) {
      const needle = line.slice(12).trim();
      if (needle) removeRules.push(needle);
      continue;
    }
    if (/^CLEAR_RULES$/.test(line)) {
      removeRules.push("__ALL__");
      continue;
    }
    const addKbMatch = /^ADD_KB\|(.*)\|(.*)$/.exec(line);
    if (addKbMatch) {
      const title = (addKbMatch[1] || "").trim().slice(0, 120) || "Untitled";
      const content = (addKbMatch[2] || "").trim();
      if (content) addKb.push({ title, content });
      continue;
    }
    const setMatch = /^SET\|(.*?)\|(.*)$/.exec(line);
    if (setMatch) {
      const key = (setMatch[1] || "").trim();
      const value = (setMatch[2] || "").trim();
      if (key) sets[key] = value;
    }
  }

  return { reply, askMore, addRules, removeRules, addKb, sets };
}

export function mergeRefiningRules(currentRulesText, { addRules = [], removeRules = [] } = {}) {
  let rules = splitRules(currentRulesText);

  if (removeRules.includes("__ALL__")) {
    rules = [];
  } else if (removeRules.length) {
    for (const needle of removeRules) {
      const norm = needle.toLowerCase();
      rules = rules.filter((rule) => !rule.toLowerCase().includes(norm));
    }
  }

  for (const rule of addRules) {
    const exists = rules.some((r) => r.toLowerCase() === rule.toLowerCase());
    if (!exists) rules.push(rule);
  }

  return joinRules(rules);
}

export function listRefiningRules(rulesText = "") {
  return splitRules(rulesText);
}

export function removeRuleAtIndex(rulesText = "", index = -1) {
  const rules = splitRules(rulesText);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= rules.length) {
    return { ok: false, rules: joinRules(rules) };
  }
  rules.splice(idx, 1);
  return { ok: true, rules: joinRules(rules) };
}

export function clearAllRefiningRules() {
  return { ok: true, rules: "" };
}

export async function applyRefiningDirectives(userId, directives = {}) {
  const {
    reply = "",
    askMore = "",
    addRules = [],
    removeRules = [],
    addKb = [],
    sets = {},
  } = directives;

  const needsClarification = !!String(askMore || "").trim();
  const effectiveAddRules = needsClarification ? [] : addRules;

  const summaries = [];
  const current = await getSettingsForUser(userId);
  const updates = { ...sets };

  if (effectiveAddRules.length || removeRules.length) {
    const mergedRules = mergeRefiningRules(current?.ai_refining_rules, {
      addRules: effectiveAddRules,
      removeRules,
    });
    updates.ai_refining_rules = mergedRules || null;
    if (effectiveAddRules.length) {
      summaries.push(`Added ${effectiveAddRules.length} bot rule${effectiveAddRules.length === 1 ? "" : "s"}.`);
    }
    if (removeRules.length && !removeRules.includes("__ALL__")) summaries.push("Removed matching rule(s).");
    if (removeRules.includes("__ALL__")) summaries.push("Cleared all bot rules.");
  }

  for (const item of addKb) {
    const ok = await upsertKbItem(userId, item.title, item.content);
    if (ok) summaries.push(`Saved “${item.title}” to Knowledge Base.`);
  }

  if (Object.keys(updates).length && !needsClarification) {
    delete updates.entry_greeting;
    await upsertSettingsForUser(userId, { ...current, ...updates });
  } else if (Object.keys(updates).length && needsClarification && Object.keys(sets).length) {
    delete updates.entry_greeting;
    delete updates.ai_refining_rules;
    await upsertSettingsForUser(userId, { ...current, ...sets });
  }

  let visible = "";
  if (needsClarification) {
    visible = String(askMore || "").trim();
    if (reply && reply !== visible) {
      visible = `${reply} ${visible}`.trim();
    }
  } else {
    visible = String(reply || "").trim();
    if (!visible && summaries.length) visible = summaries.join(" ");
    if (!visible) visible = "Got it.";
  }

  const saved = !needsClarification && (
    effectiveAddRules.length > 0
    || removeRules.length > 0
    || addKb.length > 0
    || Object.keys(sets).length > 0
  );
  const removed = !needsClarification && removeRules.length > 0;

  return {
    visible,
    summaries,
    rules: updates.ai_refining_rules ?? current?.ai_refining_rules ?? "",
    needsClarification,
    saved,
    removed,
  };
}

export function formatRefiningRulesForPrompt(rulesText = "") {
  const rules = splitRules(rulesText);
  if (!rules.length) return "";
  return [
    "BUSINESS OWNER RULES (follow strictly — these override generic defaults when they conflict):",
    "These rules define WHAT the bot must say or do. They do NOT remove polite greetings or thank-yous.",
    "If the customer greets you, greet back first. If you give a complete policy answer or redirect, end warmly (e.g. 'Faleminderit!').",
    ...rules.map((rule, idx) => `${idx + 1}. ${rule}`),
  ].join("\n");
}

export default {
  parseRefiningDirectives,
  mergeRefiningRules,
  listRefiningRules,
  removeRuleAtIndex,
  clearAllRefiningRules,
  applyRefiningDirectives,
  formatRefiningRulesForPrompt,
};
