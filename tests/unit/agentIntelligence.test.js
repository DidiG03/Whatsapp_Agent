import { describe, expect, test } from "@jest/globals";
import {
  bookingReplyAsksForName,
  bookIntentReady,
  isBookingNameCompletion,
  isUsableCustomerName,
  mergeAgentDecision,
  normalizeExecutedIntent,
  sanitizeReplyWhenBookingReady,
  wantsTimeSlotSuggestions,
} from "../../src/services/agent-intelligence.mjs";
import { isHowAreYouQuestion, isCustomerWellbeingReply, isThankYouMessage, polishPleasantryReply, sanitizeAssistantReply } from "../../src/services/i18n.mjs";

describe("agentIntelligence", () => {
  test("mergeAgentDecision keeps AI none when reply asks for name", () => {
    const ai = {
      text: "Patjetër, nesër në orën 9. Në çfarë emri ta vendos rezervimin?",
      intent: { type: "none" },
    };
    const inferred = { type: "book", data: { datetime: "9" }, confidence: 0.9, source: "rules" };
    const merged = mergeAgentDecision(ai, inferred, { aiText: ai.text, userText: "9" });
    expect(merged.intent.type).toBe("none");
  });

  test("mergeAgentDecision does not infer book from soft availability inquiry", () => {
    const ai = {
      text: "Po, për nesër sa persona do të jeni?",
      intent: { type: "none" },
    };
    const inferred = {
      type: "book",
      data: { datetime: "nese keni rezervime te lira per neser" },
      confidence: 0.82,
      source: "rules",
    };
    const merged = mergeAgentDecision(ai, inferred, {
      aiText: ai.text,
      userText: "nese keni rezervime te lira per neser",
    });
    expect(merged.intent.type).toBe("none");
  });

  test("normalizeExecutedIntent strips book when reply asks for name and booking not ready", () => {
    const out = normalizeExecutedIntent({
      intentType: "book",
      intentData: { datetime: "9" },
      text: "9",
      replyText: "Në çfarë emri ta vendos rezervimin?",
    });
    expect(out.intentType).toBe("none");
  });

  test("normalizeExecutedIntent keeps book when ready even if reply redundantly asks for name", () => {
    const history = [
      { role: "user", content: "tomorrow at 8" },
      { role: "assistant", content: "What name should I put on the reservation?" },
    ];
    const out = normalizeExecutedIntent({
      intentType: "book",
      intentData: { name: "prupa drupa" },
      text: "prupa drupa",
      replyText: "Thanks, I've noted prupa drupa for tomorrow at 8. What's your name?",
      historyMessages: history,
      contactId: "447312706087",
      bookingFields: [{ id: "name", type: "name", required: true }],
    });
    expect(out.intentType).toBe("book");
  });

  test("sanitizeReplyWhenBookingReady removes redundant name question", () => {
    const out = sanitizeReplyWhenBookingReady(
      "Thanks, I've noted prupa drupa for tomorrow at 8. What's your name?",
      { lang: "en", bookingFields: [{ id: "name", type: "name", required: true }] }
    );
    expect(out).not.toMatch(/what'?s your name/i);
    expect(out.length).toBeGreaterThan(3);
  });

  test("normalizeExecutedIntent strips availability without explicit slot request", () => {
    const out = normalizeExecutedIntent({
      intentType: "availability",
      intentData: { datetime: "neser" },
      text: "nese keni rezervime te lira per neser",
      replyText: "Sa persona do te jeni?",
    });
    expect(out.intentType).toBe("none");
  });

  test("isUsableCustomerName rejects phone numbers", () => {
    expect(isUsableCustomerName("447312706087", "447312706087")).toBe(false);
    expect(isUsableCustomerName("Mark", "447312706087")).toBe(true);
  });

  test("bookingReplyAsksForName detects Albanian name prompt", () => {
    expect(bookingReplyAsksForName("Në çfarë emri ta vendos rezervimin?")).toBe(true);
    expect(bookingReplyAsksForName("Patjetër, nesër në orën 21:00 për 5 persona. Si quheni")).toBe(true);
  });

  test("mergeAgentDecision strips premature AI book without customer name", () => {
    const ai = {
      text: "Rezervimi juaj është konfirmuar për nesër.",
      intent: { type: "book", data: { datetime: "neser 21:00", partySize: 5 } },
    };
    const merged = mergeAgentDecision(ai, null, {
      aiText: ai.text,
      userText: "Neser ne 9 ne dark per 5 persona",
      historyMessages: [],
    });
    expect(merged.intent.type).toBe("none");
  });

  test("normalizeExecutedIntent strips book without name unless completing with name", () => {
    const history = [
      { role: "user", content: "Neser ne 9 ne dark per 5 persona" },
      { role: "assistant", content: "Patjetër, nesër në orën 21:00 për 5 persona. Si quheni?" },
    ];
    expect(normalizeExecutedIntent({
      intentType: "book",
      intentData: { partySize: 5 },
      text: "Neser ne 9 ne dark per 5 persona",
      replyText: "Si quheni?",
      historyMessages: history,
    }).intentType).toBe("none");

    expect(normalizeExecutedIntent({
      intentType: "book",
      intentData: { name: "Bashruti Kuki", partySize: 5 },
      text: "Bashruti Kuki",
      replyText: "Faleminderit, Bashruti.",
      historyMessages: history,
      contactId: "447312706087",
    }).intentType).toBe("book");
  });

  test("normalizeExecutedIntent strips book when party size missing", () => {
    const history = [
      { role: "user", content: "Neser ne 9 ne dark" },
      { role: "assistant", content: "Patjetër, nesër në orën 21:00. Si quheni?" },
    ];
    expect(normalizeExecutedIntent({
      intentType: "book",
      intentData: { name: "Sefrid Kuki" },
      text: "Sefrid Kuki",
      replyText: "Në rregull, Sefrid Kuki. Sa persona do të jeni?",
      historyMessages: history,
      contactId: "447312706087",
    }).intentType).toBe("none");
  });

  test("bookIntentReady accepts lowercase standalone name", () => {
    expect(bookIntentReady({
      text: "bashruti kuki",
      intentData: { name: "bashruti kuki", partySize: 5 },
      historyMessages: [
        { role: "assistant", content: "Si quheni?" },
      ],
      contactId: "447312706087",
    })).toBe(true);
  });

  test("isBookingNameCompletion detects name reply after name prompt", () => {
    const history = [
      { role: "user", content: "Per neser ne 9 ne dark. Do jemi 5 persona" },
      { role: "assistant", content: "Patjetër, nesër në orën 9 të darkës për 5 persona. Si quheni?" },
    ];
    expect(isBookingNameCompletion("Bashruti Kuki", history)).toBe(true);
  });

  test("mergeAgentDecision forces book when completing with name and party size", () => {
    const history = [
      { role: "user", content: "Per neser ne 9 ne dark per 5 persona" },
      { role: "assistant", content: "Patjetër, nesër në orën 9 të darkës për 5 persona. Si quheni?" },
    ];
    const ai = {
      text: "Në rregull, nesër në orën 9 të darkës për 5 persona, në emrin Bashruti Kuki",
      intent: { type: "none" },
    };
    const inferred = { type: "book", data: { name: "Bashruti Kuki", partySize: 5 }, confidence: 0.92, source: "rules" };
    const merged = mergeAgentDecision(ai, inferred, {
      aiText: ai.text,
      userText: "Bashruti Kuki",
      completingBookingWithName: true,
      historyMessages: history,
      contactId: "447312706087",
    });
    expect(merged.intent.type).toBe("book");
    expect(merged.intent.data.name).toBe("Bashruti Kuki");
  });

  test("wantsTimeSlotSuggestions requires explicit list ask", () => {
    expect(wantsTimeSlotSuggestions("cilat orare keni per neser")).toBe(true);
    expect(wantsTimeSlotSuggestions("nese keni rezervime te lira per neser")).toBe(false);
  });

  test("isHowAreYouQuestion detects Albanian and English", () => {
    expect(isHowAreYouQuestion("Pershendetje, si jeni")).toBe(true);
    expect(isHowAreYouQuestion("how are you")).toBe(true);
    expect(isHowAreYouQuestion("a mund te bej nje rezervim")).toBe(false);
  });

  test("isCustomerWellbeingReply detects short wellbeing replies", () => {
    expect(isCustomerWellbeingReply("shum mirë")).toBe(true);
    expect(isCustomerWellbeingReply("shume mire")).toBe(true);
    expect(isCustomerWellbeingReply("ne rregull")).toBe(true);
    expect(isCustomerWellbeingReply("a mund te rezervoj")).toBe(false);
  });

  test("isThankYouMessage detects standalone thanks", () => {
    expect(isThankYouMessage("flm")).toBe(true);
    expect(isThankYouMessage("faleminderit")).toBe(true);
    expect(isThankYouMessage("thanks")).toBe(true);
    expect(isThankYouMessage("flm per ndihmen")).toBe(false);
  });

  test("polishPleasantryReply removes yes-im-here and enriches thanks", () => {
    expect(polishPleasantryReply("Përshëndetje! Po, jam këtu!", { lang: "sq" })).toBe("Përshëndetje!");
    expect(polishPleasantryReply("S'ka problem", { userMessage: "flm", lang: "sq" })).toBe("S'ka problem, faleminderit!");
    expect(polishPleasantryReply("Shumë mirë!", { userMessage: "shum mirë", lang: "sq" })).toContain("Si mund t'ju ndihmoj");
  });

  test("sanitizeAssistantReply applies pleasantry polish", () => {
    const out = sanitizeAssistantReply("S'ka problem", { userMessage: "flm", lang: "sq" });
    expect(out).toBe("S'ka problem, faleminderit!");
  });

  test("sanitizeAssistantReply keeps greeting when customer greeted with a request", () => {
    const userMessage = "Pershendetje dua te bej nje rezervim per 40 veta";
    const raw = "Përshëndetje! Për rezervime mbi 30 veta, ju lutem na telefononi direkt.";
    const out = sanitizeAssistantReply(raw, {
      conversationStarted: true,
      userMessage,
      lang: "sq",
    });
    expect(out).toMatch(/^Përshëndetje!/i);
  });

  test("polishPleasantryReply adds greeting and thanks for policy redirect", () => {
    const userMessage = "Pershendetje dua te bej nje rezervim per 40 veta per neser";
    const raw = "Për rezervime mbi 30 veta, ju lutem na telefononi direkt në 068 409 0405, që ta organizojmë saktë. Për 40 veta për nesër, rezervimin nuk e mbyllim dot në WhatsApp";
    const out = polishPleasantryReply(raw, { userMessage, lang: "sq" });
    expect(out).toMatch(/^Përshëndetje!/i);
    expect(out).toMatch(/Faleminderit!/i);
  });
});
