import OpenAI from "openai";
import { normalizePhoneE164 } from "../utils.mjs";
import { detectLanguage, languageInstruction, kbScopeGuidance, conversationalStyleGuidance, conversationContinuityInstruction, howAreYouReplyGuidance, isHowAreYouQuestion, isCustomerWellbeingReply, customerWellbeingReplyGuidance, isThankYouMessage, thanksReplyGuidance, isBusinessIdentityConfirmationQuestion, t as translate } from "./i18n.mjs";
import { formatRefiningRulesForPrompt } from "./refiningDirectives.mjs";
import { buildBookingFieldsPromptBlock } from "./bookingFields.mjs";

// Resolve the reply language from an explicit hint, the current message, and
// recent history, so the assistant consistently mirrors the customer.
function resolveReplyLanguage(userMessage, historyMessages = [], explicitLang = null) {
  if (explicitLang === "sq" || explicitLang === "en") return explicitLang;
  const fromCurrent = detectLanguage(userMessage);
  if (fromCurrent) return fromCurrent;
  try {
    const lastUser = [...(historyMessages || [])]
      .reverse()
      .find((m) => m && m.role === "user" && String(m.content || "").trim());
    const fromHistory = detectLanguage(lastUser?.content);
    if (fromHistory) return fromHistory;
  } catch {}
  return "en";
}

function buildBusinessProfileLine(options = {}) {
  const bizName = String(options.businessName || "").trim();
  const bizType = String(options.businessType || "").trim();
  const bizWebsite = String(options.businessWebsite || "").trim();
  const bizCats = Array.isArray(options.businessCategories)
    ? options.businessCategories.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const parts = [];
  if (bizName) parts.push(`name: ${bizName}`);
  if (bizType) parts.push(`type: ${bizType}`);
  if (bizCats.length) parts.push(`categories: ${bizCats.join(", ")}`);
  if (bizWebsite) parts.push(`website: ${bizWebsite}`);
  return parts.length ? `Business profile: ${parts.join(". ")}.` : "";
}

function parseBusinessCategories(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20) : [];
  } catch {
    return [];
  }
}

// Bound each request so a slow/hung OpenAI call can't stall the webhook reply
// path, and let the SDK transparently retry transient failures (429s, 5xx,
// connection drops) with exponential backoff before we fall back.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 3),
});

