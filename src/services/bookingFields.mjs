/**
 * Configurable booking intake fields — restaurants vs clinics, custom questions,
 * and calendar notes. Configured via refining coach or defaults from business type.
 */

import { parsePartySizeFromText, parsePartySizeFromHistory } from "./refiningEnforcement.mjs";

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const BUILTIN_META = {
  name: {
    label: "Name",
    promptEn: "What name should I put on the reservation?",
    promptSq: "Me cilin emër ta ruaj rezervimin?",
  },
  party_size: {
    label: "Party size",
    promptEn: "How many people will be joining?",
    promptSq: "Sa persona do të jeni?",
  },
  email: {
    label: "Email",
    promptEn: "What's your email address?",
    promptSq: "Cili është adresa juaj e email-it?",
  },
  phone: {
    label: "Phone",
    promptEn: "What's your phone number?",
    promptSq: "Cili është numri juaj i telefonit?",
  },
};

export const BOOKING_PROFILES = {
  restaurant: {
    profile: "restaurant",
    fields: [
      { id: "name", type: "name", required: true },
      { id: "party_size", type: "party_size", required: true },
    ],
  },
  appointment: {
    profile: "appointment",
    fields: [
      { id: "name", type: "name", required: true },
    ],
  },
};

function normalizeField(raw = {}, lang = "en") {
  const type = String(raw.type || raw.id || "text").trim().toLowerCase();
  const id = String(raw.id || type).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
  if (!id) return null;
  const meta = BUILTIN_META[type] || BUILTIN_META[id] || {};
  const label = String(raw.label || meta.label || id.replace(/_/g, " ")).trim().slice(0, 80);
  const prompt = String(
    raw.prompt
    || (lang === "sq" ? meta.promptSq : meta.promptEn)
    || `Please share your ${label.toLowerCase()}.`
  ).trim().slice(0, 280);
  return {
    id,
    type: ["name", "party_size", "email", "phone"].includes(type) ? type : "text",
    label,
    prompt,
    required: raw.required !== false,
  };
}

export function parseBookingFieldsConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed?.version === 2 && Array.isArray(parsed.fields)) {
      return {
        version: 2,
        profile: String(parsed.profile || "custom").slice(0, 40),
        fields: parsed.fields.map((f) => normalizeField(f)).filter(Boolean),
      };
    }
    if (Array.isArray(parsed) && parsed.length) {
      const fields = [{ id: "name", type: "name", required: true }];
      for (const q of parsed) {
        const prompt = String(q || "").trim();
        if (!prompt) continue;
        const id = `custom_${fields.length}`;
        fields.push({ id, type: "text", label: prompt.replace(/\?$/, ""), prompt, required: true });
      }
      return { version: 2, profile: "legacy", fields: fields.map((f) => normalizeField(f)) };
    }
  } catch {}
  return null;
}

export function inferDefaultFieldsFromBusinessType(businessType = "") {
  const t = stripAccentsLower(businessType);
  if (/restaurant|food|hotel|bar|cafe|dining/.test(t)) {
    return cloneProfile("restaurant");
  }
  return cloneProfile("appointment");
}

function cloneProfile(profileName) {
  const profile = BOOKING_PROFILES[profileName] || BOOKING_PROFILES.appointment;
  return {
    version: 2,
    profile: profile.profile,
    fields: profile.fields.map((f) => normalizeField(f)),
  };
}

export function getBookingFieldsFromSettings(settings = {}, lang = "en") {
  const configured =
    parseBookingFieldsConfig(settings?.booking_fields_json)
    || parseBookingFieldsConfig(settings?.booking_questions_json);
  if (configured?.fields?.length) {
    return {
      ...configured,
      fields: configured.fields.map((f) => normalizeField(f, lang)),
    };
  }
  return inferDefaultFieldsFromBusinessType(settings?.business_type);
}

export function serializeBookingFieldsConfig(config) {
  if (!config?.fields?.length) return null;
  return JSON.stringify({
    version: 2,
    profile: config.profile || "custom",
    fields: config.fields.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      prompt: f.prompt,
      required: f.required !== false,
    })),
  });
}

export function fieldsIncludeType(fields = [], type) {
  return (fields || []).some((f) => f.type === type || f.id === type);
}

