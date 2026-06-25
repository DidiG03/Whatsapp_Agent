import { describe, expect, test } from "@jest/globals";
import {
  compilePartySizeCallFromRuleText,
  evaluateEnforcedRules,
  getEnforcedRulesFromSettings,
  parseEnforceDirective,
  appendCompiledEnforcedFromRuleText,
  guardBookingEnforcement,
  parsePartySizeFromNotes,
  BookingEnforcedError,
  assertBookingAllowed,
  isInteractiveBookingAction,
  isBookingRelatedForEnforcement,
} from "../../src/services/refiningEnforcement.mjs";

describe("refiningEnforcement", () => {
  test("compilePartySizeCallFromRuleText extracts threshold and phone", () => {
    const rule =
      "When a customer requests a booking for more than 30 people, advise them to call +355 69 123 4567. Do not complete large group bookings via WhatsApp.";
    const compiled = compilePartySizeCallFromRuleText(rule);
    expect(compiled).not.toBeNull();
    expect(compiled.type).toBe("party_size_call");
    expect(compiled.minParty).toBe(30);
    expect(compiled.phone).toMatch(/^\+355/);
  });

  test("parseEnforceDirective parses coach ENFORCE line", () => {
    const parsed = parseEnforceDirective("ENFORCE|party_size_call|30|+355691234567");
    expect(parsed.minParty).toBe(30);
    expect(parsed.phone).toBe("+355691234567");
  });

  test("evaluateEnforcedRules blocks when party size exceeds minimum", () => {
    const enforced = evaluateEnforcedRules({
      enforcedRules: [{ type: "party_size_call", minParty: 30, phone: "+355691234567", enabled: true }],
      text: "We are 40 people and want to book tomorrow",
      lang: "en",
    });
    expect(enforced?.blockBooking).toBe(true);
    expect(enforced.reply).toContain("30");
    expect(enforced.reply).toContain("+355691234567");
  });

  test("evaluateEnforcedRules does not block small parties", () => {
    const enforced = evaluateEnforcedRules({
      enforcedRules: [{ type: "party_size_call", minParty: 30, phone: "+355691234567", enabled: true }],
      text: "We are 6 people for tomorrow at 8pm",
      lang: "en",
    });
    expect(enforced).toBeNull();
  });

  test("getEnforcedRulesFromSettings compiles legacy text rules when json empty", () => {
    const settings = {
      ai_refining_rules:
        "When a customer requests a booking for more than 25 people, tell them to call +447700900123 and do not complete booking via WhatsApp.",
    };
    const rules = getEnforcedRulesFromSettings(settings);
    expect(rules).toHaveLength(1);
    expect(rules[0].minParty).toBe(25);
  });

  test("appendCompiledEnforcedFromRuleText stores compiled rule", () => {
    const json = appendCompiledEnforcedFromRuleText(
      null,
      "For groups over 15 people, call +12345678901 — do not complete booking in chat."
    );
    expect(json).toBeTruthy();
    const rules = getEnforcedRulesFromSettings({ ai_refining_enforced_json: json });
    expect(rules[0].minParty).toBe(15);
  });

  test("parsePartySizeFromNotes reads labeled party size", () => {
    expect(parsePartySizeFromNotes("Name: Ana | Party size: 40")).toBe(40);
  });

  test("guardBookingEnforcement uses settings rules and notes", async () => {
    const blocked = await guardBookingEnforcement({
      userId: null,
      cfg: {
        ai_refining_enforced_json: JSON.stringify([
          { type: "party_size_call", minParty: 20, phone: "+10000000000", enabled: true },
        ]),
      },
      notes: "Name: Sam | Party size: 25",
      lang: "en",
      requireBookingContext: false,
    });
    expect(blocked?.blockBooking).toBe(true);
  });

  test("guardBookingEnforcement skips non-booking context when party only in history", async () => {
    const blocked = await guardBookingEnforcement({
      cfg: {
        ai_refining_enforced_json: JSON.stringify([
          { type: "party_size_call", minParty: 20, phone: "+10000000000", enabled: true },
        ]),
      },
      text: "where are you located?",
      historyMessages: [{ role: "user", content: "we are 25 people" }],
      conversationPhase: "general",
      route: "location",
      requireBookingContext: true,
    });
    expect(blocked).toBeNull();
  });

  test("isBookingRelatedForEnforcement detects booking flow", () => {
    expect(isBookingRelatedForEnforcement({ conversationPhase: "booking_flow" })).toBe(true);
    expect(isBookingRelatedForEnforcement({ text: "where are you?" })).toBe(false);
    expect(isBookingRelatedForEnforcement({ text: "book a table tomorrow" })).toBe(true);
  });

  test("assertBookingAllowed throws BookingEnforcedError", async () => {
    await expect(
      assertBookingAllowed({
        cfg: {
          ai_refining_enforced_json: JSON.stringify([
            { type: "party_size_call", minParty: 10, phone: "+10000000000", enabled: true },
          ]),
        },
        text: "12 people tomorrow",
        lang: "en",
        requireBookingContext: false,
      })
    ).rejects.toBeInstanceOf(BookingEnforcedError);
  });

  test("resolveEffectivePartySize prefers current message over stale memory", () => {
    const size = evaluateEnforcedRules({
      enforcedRules: [{ type: "party_size_call", minParty: 30, phone: "+355691234567", enabled: true }],
      text: "We are 40 people tomorrow at 8pm",
      partySize: 4,
      memPartySize: 4,
      lang: "en",
    });
    expect(size?.blockBooking).toBe(true);
    expect(size?.partySize).toBe(40);
  });

  test("isInteractiveBookingAction detects booking buttons", () => {
    expect(isInteractiveBookingAction("GREET_BOOK")).toBe(true);
    expect(isInteractiveBookingAction("BOOK_SLOT_abc")).toBe(true);
    expect(isInteractiveBookingAction("CSAT_3")).toBe(false);
  });
});
