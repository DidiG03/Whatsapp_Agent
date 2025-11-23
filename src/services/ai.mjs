// kb-tools.mjs
import OpenAI from "openai";
import { normalizePhoneE164 } from "../utils.mjs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------- Logging --------------------------------------

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

// ----------------------------- Shared utils ---------------------------------

const MODEL = "gpt-4o-mini";
const MAX_HISTORY_CHARS = 4000;

const LINE_PATTERNS = [
  /^ASK_MORE\|[^\n]+$/,
  /^ADD_KB\|[^|\n]{1,60}\|.+$/,
  /^SET\|[a-z_]+\|.+$/,
  /^COMPLETE$/,
];

function isValidDslResponse(s) {
  if (!s) return false;
  if (/^```|```$|^\s*-/m.test(s)) return false; // kill code fences/bullets
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

function detectLanguageHint(userMessage) {
  const m = userMessage || "";
  const hasNonASCII = /[^\u0000-\u007f]/.test(m);
  if (hasNonASCII) return "User language: non-English likely; reply in the user's language.";
  if (/\b(hola|bonjour|ciao|hallo|hej|salut|ola|merhaba|γειά|привет)\b/i.test(m))
    return "User language: non-English likely; reply in the user's language.";
  return "User language: English; reply in English unless user writes otherwise.";
}

// moved to utils: normalizePhoneE164

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
  // Obvious non-names or placeholders
  const generic = /^(my|our|the)?\s*(restaurant|shop|business|store)$/i;
  if (generic.test(v)) return null;
  if (!/[a-zA-Z]/.test(v)) return null;
  // Naive title-case without affecting acronyms excessively
  const titled = v
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return titled;
}

// Parses ADD_KB line allowing escaped pipes. Returns [ok, title, content].
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
        // Keep the original line but also ask for clarification if allowed
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
  // We assume client will overwrite existing on same title. Just pass through after parse check.
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

// ----------------------------- kbCoachReply ---------------------------------

/**
 * @param {string} userMessage
 * @param {string[]} existingTitles
 * @param {string} historyTranscript
 * @returns {Promise<string>}
 */
