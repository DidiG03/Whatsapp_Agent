import { describe, expect, test } from "@jest/globals";
import { detectMessageTopics, isMultiTopicMessage, splitMessageClauses } from "../../src/services/messageTopics.mjs";
import { routeCustomerMessage, MESSAGE_ROUTES } from "../../src/services/messageRouter.mjs";
import {
  isAvailabilityInquiry,
  isExplicitAvailabilityRequest,
  wantsTimeSlotSuggestions,
} from "../../src/services/agent-intelligence.mjs";
import {
  buildBusinessIdentityConfirmationReply,
  isBusinessIdentityConfirmationQuestion,
} from "../../src/services/i18n.mjs";

describe("messageTopics", () => {
  test("splits Albanian compound message on dhe", () => {
    const parts = splitMessageClauses("Doja te dija ku ndodheni dhe nese keni rezervime te lira per neser");
    expect(parts.length).toBe(2);
  });

  test("detects overview and location together", () => {
    const msg = "Mire, mund tme thuash pak rreth restorantit tuaj? Dhe ku ndodheni nese mund tju pyes?";
    const topics = detectMessageTopics(msg, { bookingsEnabled: true });
    expect(topics).toContain("location");
    expect(topics).toContain("overview");
    expect(isMultiTopicMessage(msg, { bookingsEnabled: true })).toBe(true);
  });

  test("detects location and booking together for soft availability ask", () => {
    const msg = "Doja te dija ku ndodheni dhe nese keni rezervime te lira per neser";
    const topics = detectMessageTopics(msg, { bookingsEnabled: true });
    expect(topics).toContain("location");
    expect(topics).toContain("booking");
    expect(topics).not.toContain("availability");
    expect(isMultiTopicMessage(msg, { bookingsEnabled: true })).toBe(true);
  });

  test("soft reservation ask is not an explicit slot-list request", () => {
    expect(isAvailabilityInquiry("nese keni rezervime te lira per neser")).toBe(true);
    expect(isExplicitAvailabilityRequest("nese keni rezervime te lira per neser")).toBe(false);
    expect(wantsTimeSlotSuggestions("nese keni rezervime te lira per neser")).toBe(false);
  });

  test("explicit time suggestion ask matches wantsTimeSlotSuggestions", () => {
    expect(wantsTimeSlotSuggestions("cilat orare keni per neser")).toBe(true);
    expect(isExplicitAvailabilityRequest("what times do you have tomorrow")).toBe(true);
  });

  test("router sends multi-topic messages to general AI path", () => {
    const result = routeCustomerMessage(
      "Where are you located and do you have any free times tomorrow?",
      { bookingsEnabled: true, lang: "en" }
    );
    expect(result.route).toBe(MESSAGE_ROUTES.GENERAL);
    expect(result.reason).toBe("multi_topic");
    expect(result.topics?.length).toBeGreaterThan(1);
  });

  test("isBusinessIdentityConfirmationQuestion detects right-number checks", () => {
    expect(isBusinessIdentityConfirmationQuestion("Pershendetje flas me ullishtja agroturizem?")).toBe(true);
    expect(isBusinessIdentityConfirmationQuestion("Am I speaking with Ullishtja Agroturizem?")).toBe(true);
    expect(isBusinessIdentityConfirmationQuestion("Mund te me thuash pak rreth restorantit tuaj?")).toBe(false);
  });

  test("buildBusinessIdentityConfirmationReply stays brief", () => {
    const reply = buildBusinessIdentityConfirmationReply({
      businessName: "Ullishtja Agroturizëm",
      lang: "sq",
      userMessage: "Pershendetje flas me ullishtja agroturizem?",
    });
    expect(reply).toContain("Ullishtja Agroturizëm");
    expect(reply).toMatch(/Si mund t'ju ndihmoj\?/);
    expect(reply).not.toMatch(/restorant|Durr[eë]s/i);
  });
});
