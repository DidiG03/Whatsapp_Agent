import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function logOpenAiError(err, label = "OpenAI error") {
  try {
    const status = err?.status || err?.response?.status || null;
    const dataErr = err?.response?.data?.error || err?.error || {};
    const code = dataErr?.code || err?.code || null;
    const type = dataErr?.type || err?.type || null;
    const message = dataErr?.message || err?.message || String(err);
    const isQuota = status === 429 || String(code).includes('insufficient_quota') || String(type).includes('insufficient_quota') || /billing.*limit/i.test(String(message)) || /insufficient.*quota/i.test(String(message));
    console.error(`[${label}]`, { status, code, type, message });
    if (isQuota) {
      console.error(`[${label}] Detected possible quota/billing exhaustion. Please top up your OpenAI account or check usage limits.`);
    }
  } catch (_) {
    console.error(label, err);
  }
}

export async function kbCoachReply(userMessage, existingTitles = [], historyTranscript = "") {
  const context = (existingTitles || []).map((t) => `- ${t}`).join("\n");
  const history = String(historyTranscript || "").slice(-4000); // keep last ~4K chars
  const system = "You are a KB coach. Be brief, helpful, and friendly.";
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
- Do not output both lines. Use exactly one of them when applicable; otherwise output neither.
- Keep your visible answer short (<= 4 lines).`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${instruction}\n\nUser: ${userMessage}\nAssistant:` }
      ],
      temperature: 0.2,
      max_tokens: 250
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    logOpenAiError(e, "KB coach error");
    return "";
  }
}
/**
 * Generate a reply from the AI.
 * @param {string} userMessage The user's message
 * @param {Array<{title: string, content: string}>} contextSnippets The knowledge base matches
 * @param {{ tone: string, style: string, blockedTopics: string }} options The AI options
 */

export async function generateAiReply(userMessage, contextSnippets, options = {}) {
    const context = contextSnippets
    .map((s, i) => `# Doc ${i+1}: ${s.title || "Untitled"}\n${s.content}`)
    .join("\n\n");

    const tone = (options.tone || "friendly").trim();
    const style = (options.style || "clear and concise").trim();
    const blockedTopics = String(options.blockedTopics || "").trim();
    const blockedLine = blockedTopics
    ? `Do NOT answer about these topics ${blockedTopics}. If asked, refuse and suggest`
    : "";

    const prompt = `You are a Whatsapp assistant for a business. 
    Use the provided docs (KB context) only. Keep replies short.
    Tone: ${tone}. Style: ${style}. ${blockedLine}
    Never invent facts. If the docs do not contain an answer, say so briefly.
    
    Docs:
    ${context}

    User: ${userMessage}
    Assistant:`;

    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You answer briefly, clearly and concisely" },
                { role: "user", content: prompt }
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

export async function onboardingCoachReply(userMessage, kbItems = [], historyTranscript = "") {
  const titles = (kbItems || []).map((r) => `- ${r.title || "Untitled"}`).join("\n");
  const history = String(historyTranscript || "").slice(-4000);
  const system = "You are a concise onboarding copilot that interviews a business owner and drafts customer-facing KB entries. You also capture a few account settings when explicitly provided.";
  const instruction = `Existing KB titles:\n${titles || "(none yet)"}\n\nConversation history (latest last):\n${history || "(no history)"}\n\nTarget topics (separate items):\nBusiness Name; What We Do; Audience; Hours; Locations; Products; Services; Service Areas; Appointments; Booking; Pricing; Payments; Delivery; Shipping; Returns; Warranty; Contact; Social Links; Top FAQs.\n\nIndustry coverage examples (ask only what's relevant):\n- Restaurants: Menu; Reservations; Walk-ins; Delivery partners; Pickup; Dietary notes; Hours; Locations; Contact; Social; Payment methods.\n- Healthcare (doctors/dentists/clinics): Services; Appointments; Booking link/phone; New patient intake; Insurance; Hours; Emergency policy; Locations; Payments.\n- Retail/eCommerce: Product categories; Shipping areas and fees; Pickup; Returns/Exchanges; Warranty; Payments; Hours; Locations.\n\nBranching guidance:\n- First determine whether they offer SERVICES, PRODUCTS, or BOTH.\n- If SERVICES: ask if they take APPOINTMENTS; if yes, ask how to BOOK (link/phone), lead time, cancellation rules.\n- If PRODUCTS: ask for categories/flagships, availability, delivery/shipping areas and fees, returns/warranty.\n- Always keep questions minimal and only for missing pieces.\n\nSettings capture (optional) — if the user clearly provides them, append SET lines to save:\n- SET|website_url|https://example.com\n- SET|business_phone|+15551234567 (digits or E.164)\n- SET|entry_greeting|Hello! How can I help?\n- SET|ai_tone|professional\n- SET|ai_style|concise\n- SET|ai_blocked_topics|refunds, legal\n\nDirectives (MUST FOLLOW EXACTLY):\n- If you need more info, end with THIS SINGLE LINE:\n  ASK_MORE|<Your single follow-up question>\n- If you can save, append one or more lines at the END, each in this exact format (one per KB item):\n  ADD_KB|<Title>|<Content>\n  Example:\n  ADD_KB|Appointments|We accept appointments Mon–Fri. Book at https://... or call +1 555...\n  ADD_KB|Services|Teeth cleaning; Whitening; Emergencies\n- You may include multiple ADD_KB lines in one message.\n- If onboarding seems complete, add one final line:\n  COMPLETE\n- Never include ASK_MORE with COMPLETE. Visible text must be short (<= 4 lines).\n- <Content> must be customer-ready plain text (no placeholders).`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${instruction}\n\nUser: ${userMessage}\nAssistant:` }
      ],
      temperature: 0.2,
      max_tokens: 600
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    logOpenAiError(e, "Onboarding coach error");
    return "";
  }
}