export function logOpenAiError(err, label = "OpenAI error") {
  try {
    const status = err?.status || err?.response?.status || null;
    const dataErr = err?.response?.data?.error || err?.error || {};
    const code = dataErr?.code || err?.code || null;
    const type = dataErr?.type || err?.type || null;
    const message = dataErr?.message || err?.message || String(err);
    const isQuota =
      status === 429 ||
      String(code).includes("insufficient_quota") ||
      String(type).includes("insufficient_quota") ||
      /billing.*limit/i.test(String(message)) ||
      /insufficient.*quota/i.test(String(message));
    console.error(`[${label}]`, { status, code, type, message });
    if (isQuota) {
      console.error(
        `[${label}] Detected possible quota/billing exhaustion. Please top up your OpenAI account or check usage limits.`
      );
    }
  } catch (_) {
    console.error(label, err);
  }
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_HISTORY_CHARS = 4000;

// GPT-5 generation and the o-series are "reasoning" models. In Chat Completions
// they use `max_completion_tokens` (not `max_tokens`), only accept the default
// temperature, and ignore the classic samplers. They also spend tokens on hidden
// reasoning, so we raise the output ceiling to avoid empty/truncated replies.
function isReasoningModel(model) {
  return /^(gpt-5|o[1-9])/i.test(String(model || ""));
}

// True when an OpenAI error indicates a request parameter is unsupported by the
// target model/deployment (a non-retryable 400 we can recover from by dropping
// the offending field rather than failing the whole reply).
function isUnsupportedParamError(err, param) {
  const status = err?.status || err?.response?.status || null;
  if (status && status !== 400) return false;
  const message = String(err?.error?.message || err?.message || "").toLowerCase();
  if (!message) return false;
  return message.includes(String(param).toLowerCase())
    && (message.includes("unsupported") || message.includes("not supported") || message.includes("invalid"));
}

// Drop-in replacement for openai.chat.completions.create that adapts the request
// to whichever model is configured, so call sites can keep using temperature /
// max_tokens uniformly regardless of the model family.
async function createChat(params = {}) {
  const model = params.model || MODEL;
  const body = { ...params, model };
  if (isReasoningModel(model)) {
    const requested = body.max_completion_tokens ?? body.max_tokens;
    delete body.max_tokens;
    if (requested != null) body.max_completion_tokens = Math.max(Number(requested) || 0, 1200);
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    if (!body.reasoning_effort) body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT || "medium";
  }
  try {
    return await openai.chat.completions.create(body);
  } catch (err) {
    // If a model doesn't accept response_format (JSON mode), degrade gracefully
    // instead of failing every decision — the caller still parses/repairs JSON.
    if (body.response_format && isUnsupportedParamError(err, "response_format")) {
      const { response_format, ...rest } = body;
      return openai.chat.completions.create(rest);
    }
    throw err;
  }
}

const REFINING_LINE_PATTERNS = [
  /^REPLY\|[^\n]+$/,
  /^ASK_MORE\|[^\n]+$/,
  /^ADD_RULE\|.+$/,
  /^REMOVE_RULE\|.+$/,
  /^CLEAR_RULES$/,
  /^ADD_KB\|[^|\n]{1,60}\|.+$/,
  /^SET\|[a-z_]+\|.+$/,
  /^ENFORCE\|party_size_call\|\d{1,3}\|.*$/,
  /^BOOKING_PROFILE\|(restaurant|appointment)$/,
  /^ADD_BOOKING_FIELD\|[^|\n]+\|[^|\n]+(\|[^|\n]*)*$/,
  /^REMOVE_BOOKING_FIELD\|[^|\n]+$/,
  /^CLEAR_BOOKING_FIELDS$/,
];

function isValidRefiningDslResponse(s) {
  if (!s) return false;
  if (/^```|```$|^\s*-/m.test(s)) return false;
  const lines = s.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return false;

  let replyCount = 0;
  let askMoreCount = 0;
  let hasAddRule = false;

  for (const line of lines) {
    if (!REFINING_LINE_PATTERNS.some((p) => p.test(line))) return false;
    if (line.startsWith("REPLY|")) replyCount++;
    if (line.startsWith("ASK_MORE|")) askMoreCount++;
    if (line.startsWith("ADD_RULE|")) hasAddRule = true;
  }

  if (askMoreCount > 1) return false;
  if (replyCount > 1) return false;
  if (askMoreCount === 1 && hasAddRule) return false;
  if (askMoreCount === 1) return askMoreCount === 1;
  return replyCount === 1;
}

function buildRefiningRulesBlock(options = {}) {
  return formatRefiningRulesForPrompt(options?.refiningRules || "");
}

function isValidDslResponse(s) {
  if (!s) return false;
  if (/^```|```$|^\s*-/m.test(s)) return false;
  const LINE_PATTERNS = [
    /^ASK_MORE\|[^\n]+$/,
    /^ADD_KB\|[^|\n]{1,60}\|.+$/,
    /^SET\|[a-z_]+\|.+$/,
    /^COMPLETE$/,
  ];
  const lines = s.trim().split(/\r?\n/);
  if (!lines.length) return false;
  let askMore = 0;
  let hasComplete = false;
  for (const line of lines) {
    if (!LINE_PATTERNS.some((p) => p.test(line))) return false;
    if (line.startsWith("ASK_MORE|")) askMore++;
    if (line === "COMPLETE") hasComplete = true;
  }
  if (askMore > 1) return false;
  if (askMore === 1 && hasComplete) return false;
  return true;
}

function escapePipes(s) {
  return String(s ?? "").replace(/\|/g, "\\|").trim();
}

function normalizeCoachKbEntries(kbItems = []) {
  return (kbItems || [])
    .map((item) => {
      if (typeof item === "string") {
        return { title: item.trim(), content: "" };
      }
      return {
        title: String(item?.title || "").trim(),
        content: String(item?.content || "").trim(),
      };
    })
    .filter((item) => item.title);
}

function formatCoachKbForPrompt(kbItems = []) {
  const entries = normalizeCoachKbEntries(kbItems);
  if (!entries.length) return "(none yet)";
  return entries
    .map((item) => {
      const title = escapePipes(item.title || "Untitled");
      const content = String(item.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1200);
      return content ? `- ${title}: ${content}` : `- ${title}: (empty)`;
    })
    .join("\n");
}

function detectLanguageHint(userMessage) {
  const m = userMessage || "";
  const hasNonASCII = /[^\u0000-\u007f]/.test(m);
  if (hasNonASCII) return "User language: non-English likely; reply in the user's language.";
  if (/\b(hola|bonjour|ciao|hallo|hej|salut|ola|merhaba|γειά|привет)\b/i.test(m))
    return "User language: non-English likely; reply in the user's language.";
  return "User language: English; reply in English unless user writes otherwise.";
}

function normalizeUrl(value) {
  if (!value) return null;
  let v = value.trim();
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}

function normalizeBusinessName(value) {
  if (!value) return null;
  let v = String(value)
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return null;
  const generic = /^(my|our|the)?\s*(restaurant|shop|business|store)$/i;
  if (generic.test(v)) return null;
  if (!/[a-zA-Z]/.test(v)) return null;
  const titled = v
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return titled;
}
function parseAddKb(line) {
  if (!line.startsWith("ADD_KB|")) return [false, "", ""];
  const rest = line.slice("ADD_KB|".length);
  const parts = [];
  let buf = "";
  let esc = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (esc) {
      buf += ch;
      esc = false;
    } else if (ch === "\\") {
      esc = true;
    } else if (ch === "|") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  if (parts.length < 2) return [false, "", ""];
  const title = (parts[0] || "").trim();
  const content = parts.slice(1).join("|").trim();
  if (!title || !content) return [false, "", ""];
  return [true, title, content];
}

function normalizeSetLines(response) {
  const lines = response.trim().split(/\r?\n/);
  const out = [];
  const hasAskMoreAlready = lines.some((l) => l.startsWith("ASK_MORE|"));
  const hasComplete = lines.some((l) => l.trim() === "COMPLETE");
  let addedAskMore = false;
  for (const line of lines) {
    if (!line.startsWith("SET|")) {
      out.push(line);
      continue;
    }
    const m = /^SET\|([a-z_]+)\|(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rawVal = m[2].trim();
    if (key === "business_phone") {
      const norm = normalizePhoneE164(rawVal);
      out.push(`SET|business_phone|${norm ?? rawVal}`);
    } else if (key === "website_url") {
      const norm = normalizeUrl(rawVal);
      out.push(`SET|website_url|${norm ?? rawVal}`);
    } else if (key === "business_name") {
      const norm = normalizeBusinessName(rawVal);
      if (norm) {
        out.push(`SET|business_name|${norm}`);
      } else {
        out.push(line);
        if (!hasAskMoreAlready && !hasComplete && !addedAskMore) {
          out.push("ASK_MORE|Could you share your exact business name as customers would see it?");
          addedAskMore = true;
        }
      }
    } else {
      out.push(line);
    }
  }
  return out.join("\n").trim();
}

function applyReplacePolicy(response) {
  const lines = response.trim().split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.startsWith("ADD_KB|")) {
      const [ok, title, content] = parseAddKb(line);
      if (ok) out.push(`ADD_KB|${title}|${content}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n").trim();
}
export async function generateAiReply(userMessage, contextSnippets, options = {}) {
  const context =
    (contextSnippets || [])
      .map((s, i) => `# Doc ${i + 1}: ${s.title || "Untitled"}\n${s.content}`)
      .join("\n\n") || "(no docs)";

  const tone = (options.tone || "friendly").trim();
  const style = (options.style || "clear and concise").trim();
  const blockedTopics = String(options.blockedTopics || "").trim();
  const historyMessages = Array.isArray(options.historyMessages) ? options.historyMessages : [];
  const bizCats = parseBusinessCategories(options.businessCategories);
  const businessProfileLine = buildBusinessProfileLine({
    businessName: options.businessName,
    businessType: options.businessType,
    businessWebsite: options.businessWebsite,
    businessCategories: bizCats,
  });
  const bizType = String(options.businessType || "").trim();

  const blockedLine = blockedTopics
    ? `Refuse questions about these topics: ${blockedTopics}. If asked, briefly refuse and suggest contacting support.`
    : "";

  const mismatchGuidance = (businessProfileLine || bizType || bizCats.length)
    ? "If the user appears to be asking about a different company/industry than this business, politely clarify what this business does and guide them accordingly (do not pretend to offer unrelated services)."
    : "";

  const lang = resolveReplyLanguage(userMessage, historyMessages, options.lang);
  const conversationStarted = !!options.conversationStarted;
  const userMessageIsGreeting = !!options.userMessageIsGreeting;
  const policy = [
    "You are a warm, helpful human assistant for a business on WhatsApp — never sound like a robot or an automated menu.",
    languageInstruction(lang),
    kbScopeGuidance(lang),
    conversationalStyleGuidance(lang),
    conversationContinuityInstruction(conversationStarted, userMessageIsGreeting, userMessage),
    isHowAreYouQuestion(userMessage) ? howAreYouReplyGuidance(lang) : "",
    isCustomerWellbeingReply(userMessage) ? customerWellbeingReplyGuidance(lang) : "",
    isThankYouMessage(userMessage) ? thanksReplyGuidance(lang) : "",
    buildRefiningRulesBlock(options),
    options?.refiningRules
      ? (lang === "sq"
        ? "Kur zbatohet një rregull i pronarit, përshëndet klientin nëse ka përshëndetur dhe mbyll me 'Faleminderit!' kur jep një përgjigje të plotë ose ridrejtim — mos u përgjigj vetëm me tekst politik pa ngrohtësi."
        : "When applying an owner rule, greet the customer if they greeted you and end with 'Thank you!' when giving a complete answer or redirect — never deliver a dry policy-only reply.")
      : "",
    "Exception: For generic pleasantries (e.g., 'how are you', greetings, thanks, apologies, simple emojis), respond briefly and warmly WITHOUT using the out-of-scope phrase. For thanks, reciprocate (e.g. 'S'ka problem, faleminderit!'). Never say 'po jam këtu' or 'yes I'm here'.",
    "Never invent facts.",
    "Interpret typos, slang, dialect, and paraphrases generously.",
    blockedLine ? blockedLine : "",
    "Tone: " + tone + ". Style: " + style + ".",
    businessProfileLine ? businessProfileLine : "",
    mismatchGuidance ? mismatchGuidance : "",
    "Booking guidance (no pickers): If the customer wants to book but is missing date, time, party size, or name, ask for ONE missing detail — never claim it is booked.",
    "Availability: only discuss open times when the customer explicitly asks to see times; otherwise ask clarifying questions.",
    "Never claim a reservation or cancellation is confirmed, complete, or being sent — the server handles those actions.",
    "If Customer Profile shows an Upcoming appointment, use it when the user asks about their booking, cancel, or reschedule.",
  ].filter(Boolean).join("\n");
  const messages = [
    { role: "system", content: policy },
    { role: "system", content: "Docs:\n" + context },
  ];
  for (const m of historyMessages.slice(-10)) {
    try {
      const role = (m && (m.role === 'assistant' || m.role === 'user')) ? m.role : 'user';
      const content = String(m?.content || '').slice(0, 1000);
      if (content) messages.push({ role, content });
    } catch {}
  }

  messages.push({ role: "user", content: String(userMessage || "").slice(0, 2000) });

  try {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 380,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
    });
    return resp.choices[0]?.message?.content?.trim() || null;
  } catch (e) {
    logOpenAiError(e, "AI reply error");
    return null;
  }
}
export async function generateAssistantNudge(kind, data = {}, options = {}) {
  const tone = (options.tone || 'friendly').trim();
  const style = (options.style || 'clear and concise').trim();
  const lang = (options.lang === 'sq' || options.lang === 'en') ? options.lang : 'en';
  const policy = [
    'You generate a SINGLE short WhatsApp message as the assistant.',
    'Keep it warm, human, and concise (<= 2 sentences). Sound like a real person, never robotic.',
    'Do NOT append "let me know if you need anything else" or similar closers. Answer only what was asked.',
    languageInstruction(lang),
    'No markdown, no bullets, no code fences.',
    'Tone: ' + tone + '. Style: ' + style + '.',
  ].join('\n');

  const guidance = {
    greeting: 'Send a short, warm first greeting for WhatsApp. One sentence.',
    out_of_hours: 'Explain you are currently outside working hours and will reply later. One sentence.',
    holding: 'Acknowledge the user and say an agent will be with them shortly. One sentence.',
    handoff_followup: 'Reassure the user that a human agent is on the way, referencing any known context (reason/wait time). One or two short sentences.',
    no_staff: 'Explain bookings are enabled but staff isn’t configured yet. One sentence.',
    too_close: 'Explain it is too close to the start time (use provided minutes) and suggest contacting directly. One sentence.',
    reminder_ok: 'Acknowledge that the reminder time is fine. One sentence.',
    reminder_missing: 'Explain the referenced booking was canceled or changed; offer to start a new booking. One sentence.',
    reminder_prompt: 'Prompt the user to confirm or change an appointment time briefly.',
    cancel_confirm_instructions: 'Tell user how to confirm cancellation or keep the booking, referencing a ref number.',
    handoff_ask_name: 'Ask for the user’s name before connecting to a human. One sentence.',
    handoff_ask_reason: 'Ask for a short reason for escalation to a human. One sentence.',
    handoff_connecting: 'Acknowledge and say you are connecting the user to a human. One sentence.',
    generic_ack: 'A generic short acknowledgement such as “okay” adjusted to context. One sentence.',
    ask_datetime: 'Ask the user to share a preferred date and exact clock time. Include one or two compact examples. Avoid commands; be polite.',
    ask_specific_time: 'The user gave a date or daypart but no exact hour. Ask for a specific time (e.g. 8:30 PM). One warm sentence.',
    ask_range: 'Ask the user for a date range to check availability. Mention examples like “tomorrow”, “Nov 3”, or “Nov 3–5”.',
    availability_offer: 'The user asked about availability. Greet them naturally if their message included a greeting. Confirm the date/daypart they asked about, say you have some open times, and invite them to write their preferred time in a message — do NOT ask them to pick from a list. One or two warm sentences.',
    closest_times: 'Explain the requested time is unavailable and present the provided list of closest options inline, inviting the user to type their preferred time.',
    no_times: 'Say there are no open times for the selected date/range and invite the user to try another date/time or daypart.',
    past_time_warning: 'Explain the time has already passed and ask for a future date/time with a compact example.',
    confirm_booking: 'Confirm the booking time warmly in one or two natural sentences. Do not mention a follow-up question or form.',
    reschedule_request: 'Ask for a new preferred date and time to reschedule, with a compact example.',
    no_booking_found: 'Explain you cannot find any upcoming booking for this phone and offer to start a new booking.',
    cancel_aborted: "Acknowledge you won't cancel and invite the user to say 'cancel' later if needed.",
    slot_book_failed: 'Apologize briefly and ask the user to type another preferred time.',
    reset_done: 'Acknowledge the booking flow has been reset and invite the user to share a new date/time.',
  }[kind] || 'Write a short, helpful message for this assistant action.';

  const payload = {
    kind,
    data,
  };

  try {
    const resp = await createChat({
      model: MODEL,
      temperature: 0.4,
      max_tokens: 120,
      messages: [
        { role: 'system', content: policy },
        { role: 'user', content: `Guidance: ${guidance}\n\nVariables (JSON):\n${JSON.stringify(payload, null, 2)}\n\nWrite the single assistant message now:` },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    logOpenAiError(e, 'AI nudge error');
    const LOCALIZED_KINDS = new Set([
      'ask_datetime', 'ask_specific_time', 'ask_range', 'closest_times', 'no_times', 'past_time_warning',
      'reschedule_request', 'confirm_booking', 'no_booking_found', 'cancel_aborted',
      'slot_book_failed', 'reset_done', 'handoff_ask_name', 'handoff_ask_reason',
      'handoff_connecting', 'cancel_confirm_instructions', 'availability_offer',
    ]);
    if (LOCALIZED_KINDS.has(kind)) return translate(kind, lang, data);
    if (kind === 'handoff_followup') {
      return lang === 'sq'
        ? "Faleminderit për durimin, ende po të lidh me një koleg."
        : "Thanks for your patience, I'm still connecting you with a human teammate.";
    }
    return lang === 'sq' ? 'Në rregull.' : 'Okay.';
  }
}

/** Focused FAQ reply from a single KB doc (cross-language). */
export async function answerFromKbFaq(userMessage, kbDoc, options = {}) {
  const historyMessages = Array.isArray(options.historyMessages) ? options.historyMessages : [];
  const lang = resolveReplyLanguage(userMessage, historyMessages, options.lang);
  const tone = String(options.tone || "friendly").trim();
  const style = String(options.style || "warm and natural").trim();
  const businessName = String(options.businessName || "").trim();
  const title = String(kbDoc?.title || "").trim();
  const content = String(kbDoc?.content || "").trim();
  if (!title || !content) return null;

  const policy = [
    "You are a warm, attentive team member replying to a customer on WhatsApp.",
    languageInstruction(lang),
    conversationalStyleGuidance(lang),
    "Answer using ONLY the FAQ facts below — never invent details.",
    "Give a direct answer and stop. Do NOT add 'if you need anything else' or similar at the end.",
    "If the FAQ answer is 'Yes' or 'No', expand it into a natural, complete reply (not one word).",
    options.conversationContextBrief
      ? (lang === "sq"
        ? "Përdor KONTEKSTIN E BISEDËS më poshtë — mos ripyet për fakte që klienti i ka dhënë tashmë."
        : "Use CONVERSATION CONTEXT below — do not re-ask for facts the customer already provided.")
      : "",
    options.shouldGreet
      ? (lang === "sq"
        ? "Mos përfshi përshëndetje — sistemi e shton automatikisht."
        : "Do NOT include a greeting — the system adds one automatically.")
      : "",
    `Tone: ${tone}. Style: ${style}.`,
    businessName ? `You represent ${businessName}.` : "",
    buildRefiningRulesBlock(options),
    options?.refiningRules
      ? (lang === "sq"
        ? "Kur zbatohet një rregull i pronarit, përshëndet klientin nëse ka përshëndetur dhe mbyll me 'Faleminderit!' kur jep një përgjigje të plotë ose ridrejtim — mos u përgjigj vetëm me tekst politik pa ngrohtësi."
        : "When applying an owner rule, greet the customer if they greeted you and end with 'Thank you!' when giving a complete answer or redirect — never deliver a dry policy-only reply.")
      : "",
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: policy },
    { role: "system", content: `FAQ question: ${title}\nFAQ answer: ${content}` },
    options.conversationContextBrief
      ? { role: "system", content: String(options.conversationContextBrief) }
      : null,
  ].filter(Boolean);
  for (const m of historyMessages.slice(-6)) {
    try {
      const role = m && (m.role === "assistant" || m.role === "user") ? m.role : "user";
      const body = String(m?.content || "").slice(0, 800);
      if (body) messages.push({ role, content: body });
    } catch {}
  }
  messages.push({ role: "user", content: String(userMessage || "").slice(0, 500) });

  try {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0.55,
      max_tokens: 320,
    });
    return resp.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    logOpenAiError(e, "KB FAQ answer error");
    return null;
  }
}

export async function generateAgentDecision(userMessage, contextSnippets, options = {}) {
  const context =
    (contextSnippets || [])
      .map((s, i) => `# Doc ${i + 1}: ${s.title || "Untitled"}\n${s.content}`)
      .join("\n\n") || "(no docs)";

  const tone = String(options.tone || 'friendly').trim();
  const style = String(options.style || 'clear and concise').trim();
  const blockedTopics = String(options.blockedTopics || '').trim();
  const historyMessages = Array.isArray(options.historyMessages) ? options.historyMessages : [];
  const features = options.features || {};
  const bizCats = parseBusinessCategories(options.businessCategories || features.business_categories);
  const businessProfileLine = buildBusinessProfileLine({
    businessName: options.businessName || features.business_name,
    businessType: options.businessType || features.business_type,
    businessWebsite: options.businessWebsite || features.business_website,
    businessCategories: bizCats,
  });
  const bizType = String(options.businessType || features.business_type || '').trim();

  const blockedLine = blockedTopics
    ? `Refuse questions about these topics: ${blockedTopics}. If asked, briefly refuse and suggest contacting support.`
    : "";

  const isEscalationMode = String(features.conversation_mode || '').toLowerCase() === 'escalation';
  const escalationQuestions = Array.isArray(features.escalation_questions) ? features.escalation_questions.filter(Boolean).slice(0, 10) : [];
  const knownCustomerName = String(features.customer_name || '').trim();

  const lang = resolveReplyLanguage(userMessage, historyMessages, options.lang);
  const bookingFieldsBlock = buildBookingFieldsPromptBlock(options.bookingFields || [], lang);
  const collectsPartySize = (options.bookingFields || []).some((f) => f.type === "party_size");
  const conversationStarted = !!options.conversationStarted;
  const userMessageIsGreeting = !!options.userMessageIsGreeting;
  const isBusinessOverviewQuestion = !!options.isBusinessOverviewQuestion;
  const primaryKb = isBusinessOverviewQuestion ? null : (options.primaryKbMatch || null);
  const shouldGreet = !!options.shouldGreet;

  const systemParts = [
    "You are a friendly, sharp human assistant for a business on WhatsApp. You chat naturally, like a real, attentive employee — warm and genuinely helpful. Never sound scripted, robotic, or like an automated menu.",
    languageInstruction(lang),
    `Tone: ${tone}. Style: ${style}.`,
    kbScopeGuidance(lang),
    conversationalStyleGuidance(lang),
    conversationContinuityInstruction(conversationStarted, userMessageIsGreeting, userMessage),
    isHowAreYouQuestion(userMessage) ? howAreYouReplyGuidance(lang) : "",
    isCustomerWellbeingReply(userMessage) ? customerWellbeingReplyGuidance(lang) : "",
    isThankYouMessage(userMessage) ? thanksReplyGuidance(lang) : "",
    isBusinessIdentityConfirmationQuestion(userMessage)
      ? (lang === "sq"
        ? "Klienti vetëm po konfirmon që ka shkruar te biznesi i duhur (p.sh. 'flas me ...?'). Përgjigju shkurt: Po, po flisni me [emri i biznesit]. Si mund t'ju ndihmoj? MOS shto llojin e biznesit, qytetin, kuzhinën, ose prezantim — ata e dinë tashmë ku kanë shkruar."
        : "The customer is only confirming they reached the right business (e.g. 'am I speaking with X?'). Reply briefly: Yes, you're speaking with [business name]. How can I help? Do NOT add business type, city, cuisine, or a pitch — they already know who they messaged.")
      : "",
    buildRefiningRulesBlock(options),
    bookingFieldsBlock,
    options?.refiningRules
      ? (lang === "sq"
        ? "Kur zbatohet një rregull i pronarit, përshëndet klientin nëse ka përshëndetur dhe mbyll me 'Faleminderit!' kur jep një përgjigje të plotë ose ridrejtim — mos u përgjigj vetëm me tekst politik pa ngrohtësi."
        : "When applying an owner rule, greet the customer if they greeted you and end with 'Thank you!' when giving a complete answer or redirect — never deliver a dry policy-only reply.")
      : "",
    "Read the whole conversation and the customer's intent before replying. Acknowledge what they said, answer directly, and keep momentum toward what they actually want. Never say 'po jam këtu' or 'yes I'm here'.",
    "Use CONVERSATION CONTEXT and LIVE SESSION CONTEXT as ground truth for facts already established in this thread — never re-ask for details the customer already provided.",
    "When the customer changes topic (e.g. from booking to menu, hours, or location), answer the new question clearly first, then only if natural mention the earlier thread. Stay professional and never sound confused or contradictory.",
    "Mirror the customer's energy: match their pace, but stay warm — never reply with a dry one-liner when a fuller answer would feel more human.",
    blockedLine ? blockedLine : "",
    businessProfileLine ? businessProfileLine : "",
    (businessProfileLine || bizType || bizCats.length) ? "If the user's request clearly targets a different kind of business, briefly clarify what this business does and steer them to relevant options (do not claim unrelated services)." : ""
  ];

  if (isBusinessOverviewQuestion) {
    systemParts.push(
      lang === "sq"
        ? "Klienti po kërkon një përmbledhje të përgjithshme rreth biznesit. Përgjigju me 3–5 fjali të ngrohta që përshkruajnë emrin, çfarë bëni, vendndodhjen/orarin (nëse janë në Docs), vlerësimin Google (nëse ka), dhe faqen e internetit — mos u kufizo vetëm te një FAQ të ngushtë si menu ose pagesa."
        : "The customer wants a general overview of the business. Reply with a warm 3–5 sentence introduction covering name, what you do, location/hours (if in Docs), Google rating (if present), and website — do not narrow the answer to a single FAQ like menu or payments."
    );
  } else if (primaryKb?.title && primaryKb?.content) {
    systemParts.push(
      `PRIMARY FAQ MATCH for this message — you MUST answer using these facts:\nQuestion: ${primaryKb.title}\nAnswer: ${primaryKb.content}`
    );
  }

  if (shouldGreet) {
    systemParts.push(
      lang === "sq"
        ? "Mos përfshi përshëndetje — sistemi e shton automatikisht. Përgjigju pyetjes drejtpërdrejt."
        : "Do NOT include a greeting — the system adds one automatically. Answer directly."
    );
  }

  if (options.conversationPhase === "booking_flow") {
    systemParts.push(
      lang === "sq"
        ? (collectsPartySize
          ? "Je duke mbledhur detajet e rezervimit. Mos përsërit adresën. Përdor intent book VETËM kur ke datën, orën dhe të gjitha fushat e detyrueshme nga BOOKING FIELDS."
          : "Je duke mbledhur detajet e terminit. Mos pyet sa persona. Përdor intent book VETËM kur ke datën, orën dhe të gjitha fushat e detyrueshme nga BOOKING FIELDS.")
        : (collectsPartySize
          ? "You are collecting booking details. Do not repeat the address. Use intent book ONLY when you have date, time, and all required BOOKING FIELDS."
          : "You are collecting appointment details. Do not ask party size. Use intent book ONLY when you have date, time, and all required BOOKING FIELDS.")
    );
  }

  if (options.multiTopic && Array.isArray(options.messageTopics) && options.messageTopics.length > 1) {
    const topicList = options.messageTopics.join(", ");
    systemParts.push(
      lang === "sq"
        ? `Klienti bëri MË SHUMË SE NJË pyetje në të njëjtin mesazh (${topicList}). Përgjigju të GJITHA pjesëve në një përgjigje të vetme — mos injoro asnjë pyetje. Përdor 2–3 fjali të shkurtra ose lista me pika.`
        : `The customer asked MORE THAN ONE question in the same message (${topicList}). Answer EVERY part in one cohesive reply — do not ignore any question. Use 2–3 short sentences or bullet points.`
    );
    if (options.messageTopics.includes("overview")) {
      systemParts.push(
        lang === "sq"
          ? "Klienti kërkon info rreth restorantit/biznesit — përgjigju shkurt (çfarë jeni, stili, ushqimi) nga Docs/KB para pjesës së tjera."
          : "They asked about the business itself — answer briefly (what you are, style, cuisine) from Docs/KB before any other part."
      );
    }
    if (options.messageTopics.includes("location")) {
      systemParts.push(
        lang === "sq"
          ? "Nëse pyet për vendndodhjen, përmend adresën shkurt vetëm për pjesën e vendndodhjes — harta GPS dërgohet veçmas. Mos e përsërit adresën kur vazhdon biseda për rezervim."
          : "If they asked for location, mention the address briefly only for the location part — the GPS map pin is sent separately. Do not repeat the address when the conversation moves on to booking."
      );
    }
    if (options.messageTopics.includes("booking") && features.bookings_enabled) {
      systemParts.push(
        lang === "sq"
          ? "Nëse pyet nëse keni rezervime të lira ose dëshiron të rezervojë, përgjigju shkurt (p.sh. konfirmo datën) dhe pyet sa persona do të jenë — mos listo orare; serveri i liston vetëm kur klienti kërkon sugjerime."
          : "If they asked whether you have reservations or want to book, answer briefly (e.g. confirm the date) and ask how many people — do not list time slots; the server only lists slots when they explicitly ask for suggestions."
      );
    }
    if (options.messageTopics.includes("availability") && features.bookings_enabled) {
      systemParts.push(
        lang === "sq"
          ? "Klienti kërkon sugjerime oraresh — përgjigju shkurt dhe përdor intent availability; serveri do të dërgojë listën e orareve pas mesazhit tënd."
          : "They explicitly asked to see available times — reply briefly and use intent availability; the server will send the slot list after your message."
      );
    }
  }

  if (isEscalationMode) {
    systemParts.push(
      "Escalation Mode is active: you must not fulfill or resolve the request yourself.",
      "Your sole objective is to collect the information requested in the Escalation Questions and then connect the user with a human.",
      "Ask exactly ONE question per reply. Follow the Escalation Questions list in order, always starting with the first unanswered item.",
      "Always ensure the customer's name is captured before escalating. If a known name is provided, skip that question.",
      "Keep responses under two short sentences. Never say that something is booked/reserved/confirmed or that the issue is fully resolved.",
      "When all questions appear answered (or the user explicitly asks for a human), output intent = { type: 'handoff', data: { summary: '<brief summary>', name?: string, reason?: string } } and reply with a short acknowledgement such as “Thanks! Connecting you with a human now.”",
      "Capture the customer's name inside intent.data.name whenever they provide it.",
      "Intent types allowed: handoff or none."
    );
  } else {
    systemParts.push(
      "Primary goal: genuinely help the customer get what they want with replies that feel human, friendly, and effortless.",
      "Be an excellent booking assistant: if the customer wants to book, reschedule, cancel, or check availability, take initiative. Confirm what you understood from this conversation, and ask only for what is truly missing — one short, natural question at a time in the customer's language.",
      collectsPartySize
        ? "Collect party size, a specific clock time, and other required BOOKING FIELDS when missing. Party size must come from the customer in this conversation — never assume or reuse from memory."
        : "Collect a specific clock time and all required BOOKING FIELDS when missing. Do NOT ask how many people — this business books one customer per appointment.",
      "Do NOT ask why they are visiting or recall past occasions/reasons from earlier chats — only the customer's name may be remembered.",
      "When the customer gives a date and/or time in ANY phrasing or language (e.g. 'tomorrow at 3', 'nesër ora 15:00', 'Friday afternoon', 'nesër në dark', 'next week'), capture it and pass it through as the intent — do not ask them to rephrase into a specific format.",
      "For evening/morning/afternoon WITHOUT a specific hour (e.g. 'nesër në dark', 'tomorrow evening'), that is NOT enough to book — use intent none and ask for an exact clock time. Do NOT list or offer available times unless they explicitly ask to see them.",
      "For evening/morning/afternoon requests, set intent.data.timeOfDay to 'morning', 'afternoon', or 'evening' (e.g. 'në dark' / 'in the evening' → evening) when relevant, but still use intent none until they give an exact hour.",
      "Use intent type availability ONLY when the customer explicitly asks to see open times or wants slot suggestions (e.g. 'what times do you have?', 'cilat orare keni?', 'show me available times', 'shiko oraret'). Asking whether you have free reservations or tables for a date is NOT an availability request — use intent book or none and ask how many people.",
      collectsPartySize
        ? "Use intent type book ONLY when date, a specific clock time, party size, and all other required BOOKING FIELDS are known. If anything is missing, use intent none and ask one short question."
        : "Use intent type book ONLY when date, a specific clock time, and all required BOOKING FIELDS are known (no party size needed). If anything is missing, use intent none and ask one short question.",
      "When the customer names a specific time (e.g. 'at 9:30', 'në orën 21:30', '9') but their name is still missing, use intent none and ask for their name — do NOT use intent book yet.",
      "INTENT TYPES: availability, book, reschedule, cancel, update_name, handoff, none.",
      "For availability/book/reschedule intents, include the customer's natural date/time phrase in intent.data (e.g. data.datetime or data.range); the server will parse Albanian and English phrasing.",
      "When the customer gives party size only (e.g. '5 persona') without a specific clock time in the SAME message, use intent none ONLY if date/time is not already established earlier in the thread — if they already gave date+time and now only add party size, use intent none until you also have their name.",
      "Never include partySize in intent.data unless the customer stated it in this conversation. Do not say you are keeping or assuming a party size — ask how many people instead.",
      "When the customer gives their name, include intent.data.name — the server saves it. Do NOT include intent.data.reason or mention past visit reasons.",
      "When the customer replies with their name ONLY after you asked for it (and date, time, and party size are already in the thread), use intent book with intent.data.name (and partySize if known). Your text should be a brief ack only — the SERVER creates the booking and sends the confirmation with ref #.",
      "Do NOT claim a reservation is confirmed, complete, or being sent in your text — the server creates the calendar booking and sends ref # after intent book succeeds.",
      "If Docs include a Customer Profile with Upcoming (date/time and Ref #), use it when the user asks about their booking, wants to cancel, or reschedule — do not ask them to repeat details you already have.",
      "CANCEL FLOW (two steps): (1) User asks to cancel (question) → intent cancel; text = acknowledge the upcoming booking and ask them to confirm (e.g. 'po anuloje' / 'konfirmo'). Never say it is canceled or being processed. (2) User confirms → intent cancel; text = short ack only; the SERVER sends the final canceled confirmation.",
      "RESCHEDULE: never say the appointment is moved or that you are sending/processing the change — the server confirms after it updates the calendar. Use intent reschedule with data.datetime when a new time is given. For time-only changes (e.g. 'ne oren 9'), pass the new hour in data.datetime and keep the same date from context.",
      "NAME CHANGE: when the customer asks to change/rename the name on their upcoming booking, use intent update_name with intent.data.name set to the NEW name only. Your text should be a brief acknowledgement only — the SERVER updates the booking and sends the confirmation. Never escalate to a human or say you are passing it to the team for a simple name change.",
      "Never treat neutral replies ('ok', 'ne rregull', 'faleminderit', 'thanks') as cancel confirmation — only explicit confirm phrases count.",
      "For handoff/human requests, use intent type handoff with intent.data.name when known; your reply should acknowledge and the server starts the escalation flow.",
      "If a Service catalog is provided, and the user asks about booking or prices/services, present a compact list of services (name, minutes, price if available) and ask the user to pick one.",
      "Format the services inline with semicolons, e.g., \"Basic (30 min, $40); Deluxe (60 min, $70)\". Keep it to one short line if possible.",
      "Never invent services or prices; use only the provided catalog. If no price is available for a service, omit the price."
    );
    if (!features.bookings_enabled) {
      systemParts.push(
        "Bookings are disabled for this business. Do NOT emit book, cancel, reschedule, update_name, or availability intents — use intent none and explain that online booking is not available."
      );
    }
  }

  systemParts.push(
    "Infer date and time from prior messages in this conversation when already stated. Party size is NOT inferred from memory or past visits — ask the customer unless they already said it in this thread. Do not repeat questions already answered in this booking flow.",
    "The JSON `text` field should read like a natural WhatsApp message (usually 2–4 sentences for info/FAQ answers; shorter only for simple acks or booking prompts).",
    "Never use the em dash character (—) in the JSON text field; use commas, periods, or short sentences.",
    "Do NOT end replies with boilerplate like 'let me know if you need anything else', 'këtu jam nëse...', or 'më thuaj nëse dëshiron'. Stop after answering unless you must ask for missing booking info.",
    "OUTPUT STRICTLY AS A SINGLE JSON OBJECT with keys: text, intent (optional). No markdown.",
    "JSON examples (output one object only):",
    '{"text":"Sigurisht, a e anuloj rezervimin? Shkruaj \\"po anuloje\\" ose \\"konfirmo\\" për ta konfirmuar.","intent":{"type":"cancel"}}',
    '{"text":"Patjetër. Për cilën datë dhe në çfarë ore e doni rezervimin? Sa persona jeni?","intent":{"type":"none"}}',
    '{"text":"Patjetër, nesër në orën 20:00 për 5 persona. Si quheni?","intent":{"type":"none"}}',
    '{"text":"Faleminderit, Bashruti.","intent":{"type":"book","data":{"name":"Bashruti Kuki","partySize":5}}}',
    '{"text":"Patjetër, për nesër në mbrëmje. Cila orë saktësisht ju përshtatet?","intent":{"type":"none"}}',
    '{"text":"Po, ja disa orare të lira për nesër.","intent":{"type":"availability","data":{"datetime":"nesër","timeOfDay":"evening"}}}',
    '{"text":"Po, pranojmë karta krediti.","intent":{"type":"none"}}'
  );

  const liveSessionBrief = String(options.liveSessionBrief || '').trim();
  const conversationContextBrief = String(options.conversationContextBrief || '').trim();
  const inferredIntent = options.inferredIntent || null;

  if (inferredIntent?.type && inferredIntent.confidence >= 0.75) {
    const inferredData = inferredIntent.data && typeof inferredIntent.data === "object"
      ? JSON.stringify(inferredIntent.data)
      : "{}";
    systemParts.push(
      lang === "sq"
        ? `Sugjerim serveri (besueshmëri ${Math.round(inferredIntent.confidence * 100)}%): intent "${inferredIntent.type}" me data ${inferredData}. Përdore vetëm nëse përputhet me mesazhin e klientit — serveri ekzekuton intent-in pas përgjigjes.`
        : `Server suggestion (confidence ${Math.round(inferredIntent.confidence * 100)}%): intent "${inferredIntent.type}" with data ${inferredData}. Use only if it matches the customer's message — the server executes the intent after your reply.`
    );
  }

  if (options.conversationPhase && options.conversationPhase !== "general") {
    systemParts.push(
      lang === "sq"
        ? `Faza e bisedës: ${options.conversationPhase}. Respekto udhëzimet e fazës — mos konfirmo veprime që serveri nuk i ka kryer ende.`
        : `Conversation phase: ${options.conversationPhase}. Follow phase guidance — do not confirm actions the server has not completed yet.`
    );
  }

  if (liveSessionBrief) {
    systemParts.push(
      "Use LIVE SESSION CONTEXT as ground truth for this customer's booking state.",
      "When the customer asks about their reservation, answer directly from that context — never claim you cannot find a booking if Upcoming is listed.",
      "Think step-by-step internally: (1) customer goal, (2) facts already known, (3) one missing detail — then write the JSON reply."
    );
  }

  if (conversationContextBrief) {
    systemParts.push(
      lang === "sq"
        ? "Përdor KONTEKSTIN E BISEDËS për të mbajtur vijimësinë kur klienti ndryshon pyetje. Mos u ngatërro dhe mos humb profesionalizmin."
        : "Use CONVERSATION CONTEXT to stay oriented when the customer switches questions. Do not get confused and never drop professionalism."
    );
  }

  const system = systemParts.filter(Boolean).join("\n");

  const capabilityHint = isEscalationMode
    ? `Escalation context:\n- Known customer name: ${knownCustomerName || '(not captured yet)'}\n- Tools: ask Escalation Questions sequentially, then emit intent type 'handoff'.`
    : `Capabilities:\n- bookings_enabled: ${features.bookings_enabled ? 'true' : 'false'}\n- reminders_enabled: ${features.reminders_enabled ? 'true' : 'false'}`;

  const servicesArr = Array.isArray(features.services) ? features.services : [];
  const servicesLine = (() => {
    if (isEscalationMode) return '';
    try {
      if (!servicesArr.length) return '';
      const parts = servicesArr.slice(0, 10).map(s => {
        const n = String(s?.name || '').trim();
        const m = Number(s?.minutes || 0);
        const p = String(s?.price || '').trim();
        const bits = [];
        if (m > 0) bits.push(`${m} min`);
        if (p) bits.push(p);
        return bits.length ? `${n} (${bits.join(', ')})` : n;
      }).filter(Boolean);
      if (!parts.length) return '';
      return 'Services:\n' + parts.join('; ');
    } catch { return ''; }
  })();

  const escalationHeader = isEscalationMode && escalationQuestions.length
    ? ('Escalation Questions (ask in order, one per turn):\n' + escalationQuestions.map((q, i) => `${i + 1}. ${String(q).trim()}`).join('\n'))
    : (isEscalationMode ? 'Escalation Questions: (none provided)' : '');
  const knownNameLine = isEscalationMode
    ? `Known customer name status: ${knownCustomerName ? knownCustomerName : 'not provided yet (collect it).'}`
    : '';

  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: 'Docs:\n' + context },
    { role: 'system', content: capabilityHint },
    liveSessionBrief ? { role: 'system', content: liveSessionBrief } : null,
    conversationContextBrief ? { role: 'system', content: conversationContextBrief } : null,
    servicesLine ? { role: 'system', content: servicesLine } : null,
    escalationHeader ? { role: 'system', content: escalationHeader } : null,
    knownNameLine ? { role: 'system', content: knownNameLine } : null,
  ].filter(Boolean);
  for (const m of historyMessages.slice(-16)) {
    try {
      const role = (m && (m.role === 'assistant' || m.role === 'user')) ? m.role : 'user';
      const content = String(m?.content || '').slice(0, 1000);
      if (content) messages.push({ role, content });
    } catch {}
  }
  messages.push({ role: 'user', content: String(userMessage || '').slice(0, 2000) });

  function tryExtractJson(s) {
    if (!s) return null;
    let str = String(s).trim();
    try { return JSON.parse(str); } catch {}
    const fence = /```json\s*([\s\S]*?)\s*```/i.exec(str);
    if (fence) {
      try { return JSON.parse(fence[1]); } catch {}
    }
    const start = str.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { const slice = str.slice(start, i+1); try { return JSON.parse(slice); } catch {} } }
      }
    }
    return null;
  }

  try {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 500,
      // The prompt already mandates a single JSON object; asking the API to
      // enforce JSON greatly reduces parse failures and the costly repair pass.
      // Disable with OPENAI_JSON_MODE=0 if a model rejects it.
      ...(process.env.OPENAI_JSON_MODE === '0'
        ? {}
        : { response_format: { type: 'json_object' } }),
    });
    const content = resp.choices?.[0]?.message?.content || '';
    let obj = tryExtractJson(content);
    if (obj && typeof obj === 'object' && obj.text) {
      return obj;
    }

    if (content) {
      try {
        const repairHint = inferredIntent?.type
          ? `Suggested intent type: ${inferredIntent.type}. Include intent in JSON when appropriate.`
          : 'Return valid JSON with text and optional intent.';
        const repair = await createChat({
          model: MODEL,
          messages: [
            ...messages,
            { role: 'assistant', content: String(content).slice(0, 800) },
            { role: 'user', content: `${repairHint}\n\nReturn ONLY a single JSON object: {"text":"...","intent":{...}}. No markdown.` },
          ],
          temperature: 0.1,
          max_tokens: 400,
          ...(process.env.OPENAI_JSON_MODE === '0'
            ? {}
            : { response_format: { type: 'json_object' } }),
        });
        obj = tryExtractJson(repair.choices?.[0]?.message?.content || '');
        if (obj && typeof obj === 'object' && obj.text) {
          return obj;
        }
      } catch (repairErr) {
        logOpenAiError(repairErr, 'AI decision JSON repair');
      }
    }

    const fallback = buildSafeAgentDecisionFallback(options.lang);
    return fallback;
  } catch (e) {
    logOpenAiError(e, 'AI decision error');
    return buildSafeAgentDecisionFallback(options.lang);
  }
}