export function getFieldPrompt(field, lang = "en") {
  if (!field) return "";
  const meta = BUILTIN_META[field.type] || {};
  if (field.prompt) return field.prompt;
  return lang === "sq" ? (meta.promptSq || field.label) : (meta.promptEn || field.label);
}

export function buildBookingFieldsPromptBlock(fields = [], lang = "en") {
  const list = Array.isArray(fields) ? fields : [];
  if (!list.length) return "";
  const lines = list.map((field, idx) => {
    const req = field.required ? (lang === "sq" ? "e detyrueshme" : "required") : (lang === "sq" ? "opsionale" : "optional");
    return `${idx + 1}. ${field.label} (${req}) — ask: "${getFieldPrompt(field, lang)}" [intent key: ${fieldIntentKey(field)}]`;
  });
  const partyNote = fieldsIncludeType(list, "party_size")
    ? ""
    : (lang === "sq"
      ? "MOS pyet sa persona — ky biznes rezervon një klient për termin."
      : "Do NOT ask how many people — this business books one customer per appointment.");
  return [
    "BOOKING FIELDS TO COLLECT (before intent book):",
    ...lines,
    partyNote,
    lang === "sq"
      ? "Përdor intent book VETËM kur ke datën, orën e saktë DHE të gjitha fushat e detyrueshme sipër. Përfshi vlerat në intent.data."
      : "Use intent book ONLY when you have a specific date, clock time, AND all required fields above. Include values in intent.data.",
  ].filter(Boolean).join("\n");
}

export function fieldIntentKey(field) {
  if (!field) return "";
  if (field.type === "party_size") return "partySize";
  if (field.type === "name") return "name";
  return field.id;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /\+?[\d][\d\s\-()]{7,}[\d]/;

function parseEmailFromText(text) {
  const m = EMAIL_RE.exec(String(text || ""));
  return m ? m[0].trim() : null;
}

function parsePhoneFromText(text) {
  const m = PHONE_RE.exec(String(text || ""));
  return m ? m[0].trim() : null;
}

function looksLikeStandaloneName(raw) {
  const s = String(raw || "").trim();
  if (!/^[A-Za-zËÇëç][A-Za-zËÇëç'\-]+(?:\s+[A-Za-zËÇëç][A-Za-zËÇëç'\-]+){0,2}$/.test(s)) return false;
  return !isBookingVocabularyWord(s);
}

/** Common booking/time words that must never be stored as a customer name. */
export function isBookingVocabularyWord(raw) {
  const sq = stripAccentsLower(String(raw || "").trim());
  if (!sq) return true;
  const blocked = new Set([
    "rezervim", "rezervime", "rezervimi", "termin", "termini", "takim", "takimi",
    "neser", "sot", "dark", "darke", "mbremje", "pasdite", "dreke", "mengjes",
    "okej", "ok", "po", "jo", "faleminderit", "pershendetje", "pranoni", "pranojme",
    "dua", "bej", "nje", "informacion", "orarin", "vendndodhjen", "restorant",
  ]);
  if (blocked.has(sq)) return true;
  return /\b(rezerv|book|cancel|anul|termin|takim|persona|veta|orar|menu|cmim)\w*/.test(sq);
}

