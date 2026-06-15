/**
 * Router tests use generic tenant fixtures — any business type, not a specific customer.
 */
import { describe, expect, test } from "@jest/globals";
import { routeCustomerMessage, MESSAGE_ROUTES } from "../../src/services/messageRouter.mjs";
import { assessPrimaryKbConfidence } from "../../src/services/kb.mjs";

const sampleBusinessName = "Harbor Cafe";
const sampleWebsite = "https://example-cafe.com";

const wifiMatches = [
  {
    title: "Do you have wi fi",
    content: "Yes, we offer free WiFi for all guests.",
    score: 100,
  },
  {
    title: "Do you accept credit cards",
    content: "Yes, we accept Visa and Mastercard.",
    score: 80,
  },
];

const businessKbMatches = [
  {
    title: "English menu",
    content: `You can find the menu in English on our website: ${sampleWebsite}`,
    score: 100,
  },
  {
    title: "About Us",
    content: `${sampleBusinessName} is a neighborhood cafe serving breakfast and lunch.`,
    score: 90,
  },
];

describe("routeCustomerMessage", () => {
  test("routes Albanian business overview questions to overview", () => {
    const result = routeCustomerMessage(
      "cfare mund te me thuash per biznesin tuaj. Dua te di me shum",
      { lang: "sq", kbMatches: businessKbMatches }
    );
    expect(result.route).toBe(MESSAGE_ROUTES.OVERVIEW);
    expect(result.reason).toBe("business_overview");
  });

  test("routes English overview questions to overview", () => {
    const result = routeCustomerMessage("Tell me about your business, I want to know more", {
      lang: "en",
      kbMatches: businessKbMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.OVERVIEW);
  });

  test("routes location questions before FAQ matching", () => {
    const result = routeCustomerMessage("Ku ndodheni?", {
      lang: "sq",
      kbMatches: wifiMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.LOCATION);
  });

  test("routes explicit handoff requests to handoff", () => {
    const result = routeCustomerMessage("Dua te flas me nje njeri", {
      lang: "sq",
      conversationPhase: "handoff_request",
    });
    expect(result.route).toBe(MESSAGE_ROUTES.HANDOFF);
  });

  test("routes escalation mode to handoff", () => {
    const result = routeCustomerMessage("Hello", {
      conversationMode: "escalation",
    });
    expect(result.route).toBe(MESSAGE_ROUTES.HANDOFF);
    expect(result.reason).toBe("escalation_mode");
  });

  test("routes active booking phases to booking", () => {
    const result = routeCustomerMessage("5 persona", {
      lang: "sq",
      bookingsEnabled: true,
      conversationPhase: "booking_flow",
    });
    expect(result.route).toBe(MESSAGE_ROUTES.BOOKING);
  });

  test("routes cancel pending phase to booking", () => {
    const result = routeCustomerMessage("po anuloje", {
      lang: "sq",
      bookingsEnabled: true,
      conversationPhase: "cancel_pending",
    });
    expect(result.route).toBe(MESSAGE_ROUTES.BOOKING);
  });

  test("routes strong booking intent to booking", () => {
    const result = routeCustomerMessage("Rezervim neser ora 20:00", {
      lang: "sq",
      bookingsEnabled: true,
      inferredIntent: { type: "book", confidence: 0.9 },
    });
    expect(result.route).toBe(MESSAGE_ROUTES.BOOKING);
    expect(result.reason).toBe("intent_book");
  });

  test("routes confident wifi FAQ to faq fast path", () => {
    const result = routeCustomerMessage("A keni wifi?", {
      lang: "sq",
      kbMatches: wifiMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.FAQ);
    expect(result.primaryKbMatch?.title).toMatch(/wi fi/i);
  });

  test("routes confident credit card FAQ to faq fast path", () => {
    const result = routeCustomerMessage("A pranoni karta krediti?", {
      lang: "sq",
      kbMatches: wifiMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.FAQ);
    expect(result.primaryKbMatch?.title).toMatch(/credit/i);
  });

  test("does not fast-path overview questions to a narrow FAQ doc", () => {
    const result = routeCustomerMessage("cfare mund te me thuash per biznesin tuaj", {
      lang: "sq",
      kbMatches: businessKbMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.OVERVIEW);
    expect(result.route).not.toBe(MESSAGE_ROUTES.FAQ);
  });

  test("falls back to general AI when FAQ match is ambiguous", () => {
    const ambiguousMatches = [
      {
        title: "Section A",
        content: "The terrace welcomes dogs and terrace guests with dogs are allowed on the terrace daily.",
      },
      {
        title: "Section B",
        content: "The terrace permits dogs and terrace guests with dogs are welcome on the terrace daily.",
      },
    ];
    const result = routeCustomerMessage("Are dogs allowed on the terrace?", {
      lang: "en",
      kbMatches: ambiguousMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.GENERAL);
    expect(result.kbAssessment?.useFastPath).toBe(false);
  });

  test("routes generic chitchat to general", () => {
    const result = routeCustomerMessage("Faleminderit shume", {
      lang: "sq",
      kbMatches: wifiMatches,
    });
    expect(result.route).toBe(MESSAGE_ROUTES.GENERAL);
  });

  test("routes availability phase to booking", () => {
    const result = routeCustomerMessage("Cilat orare keni te lira?", {
      lang: "sq",
      bookingsEnabled: true,
      conversationPhase: "availability_check",
    });
    expect(result.route).toBe(MESSAGE_ROUTES.BOOKING);
  });

  test("routes handoff intent to handoff", () => {
    const result = routeCustomerMessage("Connect me with support", {
      lang: "en",
      inferredIntent: { type: "handoff", confidence: 0.9 },
    });
    expect(result.route).toBe(MESSAGE_ROUTES.HANDOFF);
  });
});

describe("assessPrimaryKbConfidence", () => {
  test("rejects overview questions for FAQ fast path", () => {
    const result = assessPrimaryKbConfidence(
      "cfare mund te me thuash per biznesin tuaj. Dua te di me shum",
      businessKbMatches,
      "sq"
    );
    expect(result.useFastPath).toBe(false);
    expect(result.reason).toBe("overview_question");
  });

  test("accepts title-aligned FAQ matches", () => {
    const result = assessPrimaryKbConfidence("A keni wifi?", wifiMatches, "sq");
    expect(result.useFastPath).toBe(true);
    expect(result.match?.title).toMatch(/wi fi/i);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  test("rejects non-FAQ messages", () => {
    const result = assessPrimaryKbConfidence("Faleminderit", wifiMatches, "sq");
    expect(result.useFastPath).toBe(false);
    expect(result.reason).toBe("not_faq_question");
  });

  test("rejects low-score matches", () => {
    const result = assessPrimaryKbConfidence("A keni wifi?", [{ title: "Returns", content: "30 day returns." }], "sq");
    expect(result.useFastPath).toBe(false);
    expect(result.reason).toMatch(/score_below_threshold|no_scored_match/);
  });

  test("rejects ambiguous second-best matches without title overlap", () => {
    const closeMatches = [
      {
        title: "Section A",
        content: "The terrace welcomes dogs and terrace guests with dogs are allowed on the terrace daily.",
      },
      {
        title: "Section B",
        content: "The terrace permits dogs and terrace guests with dogs are welcome on the terrace daily.",
      },
    ];
    const result = assessPrimaryKbConfidence("Are dogs allowed on the terrace?", closeMatches, "en");
    expect(result.useFastPath).toBe(false);
    expect(result.reason).toBe("ambiguous_match");
  });

  test("allows high-score matches even without title overlap", () => {
    const matches = [
      {
        title: "Do you have wi fi",
        content: "Yes we have wireless internet throughout the property for every guest.",
      },
    ];
    const result = assessPrimaryKbConfidence("Do you have wireless internet?", matches, "en");
    expect(result.useFastPath).toBe(true);
    expect(result.reason).toMatch(/title_match|high_score/);
  });
});
