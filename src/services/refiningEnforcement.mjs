import crypto from "node:crypto";
import { normalizePhoneE164 } from "../utils.mjs";
import { getSettingsForUser } from "./settings.mjs";
import { getContactMemory } from "./memory.mjs";

export class BookingEnforcedError extends Error {
  constructor(reply, meta = {}) {
    super(String(reply || "Booking blocked by business rule"));
    this.name = "BookingEnforcedError";
    this.code = "BOOKING_ENFORCED";
    this.reply = String(reply || "");
    this.meta = meta;
  }
}

const ENFORCED_RULE_TYPES = new Set(["party_size_call"]);

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function parseEnforcedRulesJson(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && ENFORCED_RULE_TYPES.has(r.type) && r.enabled !== false)
      .map(normalizeEnforcedRule)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getEnforcedRulesFromSettings(settings = {}) {
  let rules = parseEnforcedRulesJson(settings?.ai_refining_enforced_json);
  if (!rules.length && settings?.ai_refining_rules) {
    for (const line of String(settings.ai_refining_rules).split(/\n+/)) {
      const compiled = compilePartySizeCallFromRuleText(line);
      if (compiled) rules.push(compiled);
    }
  }
  return rules;
}

function normalizeEnforcedRule(rule) {
  if (!rule || rule.type !== "party_size_call") return null;
  const minParty = Number(rule.minParty);
  if (!Number.isFinite(minParty) || minParty < 2) return null;
  const phone = rule.phone ? (normalizePhoneE164(rule.phone) || String(rule.phone).trim()) : null;
  return {
    id: String(rule.id || crypto.randomUUID()),
    type: "party_size_call",
    minParty,
    phone,
    message: String(rule.message || "").trim() || null,
    sourceText: String(rule.sourceText || "").trim() || null,
    enabled: rule.enabled !== false,
  };
}