function parseNameFromText(text) {
  const raw = String(text || "").trim();
  const m = /\b(?:emri\s+im\s+(?:eshte|është)|quhem|jam|my\s+name\s+is|i\s*am|i'm)\s+([a-zëç][a-zëç'\-]+(?:\s+[a-zëç][a-zëç'\-]+){0,2})/i.exec(raw);
  if (m) return m[1].trim();
  if (looksLikeStandaloneName(raw)) return raw;
  return null;
}

function parseNameFromHistory(historyMessages = []) {
  const hist = historyMessages || [];
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    if (m?.role !== "user") continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    const prior = hist.slice(0, i);
    const askedName = prior.some((h) => {
      if (h?.role !== "assistant") return false;
      const c = stripAccentsLower(String(h.content || ""));
      return /\b(emri|emrin|emër|emer|quheni|si quheni|me cilin emer|me cilin emër|what name|what(?:'|')?s your name|under what name|name should i|put on the reservation|ta vendos rezervimin)\b/.test(c);
    });
    if (/\b(?:emri\s+im|quhem|jam|my\s+name\s+is|i\s*am|i'm)\b/i.test(content)) {
      const n = parseNameFromText(content);
      if (n) return n;
    }
    if (askedName && looksLikeStandaloneName(content)) return content;
  }
  return null;
}

function historyAskedForField(historyMessages = [], field) {
  const promptSq = stripAccentsLower(getFieldPrompt(field));
  const labelSq = stripAccentsLower(field.label || "");
  return (historyMessages || []).some((m) => {
    if (m?.role !== "assistant") return false;
    const c = stripAccentsLower(String(m.content || ""));
    if (labelSq && c.includes(labelSq)) return true;
    if (promptSq.length > 8 && c.includes(promptSq.slice(0, Math.min(24, promptSq.length)))) return true;
    if (field.type === "name" && /\b(emri|emrin|quheni|what name|under what name)\b/.test(c)) return true;
    if (field.type === "party_size" && /\b(sa persona|how many people|how many)\b/.test(c)) return true;
    if (field.type === "email" && /\b(email|e-mail)\b/.test(c)) return true;
    if (field.type === "phone" && /\b(phone|telefon|numri)\b/.test(c)) return true;
    return false;
  });
}

function resolveTextFieldFromHistory(historyMessages = [], field) {
  for (let i = (historyMessages || []).length - 1; i >= 0; i--) {
    const m = historyMessages[i];
    if (m?.role !== "assistant") continue;
    const asked = historyAskedForField([m], field);
    if (!asked) continue;
    for (let j = i + 1; j < historyMessages.length; j++) {
      const um = historyMessages[j];
      if (um?.role !== "user") continue;
      const c = String(um.content || "").trim();
      if (c) return c.slice(0, 280);
    }
  }
  return null;
}

function resolveSingleFieldValue(field, { text, historyMessages, intentData, knownCustomerName, contactId, isUsableCustomerName }) {
  const key = fieldIntentKey(field);
  const fromIntent = intentData?.[key] ?? intentData?.[field.id] ?? null;
  if (fromIntent != null && String(fromIntent).trim()) return String(fromIntent).trim();

  if (field.type === "name") {
    const direct = parseNameFromText(text);
    if (direct) return direct;
    if (isUsableCustomerName && isUsableCustomerName(knownCustomerName, contactId)) {
      return String(knownCustomerName).trim();
    }
    const fromHist = parseNameFromHistory(historyMessages);
    if (fromHist) return fromHist;
    return null;
  }

  if (field.type === "party_size") {
    const fromText = parsePartySizeFromText(text);
    if (fromText) return fromText;
    const fromHist = parsePartySizeFromHistory(historyMessages);
    if (fromHist) return fromHist;
    const n = Number(intentData?.partySize || intentData?.guests || 0);
    return n >= 1 && n <= 100 ? n : null;
  }

  if (field.type === "email") {
    const direct = parseEmailFromText(text);
    if (direct) return direct;
    for (const m of [...(historyMessages || [])].reverse()) {
      if (m?.role !== "user") continue;
      const e = parseEmailFromText(String(m.content || ""));
      if (e) return e;
    }
    return null;
  }

  if (field.type === "phone") {
    const direct = parsePhoneFromText(text);
    if (direct) return direct;
    for (const m of [...(historyMessages || [])].reverse()) {
      if (m?.role !== "user") continue;
      const p = parsePhoneFromText(String(m.content || ""));
      if (p) return p;
    }
    return null;
  }

  const fromHist = resolveTextFieldFromHistory(historyMessages, field);
  if (fromHist) return fromHist;
  if (historyAskedForField(historyMessages, field) && String(text || "").trim()) {
    return String(text).trim().slice(0, 280);
  }
  return null;
}

export function resolveBookingFieldValues(ctx = {}) {
  const {
    fields = [],
    text = "",
    historyMessages = [],
    intentData = {},
    knownCustomerName = "",
    contactId = "",
    isUsableCustomerName = null,
  } = ctx;
  const values = {};
  for (const field of fields) {
    values[field.id] = resolveSingleFieldValue(field, {
      text,
      historyMessages,
      intentData,
      knownCustomerName,
      contactId,
      isUsableCustomerName,
    });
  }
  return values;
}

export function bookingFieldsReady(values = {}, fields = []) {
  for (const field of fields) {
    if (!field.required) continue;
    const v = values[field.id];
    if (v == null || String(v).trim() === "") {
      return { ready: false, missing: field };
    }
    if (field.type === "party_size") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) return { ready: false, missing: field };
    }
  }
  return { ready: true, missing: null };
}