function buildSafeAgentDecisionFallback(lang = "en") {
  const sq = lang === "sq";
  return {
    text: sq
      ? "Më fal, kam pasur një problem teknik. A mund ta përsëris pyetjen?"
      : "Sorry, I had a small technical hiccup. Could you repeat your question?",
    intent: { type: "none" },
  };
}

function buildOnboardingSystem(tonePref, stylePref, blockedTopics) {
  const toneLine = tonePref ? `- Tone: ${String(tonePref)}.` : "- Tone/style: concise, helpful; adopt ai_tone/ai_style if provided by user.";
  const styleLine = stylePref ? `- Style: ${String(stylePref)}.` : "";
  const blockedLine = blockedTopics ? `- Avoid or briefly refuse topics: ${String(blockedTopics)}.` : "";
  return [
    "You are an expert onboarding copilot that interviews a business owner and turns their answers into customer‑ready KB entries.",
    "Follow the output protocol EXACTLY. No markdown, no bullets, no code fences, no extra lines.",
    "",
    "Rules:",
    "- Language: reply in the user's language from userMessage.",
    toneLine,
    styleLine,
    blockedLine,
    "- Never invent facts. Extract facts from userMessage and prior transcript; if missing, ask via ASK_MORE.",
    "- Use the knowledge base below for what is already saved — avoid duplicate ADD_KB entries and refine existing topics when the owner adds detail.",
    "- Output may contain only these lines in any order: ASK_MORE|..., ADD_KB|...|..., SET|...|..., COMPLETE",
    "",
    "Delimiters & validation:",
    "- Field delimiter is the pipe `|`. Escape any literal `|` as `\\|`.",
    "- Titles <= 60 chars, single-line.",
    "- Content must be customer-ready plain text; write in short sentences.",
    "- Phone must be digits or E.164 (+…).",
    "- Website URL must start with http:// or https://.",
    "",
    "High‑impact KB topics (save when present; ask when missing):",
    "Business Name; What We Do; Audience; Hours; Locations; Service Areas; Products; Services; Menu Highlights; Cuisine; Price Range; Payments; Reservations/Walk‑ins; Booking/Lead time/Cancellation; Delivery/Pickup/Shipping; Returns/Exchanges; Warranty; Contact; Website; Social Links; Accessibility/Parking; Languages; Top FAQs.",
    "",
    "Extraction guidance (very important):",
    "- From a single user message, create MULTIPLE ADD_KB lines (up to 8) when you can confidently summarize distinct topics.",
    "  Examples: a sentence mentioning city + hours → ADD_KB|Locations|City... and ADD_KB|Hours|Mon–Fri...",
    "- Map facts to canonical titles above (e.g., 'we accept cash and cards' → Payments).",
    "- Prefer crisp, scannable content (lists separated by semicolons; omit fluff).",
    "",
    "Next‑question strategy (ask exactly ONE question):",
    "- Pick the highest‑impact missing topic given what is already saved (e.g., Hours, Locations, Booking/Reservations, Menu Highlights/Key Services, Price Range, Payments, Delivery/Pickup).",
    "- Ask a concrete, answerable question (one sentence; avoid multiple questions).",
    "- If core basics seem complete, ask for differentiators (e.g., specialties, dietary notes, service areas, policies).",
    "",
    "Settings capture (optional, only if clearly provided in the user's message):",
    "- SET|website_url|https://example.com",
    "- SET|business_phone|+15551234567",
    "- SET|business_name|Acme Deli",
    "- SET|ai_tone|professional",
    "- SET|ai_style|concise",
    "- SET|ai_blocked_topics|refunds, legal",
    "",
    "Termination directives:",
    "- If you need more info, end with EXACTLY ONE line: ASK_MORE|<single follow‑up question>",
    "- If you add KB items, output: ADD_KB|<Title>|<Content> (you may output several).",
    "- If you add settings, output: SET|<key>|<value>",
    "- If onboarding seems complete, output one final line: COMPLETE",
    "- Never include ASK_MORE with COMPLETE.",
  ].join("\n");
}

