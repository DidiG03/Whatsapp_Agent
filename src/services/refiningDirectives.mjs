import { upsertKbItem } from "./kb.mjs";
import { upsertSettingsForUser, getSettingsForUser, isBookingsEnabled } from "./settings.mjs";
import {
  appendCompiledEnforcedFromRuleText,
  mergeEnforcedRules,
  parseEnforceDirective,
  removeEnforcedRulesMatchingNeedle,
} from "./refiningEnforcement.mjs";
import {
  applyBookingFieldDirectives,
  parseAddBookingFieldDirective,
} from "./bookingFields.mjs";

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
  const enforceRules = [];
  let bookingProfile = null;
  const addBookingFields = [];
  const removeBookingFieldIds = [];
  let clearBookingFields = false;

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
      continue;
    }
    if (/^ENFORCE\|party_size_call\|/.test(line)) {
      const parsed = parseEnforceDirective(line);
      if (parsed) enforceRules.push(parsed);
      continue;
    }
    if (/^BOOKING_PROFILE\|/.test(line)) {
      bookingProfile = String(line.split("|")[1] || "").trim().toLowerCase();
      continue;
    }
    if (/^ADD_BOOKING_FIELD\|/.test(line)) {
      const parsed = parseAddBookingFieldDirective(line);
      if (parsed) addBookingFields.push(parsed);
      continue;
    }
    if (/^REMOVE_BOOKING_FIELD\|/.test(line)) {
      const id = String(line.split("|")[1] || "").trim();
      if (id) removeBookingFieldIds.push(id);
      continue;
    }
    if (/^CLEAR_BOOKING_FIELDS$/.test(line)) {
      clearBookingFields = true;
    }
  }

  return {
    reply,
    askMore,
    addRules,
    removeRules,
    addKb,
    sets,
    enforceRules,
    bookingProfile,
    addBookingFields,
    removeBookingFieldIds,
    clearBookingFields,
  };
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
    enforceRules = [],
    bookingProfile = null,
    addBookingFields = [],
    removeBookingFieldIds = [],
    clearBookingFields = false,
  } = directives;

  const needsClarification = !!String(askMore || "").trim();
  const effectiveAddRules = needsClarification ? [] : addRules;
  const effectiveEnforceRules = needsClarification ? [] : enforceRules;

  const summaries = [];
  const current = await getSettingsForUser(userId);
  const updates = { ...sets };
  let enforcedJson = current?.ai_refining_enforced_json ?? null;

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

  if (!needsClarification) {
    if (removeRules.includes("__ALL__")) {
      enforcedJson = mergeEnforcedRules(enforcedJson, { clearAll: true });
    } else if (removeRules.length) {
      for (const needle of removeRules) {
        enforcedJson = removeEnforcedRulesMatchingNeedle(enforcedJson, needle);
      }
    }
    for (const ruleText of effectiveAddRules) {
      enforcedJson = appendCompiledEnforcedFromRuleText(enforcedJson, ruleText);
    }
    if (effectiveEnforceRules.length) {
      enforcedJson = mergeEnforcedRules(enforcedJson, { add: effectiveEnforceRules });
      summaries.push(`Enforced ${effectiveEnforceRules.length} hard rule${effectiveEnforceRules.length === 1 ? "" : "s"} (code-level).`);
    }
    updates.ai_refining_enforced_json = enforcedJson;
  }

  for (const item of addKb) {
    const ok = await upsertKbItem(userId, item.title, item.content);
    if (ok) summaries.push(`Saved “${item.title}” to Knowledge Base.`);
  }

  let bookingsBlocked = false;
  const hasBookingDirectives = !needsClarification
    && (bookingProfile || addBookingFields.length || removeBookingFieldIds.length || clearBookingFields);

  if (hasBookingDirectives) {
    if (!isBookingsEnabled(current)) {
      bookingsBlocked = true;
    } else {
      const nextFieldsJson = applyBookingFieldDirectives(current?.booking_fields_json, {
        profile: bookingProfile,
        addFields: addBookingFields,
        removeIds: removeBookingFieldIds,
        clear: clearBookingFields,
      });
      updates.booking_fields_json = nextFieldsJson;
      if (bookingProfile) summaries.push(`Booking profile set to ${bookingProfile}.`);
      if (addBookingFields.length) {
        summaries.push(`Updated ${addBookingFields.length} booking question${addBookingFields.length === 1 ? "" : "s"}.`);
      }
      if (removeBookingFieldIds.length) summaries.push("Removed booking question(s).");
      if (clearBookingFields) summaries.push("Cleared custom booking questions.");
    }
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
    if (bookingsBlocked) {
      const gateMsg = "Bookings are disabled in Settings, so booking questions can't be saved yet. Turn on Bookings under Settings → Bookings, then ask me again to add or change intake questions.";
      if (!visible || !/\b(bookings?|reservations?|settings)\b/i.test(visible)) {
        visible = gateMsg;
      }
    }
    if (!visible && summaries.length) visible = summaries.join(" ");
    if (!visible) visible = "Got it.";
  }

  const saved = !needsClarification && (
    effectiveAddRules.length > 0
    || removeRules.length > 0
    || effectiveEnforceRules.length > 0
    || addKb.length > 0
    || Object.keys(sets).length > 0
    || (hasBookingDirectives && !bookingsBlocked)
  );
  const removed = !needsClarification && removeRules.length > 0;

  return {
    visible,
    summaries,
    rules: updates.ai_refining_rules ?? current?.ai_refining_rules ?? "",
    needsClarification,
    saved,
    removed,
    bookingsBlocked,
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