export function formatBookingNotesFromValues(values = {}, fields = []) {
  const parts = [];
  for (const field of fields) {
    const v = values[field.id];
    if (v == null || String(v).trim() === "") continue;
    parts.push(`${field.label}: ${String(v).slice(0, 200)}`);
  }
  return parts.join(" | ");
}

export function bookingReplyAsksForField(text, field) {
  if (!field) return false;
  const sq = stripAccentsLower(String(text || ""));
  if (field.type === "name") {
    return /\b(emri|emrin|emër|emer|quheni|si quheni|me cilin emer|me cilin emër|what name|what(?:'|')?s your name|under what name|name should i|put on the reservation|ta vendos rezervimin)\b/.test(sq);
  }
  if (field.type === "party_size") {
    return /\b(sa persona|how many people|how many|sa jeni)\b/.test(sq);
  }
  if (field.type === "email") {
    return /\b(email|e-mail|adresa.*email)\b/.test(sq);
  }
  if (field.type === "phone") {
    return /\b(phone|telefon|numri.*telefon)\b/.test(sq);
  }
  const promptSq = stripAccentsLower(getFieldPrompt(field));
  const labelSq = stripAccentsLower(field.label || "");
  if (labelSq && sq.includes(labelSq)) return true;
  if (promptSq.length > 10 && sq.includes(promptSq.slice(0, Math.min(20, promptSq.length)))) return true;
  return false;
}

export function bookingReplyAsksForAnyField(text, fields = []) {
  return (fields || []).some((f) => bookingReplyAsksForField(text, f));
}

export function applyBookingFieldDirectives(currentJson, {
  profile = null,
  addFields = [],
  removeIds = [],
  clear = false,
} = {}) {
  let config = parseBookingFieldsConfig(currentJson);
  if (clear) config = { version: 2, profile: "custom", fields: [] };
  if (!config) config = cloneProfile("appointment");

  if (profile && BOOKING_PROFILES[profile]) {
    config = cloneProfile(profile);
  }

  if (removeIds.length) {
    const drop = new Set(removeIds.map((id) => String(id).toLowerCase()));
    config.fields = (config.fields || []).filter((f) => !drop.has(String(f.id).toLowerCase()));
  }

  for (const incoming of addFields) {
    const normalized = normalizeField(incoming);
    if (!normalized) continue;
    const idx = config.fields.findIndex((f) => f.id === normalized.id);
    if (idx >= 0) config.fields[idx] = { ...config.fields[idx], ...normalized };
    else config.fields.push(normalized);
  }

  if (!config.fields.some((f) => f.type === "name")) {
    config.fields.unshift(normalizeField({ id: "name", type: "name", required: true }));
  }

  return serializeBookingFieldsConfig(config);
}

/** Remove one booking question from effective config (including type defaults) and persist as custom JSON. */
export function removeBookingFieldFromSettings(settings = {}, fieldId) {
  const id = String(fieldId || "").trim().toLowerCase();
  if (!id) return { ok: false, error: "missing_id" };
  if (id === "name") return { ok: false, error: "name_required" };

  const current = getBookingFieldsFromSettings(settings);
  const before = (current.fields || []).length;
  const serialized = serializeBookingFieldsConfig(current);
  const nextJson = applyBookingFieldDirectives(serialized, { removeIds: [id] });
  const after = getBookingFieldsFromSettings({ booking_fields_json: nextJson }).fields?.length || 0;

  if (after >= before) {
    return { ok: false, error: "not_found" };
  }

  return { ok: true, booking_fields_json: nextJson };
}

export function parseAddBookingFieldDirective(line) {
  const parts = String(line || "").split("|");
  if (parts.length < 3) return null;
  const id = String(parts[1] || "").trim().toLowerCase();
  const type = String(parts[2] || "text").trim().toLowerCase();
  const label = String(parts[3] || "").trim();
  const prompt = String(parts[4] || "").trim();
  const reqFlag = String(parts[5] || "required").trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    type,
    label: label || undefined,
    prompt: prompt || undefined,
    required: reqFlag !== "optional",
  };
}

export function listBookingFieldsSummary(settings = {}, lang = "en") {
  const config = getBookingFieldsFromSettings(settings, lang);
  return (config.fields || []).map((f) => ({
    id: f.id,
    label: f.label,
    required: f.required,
    prompt: getFieldPrompt(f, lang),
  }));
}
