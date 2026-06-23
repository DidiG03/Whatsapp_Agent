import { describe, expect, test } from "@jest/globals";
import {
  buildThreadHistory,
  buildConversationContextBrief,
  detectTopicShift,
  extractThreadFacts,
} from "../../src/services/conversationContext.mjs";

describe("conversationContext", () => {
  test("buildThreadHistory keeps media placeholders and excludes current text", () => {
    const hist = buildThreadHistory([
      { direction: "inbound", text_body: "Pershendetje", type: "text" },
      { direction: "outbound", text_body: "Përshëndetje!", type: "text" },
      { direction: "inbound", text_body: "", type: "image" },
      { direction: "inbound", text_body: "Sa kushton menuja?", type: "text" },
    ], "Sa kushton menuja?");

    expect(hist).toHaveLength(3);
    expect(hist.some((m) => m.content === "Sa kushton menuja?")).toBe(false);
    expect(hist.some((m) => m.content === "[Image]")).toBe(true);
  });

  test("buildThreadHistory uses voice transcription when available", () => {
    const hist = buildThreadHistory([
      { direction: "inbound", text_body: "A mund te rezervoj per neser?", type: "audio" },
    ], "A mund te rezervoj per neser?");

    expect(hist).toHaveLength(0);
    const prior = buildThreadHistory([
      { direction: "inbound", text_body: "A mund te rezervoj per neser?", type: "audio" },
      { direction: "inbound", text_body: "Po, ne oren 8", type: "text" },
    ], "Po, ne oren 8");
    expect(prior.some((m) => m.content.includes("rezervoj"))).toBe(true);
  });

  test("extractThreadFacts pulls party size and datetime from thread", () => {
    const facts = extractThreadFacts([
      { role: "user", content: "Dua rezervim per neser ne 21:00" },
      { role: "assistant", content: "Sa persona do te jeni?" },
      { role: "user", content: "5 persona" },
    ]);

    expect(facts.partySize).toBe(5);
    expect(facts.dateTimeHints.length).toBeGreaterThan(0);
    expect(facts.missingForBooking).toContain("customer name");
  });

  test("detectTopicShift flags booking to FAQ pivot", () => {
    const history = [
      { role: "user", content: "Dua rezervim per neser" },
      { role: "assistant", content: "Sa persona do te jeni?" },
    ];
    const shift = detectTopicShift({
      text: "A pranoni karta krediti?",
      phase: "booking_flow",
      historyMessages: history,
      messageTopics: ["faq"],
    });

    expect(shift.detected).toBe(true);
    expect(shift.preserveFacts).toBeTruthy();
  });

  test("buildConversationContextBrief includes Albanian topic-shift guidance", () => {
    const brief = buildConversationContextBrief({
      text: "Ku ndodheni?",
      historyMessages: [
        { role: "user", content: "Dua rezervim per neser per 4 persona" },
        { role: "assistant", content: "Si quheni?" },
      ],
      phase: "booking_flow",
      lang: "sq",
      messageTopics: ["location"],
    });

    expect(brief).toMatch(/KONTEKSTI I BISEDËS/);
    expect(brief).toMatch(/NDRYSHIM TEME|Numri i personave: 4/);
  });
});