export async function kbCoachReply(userMessage, existingTitles = [], historyTranscript = "") {
  const context = (existingTitles || []).map((t) => `- ${escapePipes(t)}`).join("\n");
  const history = String(historyTranscript || "").slice(-MAX_HISTORY_CHARS);
  const system =
    "You are a KB coach. Be brief, helpful, and friendly. Only output short prose plus at most one DSL line.";
  const instruction = `You are helping a business owner grow their Knowledge Base (KB).

Existing KB titles:
${context || "(none yet)"}

Conversation history (latest last):
${history || "(no history)"}

Behavior:
- Ask only for information you still need to create a useful, customer-facing KB entry.
- If you need more details, end your message with ONE extra line:
  ASK_MORE|<Your single follow-up question>
- If you have enough to save, end your message with ONE extra line:
  ADD_KB|<Title>|<Content>
- Do not output both lines; use exactly one if applicable, else neither.
- Keep your visible answer short (<= 4 lines).`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${instruction}\n\nUser: ${userMessage}\nAssistant:` },
      ],
      temperature: 0.2,
      max_tokens: 250,
    });
    let out = resp.choices?.[0]?.message?.content?.trim() || "";

    // Soft validation: allow short prose + optional single DSL line
    const lines = out.split(/\r?\n/);
    const dslLines = lines.filter((l) => /^ASK_MORE\|/.test(l) || /^ADD_KB\|/.test(l));
    if (dslLines.length > 1) {
      // Keep last DSL line only
      out = [
        ...lines.filter((l) => !/^ASK_MORE\||^ADD_KB\|/.test(l)).slice(0, 4),
        dslLines.pop(),
      ]
        .join("\n")
        .trim();
    }
    return out;
  } catch (e) {
    logOpenAiError(e, "KB coach error");
    return "";
  }
}

// ----------------------------- generateAiReply -------------------------------

/**
 * Generate a reply from the AI.
 * @param {string} userMessage
 * @param {{ title: string, content: string }[]} contextSnippets
 * @param {{ tone?: string, style?: string, blockedTopics?: string }} options
 * @returns {Promise<string|null>}
 */
export async function generateAiReply(userMessage, contextSnippets, options = {}) {
  const context =
    (contextSnippets || [])
      .map((s, i) => `# Doc ${i + 1}: ${s.title || "Untitled"}\n${s.content}`)
      .join("\n\n") || "(no docs)";

  const tone = (options.tone || "friendly").trim();
  const style = (options.style || "clear and concise").trim();
  const blockedTopics = String(options.blockedTopics || "").trim();
  const historyMessages = Array.isArray(options.historyMessages) ? options.historyMessages : [];

  const blockedLine = blockedTopics
    ? `Refuse questions about these topics: ${blockedTopics}. If asked, briefly refuse and suggest contacting support.`
    : "";

  const OUT_OF_SCOPE_PHRASE = "That seems outside my scope. Try choosing one of these topics";

  // Base system policy and tasking
  const policy = [
    "You are a WhatsApp assistant for a business.",
    "Use ONLY the provided Docs (KB context). If the KB does not support an answer, reply with EXACTLY: " + OUT_OF_SCOPE_PHRASE + ".",
    "Exception: For generic pleasantries (e.g., 'how are you', greetings, thanks, apologies, simple emojis), respond briefly and warmly WITHOUT using the out-of-scope phrase.",
    "Be concise (1–4 sentences). Never invent facts.",
    "Interpret typos, slang, and paraphrases.",
    blockedLine ? blockedLine : "",
    "Tone: " + tone + ". Style: " + style + ".",
    "Booking guidance (no pickers): If intent to book without BOTH date and time, ask for a preferred date/time in one short sentence (e.g., 'Nov 3 at 3pm').",
    "Availability: if asked without a date range, ask for a range (e.g., 'tomorrow', 'Nov 3–5').",
  ].filter(Boolean).join("\n");

  // Build chat messages with optional conversation history
  const messages = [
    { role: "system", content: policy },
    { role: "system", content: "Docs:\n" + context },
  ];

  // Append prior turns if provided: each item should be { role: 'user'|'assistant', content: string }
  for (const m of historyMessages.slice(-10)) {
    try {
      const role = (m && (m.role === 'assistant' || m.role === 'user')) ? m.role : 'user';
      const content = String(m?.content || '').slice(0, 1000);
      if (content) messages.push({ role, content });
    } catch {}
  }

  messages.push({ role: "user", content: String(userMessage || "").slice(0, 2000) });

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 256,
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

/**
 * Generate a short, natural WhatsApp message for common assistant nudges
 * (asking for a date/time, range, warnings, suggestions, etc.).
 * Falls back to a sensible default if the model call fails.
 * @param {string} kind - e.g., 'ask_datetime', 'ask_range', 'closest_times', 'no_times', 'past_time_warning', 'confirm_booking'
 * @param {object} data - variables for the nudge (e.g., { examples: [...], suggestions: [...], dateLabel: 'Nov 3' })
 * @param {{ tone?: string, style?: string }} options
 * @returns {Promise<string>}
 */
export async function generateAssistantNudge(kind, data = {}, options = {}) {
  const tone = (options.tone || 'friendly').trim();
  const style = (options.style || 'clear and concise').trim();
  const policy = [
    'You generate a SINGLE short WhatsApp message as the assistant.',
    'Keep it warm, human, and concise (<= 2 sentences).',
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
    ask_datetime: 'Ask the user to share a preferred date and time. Include one or two compact examples. Avoid commands; be polite.',
    ask_range: 'Ask the user for a date range to check availability. Mention examples like “tomorrow”, “Nov 3”, or “Nov 3–5”.',
    closest_times: 'Explain the requested time is unavailable and present the provided list of closest options inline, inviting the user to pick one.',
    no_times: 'Say there are no open times for the selected date/range and invite the user to try another date/time or daypart.',
    past_time_warning: 'Explain the time has already passed and ask for a future date/time with a compact example.',
    confirm_booking: 'Acknowledge the booking time succinctly and indicate you will proceed to the next question.',
    reschedule_request: 'Ask for a new preferred date and time to reschedule, with a compact example.',
    no_booking_found: 'Explain you cannot find any upcoming booking for this phone and offer to start a new booking.',
    cancel_aborted: "Acknowledge you won't cancel and invite the user to say 'cancel' later if needed.",
    slot_book_failed: 'Apologize briefly and ask the user to pick another time.',
    reset_done: 'Acknowledge the booking flow has been reset and invite the user to share a new date/time.',
  }[kind] || 'Write a short, helpful message for this assistant action.';

  const payload = {
    kind,
    data,
  };

  try {
    const resp = await openai.chat.completions.create({
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
    // Fallbacks
    if (kind === 'ask_datetime') return "Please share a preferred date and time (e.g., 'Nov 3 at 3pm', 'tomorrow 14:30').";
    if (kind === 'ask_range') return "Which dates should I check? You can say 'tomorrow', 'Nov 3', or 'Nov 3–5'.";
    if (kind === 'closest_times') return `That exact time isn't available. Here are some nearby options: ${(data?.suggestions||[]).join(', ')}.`;
    if (kind === 'no_times') return 'I didn’t find open times in that range. Try another date or time of day.';
    if (kind === 'past_time_warning') return "That time has already passed. Please share a future date/time.";
    if (kind === 'reschedule_request') return 'Please share a new preferred date and time to reschedule.';
    if (kind === 'confirm_booking') return 'Great — I can book that.';
    if (kind === 'no_booking_found') return "I couldn’t find an upcoming booking for your number. Would you like to start a new one?";
    if (kind === 'cancel_aborted') return "Okay, I won’t cancel. If you change your mind later, just say ‘cancel’.";
    if (kind === 'slot_book_failed') return "Sorry — that slot couldn’t be booked. Could you pick another time?";
    if (kind === 'reset_done') return "All set — I’ve reset the booking flow. Share a new date and time when ready.";
    if (kind === 'handoff_followup') return "Thanks for your patience — I’m still connecting you with a human teammate.";
    return 'Okay.';
  }
}

// ----------------------------- generateAgentDecision -------------------------

/**
 * Plan a smart assistant reply and an optional intent for the server to execute.
 * The model returns a JSON object with shape:
 * {
 *   text: string, // WhatsApp-ready reply to send
 *   intent?: {
 *     type: 'availability'|'book'|'reschedule'|'cancel'|'handoff'|'none',
 *     data?: object // free-form; server will interpret safely
 *   }
 * }
 *
 * Notes:
 * - The model is encouraged to sell/upsell politely and ask for missing info.
 * - The server executes the intent opportunistically (when enough info is present).
 * - If parsing fails, falls back to generateAiReply.
 */
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

  const blockedLine = blockedTopics
    ? `Refuse questions about these topics: ${blockedTopics}. If asked, briefly refuse and suggest contacting support.`
    : "";

  const isEscalationMode = String(features.conversation_mode || '').toLowerCase() === 'escalation';
  const escalationQuestions = Array.isArray(features.escalation_questions) ? features.escalation_questions.filter(Boolean).slice(0, 10) : [];
  const knownCustomerName = String(features.customer_name || '').trim();

  const systemParts = [
    "You are a sales-savvy WhatsApp assistant for a business.",
    `Tone: ${tone}. Style: ${style}.`,
    "Use ONLY the provided Docs (KB context) for factual answers; never invent facts.",
    blockedLine ? blockedLine : "",
  ];

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
      "Primary goal: satisfy the user's request with helpful, persuasive, concise replies.",
      "If user intent is booking-related, be proactive and helpful: keep it short, ask for any missing date/time efficiently.",
      "You may plan ONE optional intent for the server to execute. Choose wisely and only if enough info is present.",
      "INTENT TYPES: availability, book, reschedule, cancel, handoff, none.",
      "For availability/book intents, you can include natural date/time phrases; the server will parse.",
      "For complex or missing info, ask in your text what is needed (e.g., preferred date/time).",
      "If a Service catalog is provided, and the user asks about booking or prices/services, present a compact list of services (name, minutes, price if available) and ask the user to pick one.",
      "Format the services inline with semicolons, e.g., \"Basic (30 min, $40); Deluxe (60 min, $70)\". Keep it to one short line if possible.",
      "Never invent services or prices; use only the provided catalog. If no price is available for a service, omit the price."
    );
  }

  systemParts.push(
    "Infer answers from prior chat history when possible. Do not repeat questions already answered.",
    "OUTPUT STRICTLY AS A SINGLE JSON OBJECT with keys: text, intent (optional). No markdown."
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

  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: 'Docs:\n' + context },
    { role: 'system', content: capabilityHint },
    servicesLine ? { role: 'system', content: servicesLine } : null,
    escalationHeader ? { role: 'system', content: escalationHeader } : null,
    knownNameLine ? { role: 'system', content: knownNameLine } : null,
  ];
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
    // Common case: raw JSON
    try { return JSON.parse(str); } catch {}
    // Extract first fenced code block with json
    const fence = /```json\s*([\s\S]*?)\s*```/i.exec(str);
    if (fence) {
      try { return JSON.parse(fence[1]); } catch {}
    }
    // Extract first { ... } object
    const start = str.indexOf('{');
    if (start >= 0) {
      // naive scan to matching brace count
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
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.5,
      max_tokens: 300,
    });
    const content = resp.choices?.[0]?.message?.content || '';
    const obj = tryExtractJson(content);
    if (obj && typeof obj === 'object' && obj.text) {
      return obj;
    }
    // Fallback: simple KB answer
    const fallback = await generateAiReply(userMessage, contextSnippets, options);
    return fallback ? { text: fallback, intent: { type: 'none' } } : null;
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

