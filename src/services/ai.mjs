// kb-tools.mjs
import OpenAI from "openai";

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

function normalizePhone(value) {
  if (!value) return null;
  const cleaned = value.replace(/[ \-().]/g, "");
  if (/^\+?\d{7,15}$/.test(cleaned)) {
    return cleaned.startsWith("+") ? cleaned : "+" + cleaned;
  }
  return null;
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
      const norm = normalizePhone(rawVal);
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

  const blockedLine = blockedTopics
    ? `Refuse questions about these topics: ${blockedTopics}. If asked, briefly refuse and suggest contacting support.`
    : "";

  const prompt = `You are a WhatsApp assistant for a business.
Use ONLY the provided docs (KB context). If the answer is not explicitly in the docs, say briefly that you don't have that info and offer the next best step.
Tone: ${tone}. Style: ${style}. ${blockedLine}
Keep replies short (1–4 sentences). Never invent facts.

Docs:
${context}

User: ${userMessage}
Assistant:`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You answer briefly, clearly and concisely. Do not invent facts." },
        { role: "user", content: prompt },
      ],
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

// ----------------------------- onboardingCoachReply -------------------------

function buildOnboardingSystem() {
  return [
    "You are a concise onboarding copilot that interviews a business owner and drafts customer-facing KB entries.",
    "Follow the output protocol EXACTLY. No markdown, no bullets, no code fences, no extra lines.",
    "",
    "Rules:",
    "- Language: reply in the user's language from userMessage.",
    "- Default tone/style: concise, helpful; adopt ai_tone/ai_style if provided by user.",
    "- Do NOT invent facts; if unsure, ask via ASK_MORE.",
    "- Output may contain only these lines in any order: ASK_MORE|..., ADD_KB|...|..., SET|...|..., COMPLETE",
    "",
    "Delimiters & validation:",
    "- Field delimiter is the pipe `|`. Escape any literal `|` as `\\|`.",
    "- Titles <= 60 chars, single-line.",
    "- Content must be customer-ready plain text, no placeholders.",
    "- Phone must be digits or E.164 (+…).",
    "- Website URL must start with http:// or https://.",
    "",
    "Target topics (only if relevant/missing):",
    "Business Name; What We Do; Audience; Hours; Locations; Products; Services; Service Areas; Appointments; Booking; Pricing; Payments; Delivery; Shipping; Returns; Warranty; Contact; Social Links; Top FAQs.",
    "",
    "Industry examples (ask only what’s relevant):",
    "- Restaurants: Menu; Reservations; Walk-ins; Delivery partners; Pickup; Dietary notes; Hours; Locations; Contact; Social; Payment methods.",
    "- Healthcare: Services; Appointments; Booking link/phone; New patient intake; Insurance; Hours; Emergency policy; Locations; Payments.",
    "- Retail/eCommerce: Product categories; Shipping areas/fees; Pickup; Returns/Exchanges; Warranty; Payments; Hours; Locations.",
    "",
    "Branching:",
    "1) Determine if they offer SERVICES, PRODUCTS, or BOTH.",
    "2) If SERVICES: ask about APPOINTMENTS → how to BOOK (link/phone), lead time, cancellation rules.",
    "3) If PRODUCTS: ask about categories/flagships, availability, delivery/shipping areas & fees, returns/warranty.",
    "4) Keep questions minimal; ask only for highest-impact missing info.",
    "",
    "KB behavior:",
    "- You may add multiple ADD_KB lines (cap 8). If title already exists, output the same title to replace (client will overwrite).",
    "- Prefer short, scannable content; lists separated by semicolons.",
    "",
    "Settings capture (optional) — only if clearly provided:",
    "- SET|website_url|https://example.com",
    "- SET|business_phone|+15551234567",
    "- SET|business_name|Acme Deli",
    "- SET|entry_greeting|Hello! How can I help?",
    "- SET|ai_tone|professional",
    "- SET|ai_style|concise",
    "- SET|ai_blocked_topics|refunds, legal",
    "",
    "Termination directives:",
    "- If you need more info, end with EXACTLY ONE line: ASK_MORE|<single follow-up question>",
    "- If you add KB items, output: ADD_KB|<Title>|<Content>",
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

(Reply ONLY with the allowed DSL lines, plus no extra prose unless absolutely necessary and ≤2 lines.)
`.trim();
}

/**
 * @param {string} userMessage
 * @param {{ title?: string }[]} kbItems
 * @param {string} historyTranscript
 * @returns {Promise<string>}
 */
export async function onboardingCoachReply(userMessage, kbItems = [], historyTranscript = "") {
  const system = buildOnboardingSystem();
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
