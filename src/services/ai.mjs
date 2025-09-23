import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    console.error("KB coach error:", e?.message || e);
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
        console.error("AI error:", e);
        return null;
    }

}

export async function onboardingCoachReply(userMessage, kbItems = [], historyTranscript = "") {
  const titles = (kbItems || []).map((r) => `- ${r.title || "Untitled"}`).join("\n");
  const history = String(historyTranscript || "").slice(-4000);
  const system = "You are a concise onboarding copilot that interviews a business owner and drafts customer-facing KB entries.";
  const instruction = `Existing KB titles:\n${titles || "(none yet)"}\n\nConversation history (latest last):\n${history || "(no history)"}\n\nTarget topics:\nBusiness Name; What We Do; Audience; Hours; Locations; Products & Services; Delivery; Returns; Payments; Top FAQs.\n\nGoals:\n- Ask only what is missing. When enough info exists for any topic, SAVE IT immediately.\n- Prefer SEPARATE entries per topic rather than a single overview. You may emit multiple saves in one turn.\n\nDirectives (MUST FOLLOW):\n- If you need more info, end your message with THIS EXACT SINGLE LINE:\n  ASK_MORE|<Your single follow-up question>\n- If you can save, append one or more lines at the END, each in this exact format (one line per KB item):\n  ADD_KB|<Title>|<Content>\n  Example:\n  ADD_KB|Business Name|Code Orbit\n  ADD_KB|Hours|Mon–Sat 09:00–19:00; Sun 11:00–17:00\n  ADD_KB|Payments|Card only\n- When you believe onboarding is complete (core topics captured sufficiently), append one final line:\n  COMPLETE\n- Never include ASK_MORE together with COMPLETE. It is okay to include multiple ADD_KB lines plus COMPLETE.\n- Do not output a generic "overview" item unless the user asks explicitly. Prefer separate items by topic.\n- Keep the visible part of your message short (<= 4 lines).\n- <Content> must be customer-ready plain text, no placeholders.`;

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
    console.error("Onboarding coach error:", e?.message || e);
    return "";
  }
}