function buildOnboardingInstruction(kbItems, historyTranscript, userMessage) {
  const kbBlock = formatCoachKbForPrompt(kbItems);
  const history = String(historyTranscript || "").slice(-MAX_HISTORY_CHARS);
  const langHint = detectLanguageHint(userMessage);

  return `
${langHint}

Existing knowledge base:
${kbBlock}

Conversation history (latest last):
${history || "(no history)"}

(Reply ONLY with the allowed DSL lines. If you can extract multiple facts, output multiple ADD_KB lines (up to 8). Always ask exactly one high‑impact follow‑up via ASK_MORE unless onboarding is complete.)
`.trim();
}
export async function onboardingCoachReply(userMessage, kbItems = [], historyTranscript = "", options = {}) {
  const system = buildOnboardingSystem(options?.tone, options?.style, options?.blockedTopics);
  const instruction = buildOnboardingInstruction(kbItems, historyTranscript, userMessage);

  async function callOnce() {
    const resp = await createChat({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${instruction}\n\nUser: ${userMessage}\nAssistant:` },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  }
  let out = await callOnce();
  if (!isValidDslResponse(out)) {
    const retrySystem =
      system +
      "\n\nREMINDER: Output ONLY valid DSL lines (ASK_MORE|..., ADD_KB|...|..., SET|...|..., COMPLETE). No markdown, bullets, or code fences.";
    const resp = await createChat({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: retrySystem },
        { role: "user", content: `${instruction}\n\nUser: ${userMessage}\nAssistant:` },
      ],
    });
    out = resp.choices?.[0]?.message?.content?.trim() || out;
  }
  if (isValidDslResponse(out)) {
    out = applyReplacePolicy(out);
    out = normalizeSetLines(out);
  } else {
    out = "ASK_MORE|Could you share the key missing details (e.g., services/products offered, booking or shipping/returns info)?";
  }

  return out.trim();
}

function buildRefiningSystem(tonePref, stylePref, blockedTopics, currentRules = "", bookingsEnabled = false) {
  const toneLine = tonePref ? `- Tone preference: ${String(tonePref)}.` : "";
  const styleLine = stylePref ? `- Style preference: ${String(stylePref)}.` : "";
  const blockedLine = blockedTopics ? `- Blocked topics: ${String(blockedTopics)}.` : "";
  const rulesBlock = formatRefiningRulesForPrompt(currentRules);
  const bookingsLine = bookingsEnabled
    ? "- Bookings: ENABLED — you may configure booking intake with BOOKING_PROFILE, ADD_BOOKING_FIELD, REMOVE_BOOKING_FIELD, or CLEAR_BOOKING_FIELDS."
    : "- Bookings: DISABLED — do NOT output BOOKING_PROFILE, ADD_BOOKING_FIELD, REMOVE_BOOKING_FIELD, or CLEAR_BOOKING_FIELDS.";
  const bookingsGateLine = bookingsEnabled
    ? ""
    : "- If the owner asks to add, change, or remove booking questions (or set a booking profile), use REPLY| only: explain that Bookings must be turned on first in Settings → Bookings, then they can ask you again to configure intake questions.";
  return [
    "You are a bot-refining copilot for a business owner using Code Orbit Agent on WhatsApp.",
    "The owner describes how the customer-facing bot should behave. You turn their requests into durable bot rules and optional KB updates.",
    "Follow the output protocol EXACTLY. No markdown, bullets, or code fences.",
    "",
    "Core behaviour:",
    "- Reply in the owner's language from their message.",
    "- Stay in scope: you ONLY help refine this business's WhatsApp customer bot (rules, bot behaviour, tone-related settings, and KB updates that improve bot answers).",
    "- Do NOT answer unrelated questions (general knowledge, coding, personal life, politics, news, jokes, unrelated business strategy, competitors, legal/medical advice, etc.).",
    "- If the owner asks something off-topic, respond with REPLY| only: politely decline, explain you are the refining coach, and invite them back to bot rules or behaviour.",
    "- Read the FULL conversation history before responding — owners often answer your earlier questions in short follow-ups.",
    "- Do NOT save a vague rule. Ask follow-up questions until the instruction is specific enough for the customer bot to act on.",
    "- Ask ONE clear question at a time via ASK_MORE| (you may ask many questions across turns).",
    "- Only output ADD_RULE when you are confident the rule includes: trigger/situation (WHEN), action (THEN), and any critical details (numbers, phone, wording).",
    "- If the owner gives a short reply (e.g. '30', 'call us', 'yes'), combine it with prior context from the transcript — do not treat it as a standalone new topic.",
    "",
    "Suggestions (when asked):",
    "- If the owner asks for ideas, suggestions, recommendations, or 'what should I add/change', use REPLY| with 3–5 concrete suggestions.",
    "- Suggestions must be GAPS only — things the customer bot still cannot answer or handle from the knowledge base, business profile, Google profile, website, and current rules.",
    "- Before suggesting, review what is ALREADY covered. Do NOT suggest rules that merely repeat KB facts (e.g. sharing opening hours, address/maps link, menu link, payment methods, Wi-Fi, delivery policy) when those topics are already in KB or business profile — the live bot already answers those.",
    "- Good suggestions: missing edge cases, escalation/handoff triggers, booking workflows not covered, tone boundaries, policies not in KB, large-group handling beyond existing rules, seasonal exceptions, complaint handling, or behaviour when KB has no answer.",
    "- If basics are well covered, say so briefly (1 sentence), then suggest only genuine gaps — do not pad the list with KB duplicates.",
    "- Ground gap suggestions in their business type and what is missing — not generic chatbot advice.",
    "- Keep all suggestions in a single REPLY| line (use semicolons or 1) 2) 3) — no markdown bullets).",
    "- Do NOT output ADD_RULE unless they explicitly want to save a rule or give a complete instruction to save.",
    "- You may end with a short question offering to turn a suggestion into a saved rule.",
    toneLine,
    styleLine,
    blockedLine,
    "- Never invent facts about the business (phone numbers, prices, policies). Ask if missing.",
    "- Ground rules and ADD_KB suggestions in the business profile, website summary, and knowledge base below when relevant.",
    "- ALWAYS read the business profile block in each owner message before answering — you are coaching the bot for THIS specific business (name, type, categories, services, hours, Google description).",
    "- Use business type and Google place types to choose sensible defaults: Restaurant / Food → BOOKING_PROFILE|restaurant; clinics, dentists, salons, spas, professionals → BOOKING_PROFILE|appointment (no party size).",
    "- When the owner asks about booking questions, align with what this business actually does — do not suggest party size for one-to-one appointments.",
    "- Prefer facts from dashboard settings and Google Business Profile over assumptions; ask ASK_MORE if settings are empty or ambiguous.",
    bookingsLine,
    bookingsGateLine,
    "",
    "Output ONLY these line types:",
    "  ASK_MORE|<single clarifying question>",
    "  REPLY|<short confirmation to the owner>",
    "  ADD_RULE|<single imperative rule the customer bot must follow>",
    "  REMOVE_RULE|<substring matching an existing rule to delete>",
    "  CLEAR_RULES",
    "  ADD_KB|<Title>|<Content>",
    "  SET|<settings_key>|<value>",
    "  ENFORCE|party_size_call|<min_party>|<phone_e164_or_empty>",
    "  BOOKING_PROFILE|restaurant|appointment",
    "  ADD_BOOKING_FIELD|<id>|<type>|<label>|<prompt>|<required|optional>",
    "  REMOVE_BOOKING_FIELD|<id>",
    "  CLEAR_BOOKING_FIELDS",
    "",
    "Booking questions (what the bot asks before creating a calendar booking):",
    "- Use BOOKING_PROFILE|appointment for clinics, dentists, salons (name only — no party size).",
    "- Use BOOKING_PROFILE|restaurant for restaurants (name + party size).",
    "- Use ADD_BOOKING_FIELD to add fields, e.g. email or custom text:",
    "  ADD_BOOKING_FIELD|email|email|Email|What's your email address?|required",
    "  ADD_BOOKING_FIELD|reason|text|Reason for visit|What is the reason for your visit?|required",
    "- Use REMOVE_BOOKING_FIELD|party_size when the business does not need headcount.",
    "- Answers are saved on the calendar appointment automatically.",
    "- You may combine REPLY + BOOKING_PROFILE / ADD_BOOKING_FIELD in one response (no ADD_RULE needed for booking questions).",
    "",
    "Hard enforcement (ENFORCE):",
    "- When a rule must ALWAYS block large-group bookings (not just AI guidance), output ENFORCE|party_size_call|<min>|<phone> on the same response as ADD_RULE.",
    "- Example: REPLY|Done — large groups must call you.",
    "  ADD_RULE|When a customer requests a booking for more than 30 people, advise them to call +355 69 123 4567. Do not complete large group bookings via WhatsApp.",
    "  ENFORCE|party_size_call|30|+355691234567",
    "When to ASK_MORE (no ADD_RULE in the same response):",
    "- Instruction is vague ('be nicer', 'handle big groups', 'don't allow that').",
    "- Missing threshold, phone number, exact wording, scope, or exception.",
    "- You are unsure what situation the rule applies to.",
    "",
    "When to REPLY + ADD_RULE:",
    "- You have enough detail to write a complete WHEN/THEN rule.",
    "- Owner answered your clarifying questions.",
    "- Owner gave a fully specified instruction in one message.",
    "",
    "When to REPLY only (no ADD_RULE):",
    "- Simple acknowledgement when no rule change is needed.",
    "- Off-topic questions (decline politely and redirect).",
    "- Suggestion requests (ideas for rules, improvements, gaps to cover).",
    "",
    "When to REPLY + REMOVE_RULE (or CLEAR_RULES):",
    "- Owner asks to delete, remove, undo, or cancel a rule.",
    "- Match REMOVE_RULE to distinctive words from the rule text (e.g. '30 people', 'large groups').",
    "- Use CLEAR_RULES only when the owner wants to wipe every rule.",
    "- Do NOT use ASK_MORE for clear removal requests.",
    "",
    "Allowed SET keys: ai_tone, ai_style, ai_blocked_topics, conversation_mode, business_phone, website_url, business_name.",
    "",
    "Example multi-turn:",
    "Owner: 'Handle big bookings differently'",
    "ASK_MORE|From how many people should the bot stop taking reservations by message and ask customers to call instead?",
    "",
    "Example booking questions (dental clinic):",
    "Owner: 'We are a dental clinic — only one patient per appointment, ask for name and reason for visit, not party size'",
    "REPLY|Done — booking will collect name and reason for visit only (no party size).",
    "BOOKING_PROFILE|appointment",
    "ADD_BOOKING_FIELD|reason|text|Reason for visit|What is the reason for your visit?|required",
    "",
    "Owner: '30'",
    "ASK_MORE|What phone number or exact message should the bot give customers when that happens?",
    "",
    "Owner: '+355 69 123 4567'",
    "REPLY|Done — large groups will be directed to call you.",
    "ADD_RULE|When a customer requests a booking for more than 30 people, advise them to call +355 69 123 4567 directly. Do not complete large group bookings via WhatsApp message.",
    "ENFORCE|party_size_call|30|+355691234567",
    "",
    "Example suggestions:",
    "Owner: 'Any ideas for rules I should add?'",
    "REPLY|Your KB already covers hours, address, menu, and payments — the bot can answer those today. Gaps worth adding: 1) Escalate to a human when a customer asks for a refund; 2) Ask for allergy info before confirming food bookings; 3) Offer a callback when someone asks about hosting a private event. Want me to save any of these?",
    "",
    "Example off-topic:",
    "Owner: 'What's the weather tomorrow?'",
    "REPLY|I'm your refining coach — I help shape how your WhatsApp bot handles customers (rules, tone, and behaviour). I can't help with unrelated questions, but I can suggest or save bot rules if you'd like.",
    "",
    bookingsEnabled
      ? ""
      : [
          "Example booking questions while Bookings is disabled:",
          "Owner: 'Ask for email before every reservation'",
          "REPLY|Booking intake questions only apply when reservations are enabled. Please turn on Bookings in Settings → Bookings first, then tell me what you'd like the bot to ask (e.g. email or party size).",
        ].join("\n"),
    "",
    rulesBlock ? `\nCurrent active bot rules:\n${rulesBlock}` : "\nCurrent active bot rules: (none yet)",
  ].filter(Boolean).join("\n");
}

function buildRefiningInstruction(historyTranscript, userMessage, kbItems = [], businessContext = "", options = {}) {
  const history = String(historyTranscript || "").slice(-MAX_HISTORY_CHARS);
  const kbBlock = formatCoachKbForPrompt(kbItems);
  const businessBlock = String(businessContext || "").trim() || "(not available)";
  const suggestionBlock = options.isSuggestionRequest
    ? `
Suggestion request — owner wants GAPS only:
- The knowledge base and business profile below show what the live bot ALREADY knows.
- Do NOT suggest rules that only tell the bot to share facts already listed there (hours, address, menu, payments, Wi-Fi, etc.).
- Suggest only missing behaviours, policies, edge cases, or workflows the bot cannot handle yet.
`.trim()
    : "";
  return `
Business profile, settings, Google Business, and website:
${businessBlock}

Business knowledge base (facts already saved — the live bot uses these to answer customers; do not suggest duplicating them as rules):
${kbBlock}
${suggestionBlock ? `\n${suggestionBlock}\n` : ""}
Conversation history (latest last):
${history || "(no history)"}

Owner message:
${String(userMessage || "").slice(0, 4000)}

(Reply ONLY with valid DSL lines. Use ASK_MORE when you still need details — do NOT add ADD_RULE in the same response as ASK_MORE. When ready, use REPLY plus ADD_RULE. For off-topic messages, use REPLY only to decline and redirect. For suggestion requests, use REPLY only with gap-focused ideas — never suggest repeating KB facts.)
`.trim();
}

export function isRefiningSuggestionRequest(message = "") {
  const m = String(message || "").trim().toLowerCase();
  if (!m) return false;
  return (
    /\b(suggest(?:ion)?s?|recommend(?:ation)?s?|ideas?|improvements?|gaps?)\b/.test(m)
    || /\bwhat (?:are |)(?:some )?good things to add\b/.test(m)
    || /\bwhat should (?:i|we) add\b/.test(m)
    || /\bwhat (?:can|could|should) (?:i|we) add\b/.test(m)
    || /\bwhat(?:'s| is) missing\b/.test(m)
    || /\bwhat else should\b/.test(m)
    || /\bany (?:ideas|suggestions|recommendations)\b/.test(m)
  );
}

export async function refiningCoachReply(userMessage, historyTranscript = "", options = {}) {
  const bookingsEnabled = options?.bookingsEnabled === true;
  const system = buildRefiningSystem(
    options?.tone,
    options?.style,
    options?.blockedTopics,
    options?.currentRules || "",
    bookingsEnabled
  );
  const instruction = buildRefiningInstruction(
    historyTranscript,
    userMessage,
    options?.kbItems || options?.kbContext || [],
    options?.businessContext || "",
    { isSuggestionRequest: !!options?.isSuggestionRequest }
  );

  async function callOnce(extra = "") {
    const resp = await createChat({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: system + extra },
        { role: "user", content: `${instruction}\n\nOwner: ${userMessage}\nAssistant:` },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  }

  let out = await callOnce();
  if (!isValidRefiningDslResponse(out)) {
    out = await callOnce(
      "\n\nREMINDER: Output ONLY valid DSL lines. Stay in refining scope — decline off-topic questions with REPLY| only. For suggestion requests, use REPLY| with GAP-only ideas (never suggest duplicating KB facts like hours/address/menu). Use ASK_MORE| when details are missing. Never combine ASK_MORE with ADD_RULE."
    );
  }
  if (!isValidRefiningDslResponse(out)) {
    out = "ASK_MORE|Could you share a bit more detail — for example when this should apply and what the bot should say or do?";
  }
  return out.trim();
}
