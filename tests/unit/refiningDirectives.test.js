import { describe, expect, test } from "@jest/globals";
import {
  mergeRefiningRules,
  parseRefiningDirectives,
  formatRefiningRulesForPrompt,
  removeRuleAtIndex,
} from "../../src/services/refiningDirectives.mjs";

describe("refiningDirectives", () => {
  test("parseRefiningDirectives extracts reply and rules", () => {
    const text = [
      "REPLY|Got it — I'll send large groups to call you.",
      "ADD_RULE|When a customer requests a booking for more than 30 people, advise them to call directly.",
    ].join("\n");
    const parsed = parseRefiningDirectives(text);
    expect(parsed.reply).toContain("large groups");
    expect(parsed.addRules).toHaveLength(1);
    expect(parsed.addRules[0]).toContain("30 people");
  });

  test("mergeRefiningRules appends and removes rules", () => {
    const current = "Rule one\nRule two about groups";
    const merged = mergeRefiningRules(current, {
      addRules: ["Rule three"],
      removeRules: ["groups"],
    });
    expect(merged).toContain("Rule one");
    expect(merged).not.toContain("groups");
    expect(merged).toContain("Rule three");
  });

  test("formatRefiningRulesForPrompt renders numbered block", () => {
    const out = formatRefiningRulesForPrompt("Always greet warmly\nCall for large groups");
    expect(out).toContain("BUSINESS OWNER RULES");
    expect(out).toContain("1. Always greet warmly");
    expect(out).toContain("2. Call for large groups");
  });

  test("parseRefiningDirectives extracts ASK_MORE without saving rules", () => {
    const parsed = parseRefiningDirectives("ASK_MORE|From how many people should customers call instead?");
    expect(parsed.askMore).toContain("how many people");
    expect(parsed.addRules).toHaveLength(0);
  });

  test("parseRefiningDirectives keeps REPLY and ADD_RULE when complete", () => {
    const parsed = parseRefiningDirectives([
      "REPLY|Done.",
      "ADD_RULE|When party size exceeds 30, tell customers to call +355 69 123 4567.",
    ].join("\n"));
    expect(parsed.askMore).toBe("");
    expect(parsed.addRules).toHaveLength(1);
  });

  test("removeRuleAtIndex removes a rule by position", () => {
    const current = "Rule one\nRule two\nRule three";
    const result = removeRuleAtIndex(current, 1);
    expect(result.ok).toBe(true);
    expect(result.rules).toBe("Rule one\nRule three");
  });

  test("removeRuleAtIndex rejects invalid index", () => {
    expect(removeRuleAtIndex("Only rule", 5).ok).toBe(false);
  });

  test("parseRefiningDirectives extracts ENFORCE lines", () => {
    const parsed = parseRefiningDirectives([
      "REPLY|Saved.",
      "ADD_RULE|When party size exceeds 30, call us.",
      "ENFORCE|party_size_call|30|+355691234567",
    ].join("\n"));
    expect(parsed.enforceRules).toHaveLength(1);
    expect(parsed.enforceRules[0].minParty).toBe(30);
  });
});