export function serializeEnforcedRules(rules = []) {
  const list = (rules || []).map(normalizeEnforcedRule).filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

export function parsePartySizeFromText(text) {
  const sq = stripAccentsLower(text);
  const patterns = [
    /\b(?:jemi|ne\s+jemi|for\s+)?(\d{1,2})\s*(?:persona(?:ve)?|person(?:s|en)?|people|guests|veta|te\s+rinj)\b/,
    /\b(\d{1,2})\s*(?:persona(?:ve)?|person(?:s|en)?|people|guests|veta)\b/,
    /\b(?:party\s+of|group\s+of)\s+(\d{1,2})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(sq);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

export function parsePartySizeFromHistory(historyMessages = []) {
  for (const m of [...(historyMessages || [])].reverse()) {
    if (m?.role !== "user") continue;
    const p = parsePartySizeFromText(String(m.content || ""));
    if (p) return p;
  }
  return null;
}

export function resolveEffectivePartySize({
  text = "",
  historyMessages = [],
  partySize = null,
  memPartySize = null,
  useStaleContext = false,
} = {}) {
  const fromText = parsePartySizeFromText(text);
  if (fromText) return fromText;
  const direct = partySize != null ? Number(partySize) : null;
  if (Number.isFinite(direct) && direct >= 1 && direct <= 100) return direct;
  if (!useStaleContext) return null;
  const fromHistory = parsePartySizeFromHistory(historyMessages);
  if (fromHistory) return fromHistory;
  const mem = Number(memPartySize || 0);
  if (mem >= 1 && mem <= 100) return mem;
  return null;
}

export function compilePartySizeCallFromRuleText(ruleText) {
  const text = String(ruleText || "").trim();
  if (!text) return null;

  const minMatch =
    text.match(/(?:more than|over|above|exceeds?|larger than|më shumë se|mbi|per me shume se)\s*(\d{1,3})\s*(?:people|persons|guests|persona|veta)?/i)
    || text.match(/(?:groups?|parties?)\s+(?:over|above|of|larger than)\s+(\d{1,3})/i)
    || text.match(/(\d{1,3})\s*\+\s*(?:people|persons|guests|persona)/i)
    || text.match(/(?:bookings?|reservations?)\s+(?:for\s+)?(?:more than|over)\s+(\d{1,3})/i);

  if (!minMatch) return null;
  const minParty = Number(minMatch[1]);
  if (!Number.isFinite(minParty) || minParty < 2) return null;

  const mentionsCall =
    /\b(call|phone|telefon|tel|ring|contact|kontakto|telefononi)\b/i.test(text)
    || /\b(do not complete|don't complete|not complete|cannot complete|no complete|mos.*(?:rezerv|book)|nuk.*(?:rezerv|book))\b/i.test(text);
  if (!mentionsCall) return null;

  const phoneMatch = text.match(/\+?[\d][\d\s\-()]{7,}[\d]/);
  const phone = phoneMatch ? (normalizePhoneE164(phoneMatch[0]) || phoneMatch[0].trim()) : null;

  return {
    id: crypto.randomUUID(),
    type: "party_size_call",
    minParty,
    phone,
    message: null,
    sourceText: text,
    enabled: true,
  };
}

export function buildPartySizeCallReply({ minParty, phone, lang = "en", customMessage = null } = {}) {
  if (customMessage) return customMessage.replace(/\{phone\}/g, phone || "").trim();
  const displayPhone = phone || "";
  if (lang === "sq") {
    return displayPhone
      ? `Për grupet mbi ${minParty} persona, ju lutem na telefononi direkt në ${displayPhone}. Nuk mund të përfundojmë rezervime të mëdha përmes WhatsApp. Faleminderit!`
      : `Për grupet mbi ${minParty} persona, ju lutem na kontaktoni direkt me telefon. Nuk mund të përfundojmë rezervime të mëdha përmes WhatsApp. Faleminderit!`;
  }
  return displayPhone
    ? `For groups over ${minParty} people, please call us directly at ${displayPhone}. We can't complete large group bookings via WhatsApp. Thank you!`
    : `For groups over ${minParty} people, please contact us by phone. We can't complete large group bookings via WhatsApp. Thank you!`;
}

export function evaluateEnforcedRules({
  enforcedRules = [],
  text = "",
  historyMessages = [],
  partySize = null,
  memPartySize = null,
  lang = "en",
  businessPhone = null,
  intentType = null,
  conversationPhase = null,
} = {}) {
  const rules = Array.isArray(enforcedRules) ? enforcedRules : parseEnforcedRulesJson(enforcedRules);
  if (!rules.length) return null;

  // Only count party size the customer stated in this turn (text/notes/explicit
  // param). Stale thread history and last_party_size from prior bookings must
  // not trigger large-group blocks on a fresh reservation request.
  const effectivePartySize = resolveEffectivePartySize({
    text,
    historyMessages,
    partySize,
    memPartySize,
    useStaleContext: false,
  });
  if (effectivePartySize == null) return null;

  for (const rule of rules) {
    if (rule.type !== "party_size_call") continue;
    if (effectivePartySize < Number(rule.minParty)) continue;

    const phone = rule.phone || businessPhone || null;
    return {
      enforced: true,
      ruleType: rule.type,
      ruleId: rule.id,
      blockBooking: true,
      partySize: effectivePartySize,
      minParty: rule.minParty,
      reply: buildPartySizeCallReply({
        minParty: rule.minParty,
        phone,
        lang,
        customMessage: rule.message,
      }),
    };
  }

  return null;
}

export function mergeEnforcedRules(currentJson, { add = [], removeIds = [], clearAll = false } = {}) {
  let rules = parseEnforcedRulesJson(currentJson);
  if (clearAll) rules = [];
  if (removeIds.length) {
    const drop = new Set(removeIds.map(String));
    rules = rules.filter((r) => !drop.has(String(r.id)));
  }
  for (const incoming of add) {
    const normalized = normalizeEnforcedRule(incoming);
    if (!normalized) continue;
    const dupeIdx = rules.findIndex(
      (r) => r.type === normalized.type && r.minParty === normalized.minParty
    );
    if (dupeIdx >= 0) {
      rules[dupeIdx] = { ...rules[dupeIdx], ...normalized, id: rules[dupeIdx].id };
    } else {
      rules.push(normalized);
    }
  }
  return serializeEnforcedRules(rules);
}

export function appendCompiledEnforcedFromRuleText(currentJson, ruleText) {
  const compiled = compilePartySizeCallFromRuleText(ruleText);
  if (!compiled) return currentJson ?? null;
  return mergeEnforcedRules(currentJson, { add: [compiled] });
}

export function removeEnforcedRulesMatchingNeedle(currentJson, needle) {
  const norm = String(needle || "").trim().toLowerCase();
  if (!norm) return currentJson ?? null;
  const rules = parseEnforcedRulesJson(currentJson);
  const filtered = rules.filter((r) => {
    const source = String(r.sourceText || "").toLowerCase();
    if (source && source.includes(norm)) return false;
    if (String(r.minParty).includes(norm)) return false;
    return true;
  });
  return serializeEnforcedRules(filtered);
}

export function parsePartySizeFromNotes(notes = "") {
  const raw = String(notes || "");
  const labeled = /party\s*size\s*:\s*(\d{1,3})/i.exec(raw);
  if (labeled) {
    const n = Number(labeled[1]);
    if (n >= 1 && n <= 100) return n;
  }
  return parsePartySizeFromText(raw);
}

export function isBookingRelatedForEnforcement({
  text = "",
  conversationPhase = "general",
  route = "",
  intentType = null,
  interactiveId = "",
} = {}) {
  if (intentType === "book" || intentType === "availability") return true;
  if (isInteractiveBookingAction(interactiveId)) return true;

  const bookingPhases = new Set([
    "booking_flow",
    "availability_check",
    "cancel_request",
    "cancel_pending",
    "reschedule_request",
    "reschedule_pending",
  ]);
  if (bookingPhases.has(conversationPhase)) return true;
  if (String(route).toLowerCase() === "booking") return true;
  if (parsePartySizeFromText(text)) return true;

  const sq = stripAccentsLower(text);
  return /\b(book|rezerv|reservation|appointment|table|slot|availability|termin|takim)\w*/.test(sq);
}

export async function guardBookingEnforcement({
  userId = null,
  contactId = null,
  cfg = null,
  tenant = null,
  text = "",
  historyMessages = [],
  partySize = null,
  notes = "",
  lang = "en",
  memPartySize = null,
  conversationPhase = null,
  route = null,
  intentType = null,
  interactiveId = null,
  requireBookingContext = true,
} = {}) {
  const settings = tenant || cfg || (userId ? await getSettingsForUser(userId) : {});
  let mem = memPartySize;
  if (mem == null && userId && contactId) {
    try {
      const contactMem = await getContactMemory(userId, contactId);
      mem = contactMem?.last_party_size ?? null;
    } catch {}
  }

  const partyInMessage = parsePartySizeFromText(text);
  if (
    requireBookingContext
    && !partyInMessage
    && !isBookingRelatedForEnforcement({
      text,
      conversationPhase: conversationPhase || "general",
      route: route || "",
      intentType,
      interactiveId,
    })
  ) {
    return null;
  }

  const resolvedParty =
    partySize != null
      ? Number(partySize)
      : (partyInMessage ?? parsePartySizeFromNotes(notes) ?? null);

  const effectiveLang = lang || cfg?.__lang || settings?.__lang || "en";

  return evaluateEnforcedRules({
    enforcedRules: getEnforcedRulesFromSettings(settings),
    text,
    historyMessages,
    partySize: resolvedParty,
    memPartySize: mem,
    lang: effectiveLang,
    businessPhone: settings?.business_phone || cfg?.business_phone || null,
  });
}

export async function assertBookingAllowed(params = {}) {
  const enforcement = await guardBookingEnforcement(params);
  if (enforcement?.blockBooking) {
    throw new BookingEnforcedError(enforcement.reply, enforcement);
  }
  return enforcement;
}

export function isInteractiveBookingAction(id = "") {
  const action = String(id || "");
  return /^(BOOKING_START|GREET_BOOK|BOOK_SLOT_|BOOK_DAY_|SERV_PICK_)/.test(action);
}

export function parseEnforceDirective(line) {
  const m = /^ENFORCE\|party_size_call\|(\d{1,3})\|(.*)$/.exec(String(line || "").trim());
  if (!m) return null;
  const minParty = Number(m[1]);
  const phoneRaw = (m[2] || "").trim();
  if (!Number.isFinite(minParty) || minParty < 2) return null;
  const phone = phoneRaw ? (normalizePhoneE164(phoneRaw) || phoneRaw) : null;
  return {
    id: crypto.randomUUID(),
    type: "party_size_call",
    minParty,
    phone,
    message: null,
    sourceText: null,
    enabled: true,
  };
}