// ----------------------------- onboardingCoachReply -------------------------

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
    "- SET|entry_greeting|Hello! How can I help?",
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

/**
 * @param {string} userMessage
 * @param {{ title?: string }[]} kbItems
 * @param {string} historyTranscript
 * @param {{ tone?: string, style?: string, blockedTopics?: string }} options
 * @returns {Promise<string>}
 */
export async function onboardingCoachReply(userMessage, kbItems = [], historyTranscript = "", options = {}) {
  const system = buildOnboardingSystem(options?.tone, options?.style, options?.blockedTopics);
  const instruction = buildOnboardingInstruction(kbItems, historyTranscript, userMessage);

  async function callOnce() {
    const resp = await openai.chat.completions.create({
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

  // First attempt
  let out = await callOnce();

  // One retry if invalid
  if (!isValidDslResponse(out)) {
    const retrySystem =
      system +
      "\n\nREMINDER: Output ONLY valid DSL lines (ASK_MORE|..., ADD_KB|...|..., SET|...|..., COMPLETE). No markdown, bullets, or code fences.";
    const resp = await openai.chat.completions.create({
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

  // Normalize/validate pipeline
  if (isValidDslResponse(out)) {
    out = applyReplacePolicy(out);
    out = normalizeSetLines(out);
  } else {
    // Fallback guard
    out = "ASK_MORE|Could you share the key missing details (e.g., services/products offered, booking or shipping/returns info)?";
  }

  return out.trim();
}

// ----------------------------- usageInsights ----------------------------------

/**
 * Generate a short insights recap for the Home dashboard based on recent usage.
 *
 * @param {{ plan?: any, usage?: any, history?: any[] }} params
 *   - plan: UserPlan document (or plain object with plan_name/monthly_limit/etc.)
 *   - usage: current month UsageStats (inbound_messages, outbound_messages, template_messages, month_year)
 *   - history: optional array of recent UsageStats objects for previous months
 *
 * @returns {Promise<string>} Human‑readable text with a few sentences of suggestions.
 */
export async function generateUsageInsights(params = {}) {
  const { plan, usage, history = [] } = params || {};

  const planName = String(plan?.plan_name || "Free");
  const monthlyLimit = typeof plan?.monthly_limit === "number" ? plan.monthly_limit : null;
  const usedTotal = typeof usage?.inbound_messages === "number" || typeof usage?.outbound_messages === "number" || typeof usage?.template_messages === "number"
    ? (Number(usage?.inbound_messages || 0) + Number(usage?.outbound_messages || 0) + Number(usage?.template_messages || 0))
    : null;

  const monthLabel = usage?.month_year || "";
  const historyLines = Array.isArray(history) && history.length
    ? history
        .map((row) => {
          const total = Number(row.inbound_messages || 0) + Number(row.outbound_messages || 0) + Number(row.template_messages || 0);
          return `- ${row.month_year}: ${total} total messages (in: ${row.inbound_messages || 0}, out: ${row.outbound_messages || 0}, templates: ${row.template_messages || 0})`;
        })
        .join("\n")
    : "(no historical data yet)";

  const summaryParts = [];
  if (usedTotal != null && monthlyLimit != null && monthlyLimit > 0) {
    const pct = Math.round((usedTotal / monthlyLimit) * 100);
    summaryParts.push(`Current month (${monthLabel || "this month"}): ${usedTotal} messages used out of ${monthlyLimit} in your ${planName} plan (~${isNaN(pct) ? "0" : pct}% of your allowance).`);
  } else if (usedTotal != null) {
    summaryParts.push(`Current month activity: ${usedTotal} total messages so far.`);
  }
  if (usage?.inbound_messages != null && usage?.outbound_messages != null) {
    summaryParts.push(`Inbound vs outbound mix this month: ${usage.inbound_messages} received / ${usage.outbound_messages} sent.`);
  }

  const baseContext = summaryParts.length ? summaryParts.join(" ") : "This account has limited recent message data so far.";

  const historyContext = history.length ? `\n\nRecent months:\n${historyLines}` : "";

  const system = [
    "You are a business coach helping a user improve how they use their WhatsApp Agent.",
    "You will receive a brief summary of their recent messaging and plan usage.",
    "Your job is to provide 3–5 concise, practical insights: what is going well, where they might be struggling, and specific suggestions to improve response times, campaign performance, or knowledge base coverage.",
    "Be encouraging but honest. Avoid generic fluff. Use plain language, no marketing buzzwords.",
    "Output a short paragraph followed by a few bullet points starting with a dash (\"-\").",
  ].join("\n");

  const userPrompt = `Here is the latest usage summary and history for a user's WhatsApp Agent account:

${baseContext}
${historyContext}

The user wants to know:
- What they are doing well
- Where they might be struggling
- The most impactful next steps to improve their automated support and campaigns

Write a brief recap with clear, actionable advice.`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 260,
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    logOpenAiError(e, "Usage insights error");
    return "";
  }
}
