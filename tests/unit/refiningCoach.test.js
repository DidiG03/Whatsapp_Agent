import { describe, expect, it } from "@jest/globals";
import { isRefiningSuggestionRequest } from "../../src/services/ai.mjs";

describe("isRefiningSuggestionRequest", () => {
  it("detects suggestion-style owner questions", () => {
    expect(isRefiningSuggestionRequest("what are some good things to add for our business?")).toBe(true);
    expect(isRefiningSuggestionRequest("Any ideas for rules I should add?")).toBe(true);
    expect(isRefiningSuggestionRequest("What should we add to the bot?")).toBe(true);
    expect(isRefiningSuggestionRequest("Recommend improvements")).toBe(true);
  });

  it("does not flag concrete rule instructions", () => {
    expect(isRefiningSuggestionRequest("For groups over 30, ask them to call us")).toBe(false);
    expect(isRefiningSuggestionRequest("Remove the large group rule")).toBe(false);
  });
});
