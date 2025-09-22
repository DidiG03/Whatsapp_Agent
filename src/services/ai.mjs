import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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