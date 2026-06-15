import OpenAI from "openai";
import { normalizePhoneE164 } from "../utils.mjs";
import { detectLanguage, languageInstruction, kbScopeGuidance, conversationalStyleGuidance, conversationContinuityInstruction, t as translate } from "./i18n.mjs";

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  return openai.chat.completions.create(body);
}

const LINE_PATTERNS = [
  /^ASK_MORE\|[^\n]+$/,
  /^ADD_KB\|[^|\n]{1,60}\|.+$/,
  /^SET\|[a-z_]+\|.+$/,
  /^COMPLETE$/,
];

function isValidDslResponse(s) {
  if (!s) return false;
  if (/^```|```$|^\s*-/m.test(s)) return false;  const lines = s.trim().split(/\r?\n/);
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
    conversationContinuityInstruction(conversationStarted, userMessageIsGreeting),
    "Exception: For generic pleasantries (e.g., 'how are you', greetings, thanks, apologies, simple emojis), respond briefly and warmly WITHOUT using the out-of-scope phrase.",
    "Never invent facts.",
    "Interpret typos, slang, dialect, and paraphrases generously.",
    blockedLine ? blockedLine : "",
    "Tone: " + tone + ". Style: " + style + ".",
    businessProfileLine ? businessProfileLine : "",
    mismatchGuidance ? mismatchGuidance : "",
    "Booking guidance (no pickers): If the customer wants to book but is missing a date or time, ask for their preferred date/time in one short, friendly sentence.",
    "Availability: if asked without a date range, ask which dates to check.",
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
    options.shouldGreet
      ? (lang === "sq"
        ? "Mos përfshi përshëndetje — sistemi e shton automatikisht."
        : "Do NOT include a greeting — the system adds one automatically.")
      : "",
    `Tone: ${tone}. Style: ${style}.`,
    businessName ? `You represent ${businessName}.` : "",
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: policy },
    { role: "system", content: `FAQ question: ${title}\nFAQ answer: ${content}` },
  ];
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
    conversationContinuityInstruction(conversationStarted, userMessageIsGreeting),
    "Read the whole conversation and the customer's intent before replying. Acknowledge what they said, answer directly, and keep momentum toward what they actually want.",
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
      "Collect party size, a specific clock time, and name when missing. Party size must come from the customer in this conversation — never assume, reuse, or announce a number from past bookings or memory.",
      "Do NOT ask why they are visiting or recall past occasions/reasons from earlier chats — only the customer's name may be remembered.",
      "When the customer gives a date and/or time in ANY phrasing or language (e.g. 'tomorrow at 3', 'nesër ora 15:00', 'Friday afternoon', 'nesër në dark', 'next week'), capture it and pass it through as the intent — do not ask them to rephrase into a specific format.",
      "For evening/morning/afternoon WITHOUT a specific hour (e.g. 'nesër në dark', 'tomorrow evening'), that is NOT enough to book — use intent none and ask for an exact clock time. Do NOT list or offer available times unless they explicitly ask to see them.",
      "For evening/morning/afternoon requests, set intent.data.timeOfDay to 'morning', 'afternoon', or 'evening' (e.g. 'në dark' / 'in the evening' → evening) when relevant, but still use intent none until they give an exact hour.",
      "Use intent type availability ONLY when the customer explicitly asks what times are free, which slots are open, or wants to see available options (e.g. 'what times do you have?', 'cilat orare keni?', 'a keni vende?'). A reservation request with only a daypart is NOT an availability request.",
      "When the customer names a specific time (e.g. 'at 9:30', 'në orën 21:30', 'do you have seats at 9pm'), use intent type book — not availability.",
      "You may plan ONE optional intent for the server to execute. Choose wisely and only if enough info is present.",
      "INTENT TYPES: availability, book, reschedule, cancel, update_name, handoff, none.",
      "For availability/book/reschedule intents, include the customer's natural date/time phrase in intent.data (e.g. data.datetime or data.range); the server will parse Albanian and English phrasing.",
      "When the customer gives party size only (e.g. '5 persona') without a specific clock time in the SAME message, use intent none ONLY if date/time is not already established earlier in the thread — if they already gave date+time and now only add party size, use intent book with partySize and pass the datetime phrase from context.",
      "Never include partySize in intent.data unless the customer stated it in this conversation. Do not say you are keeping or assuming a party size — ask how many people instead.",
      "When the customer gives their name, include intent.data.name — the server saves it. Do NOT include intent.data.reason or mention past visit reasons.",
      "Do NOT claim a reservation is confirmed, complete, or being sent in your text — the server creates the calendar booking only after a specific time is chosen. You may acknowledge date/party size and ask for the missing exact time.",
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
    '{"text":"Patjetër, nesër në orën 20:00 për 5 persona. Si quheni?","intent":{"type":"book","data":{"datetime":"nesër ora 20:00","partySize":5}}}',
    '{"text":"Patjetër, për nesër në mbrëmje. Cila orë saktësisht ju përshtatet?","intent":{"type":"none"}}',
    '{"text":"Po, ja disa orare të lira për nesër.","intent":{"type":"availability","data":{"datetime":"nesër","timeOfDay":"evening"}}}',
    '{"text":"Po, pranojmë karta krediti.","intent":{"type":"none"}}'
  );

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

  const liveSessionBrief = String(options.liveSessionBrief || '').trim();
  const inferredIntent = options.inferredIntent || null;

  if (liveSessionBrief) {
    systemParts.push(
      "Use LIVE SESSION CONTEXT as ground truth for this customer's booking state.",
      "When the customer asks about their reservation, answer directly from that context — never claim you cannot find a booking if Upcoming is listed.",
      "Think step-by-step internally: (1) customer goal, (2) facts already known, (3) one missing detail — then write the JSON reply."
    );
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: 'Docs:\n' + context },
    { role: 'system', content: capabilityHint },
    liveSessionBrief ? { role: 'system', content: liveSessionBrief } : null,
    servicesLine ? { role: 'system', content: servicesLine } : null,
    escalationHeader ? { role: 'system', content: escalationHeader } : null,
    knownNameLine ? { role: 'system', content: knownNameLine } : null,
  ].filter(Boolean);
  for (const m of historyMessages.slice(-10)) {
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
        });
        obj = tryExtractJson(repair.choices?.[0]?.message?.content || '');
        if (obj && typeof obj === 'object' && obj.text) {
          return obj;
        }
      } catch (repairErr) {
        logOpenAiError(repairErr, 'AI decision JSON repair');
      }
    }

    const fallback = await generateAiReply(userMessage, contextSnippets, options);
    const fb = fallback ? { text: fallback, intent: { type: 'none' } } : null;
    if (fb && inferredIntent?.type && inferredIntent.confidence >= 0.85) {
      fb.intent = { type: inferredIntent.type, data: inferredIntent.data || {} };
    }
    return fb;
  } catch (e) {
    logOpenAiError(e, 'AI decision error');
    try {
      const fallback = await generateAiReply(userMessage, contextSnippets, options);
      return fallback ? { text: fallback, intent: { type: 'none' } } : null;
    } catch (_) {
      return null;
    }
  }
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
  const titles = (kbItems || [])
    .map((r) => `- ${escapePipes(r?.title || "Untitled")}`)
    .join("\n");
  const history = String(historyTranscript || "").slice(-MAX_HISTORY_CHARS);
  const langHint = detectLanguageHint(userMessage);

  return `
${langHint}

Existing KB titles:
${titles || "(none yet)"}

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
