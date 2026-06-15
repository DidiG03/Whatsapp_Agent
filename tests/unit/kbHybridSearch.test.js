import { describe, expect, test } from "@jest/globals";
import { cosineSimilarity } from "../../src/services/kbEmbeddings.mjs";
import { mergeHybridKbResults, topicScoreForItem } from "../../src/services/kbHybridSearch.mjs";

describe("cosineSimilarity", () => {
  test("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  test("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("returns 0 for invalid input", () => {
    expect(cosineSimilarity(null, [1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe("mergeHybridKbResults", () => {
  const wifiDoc = {
    id: "wifi-1",
    title: "Do you have wi fi",
    content: "Yes, free WiFi is available for all guests.",
    score: 120,
  };
  const hoursDoc = {
    id: "hours-1",
    title: "Business Hours",
    content: "We are open Monday to Saturday from 9am to 9pm.",
    score: 40,
  };

  test("prefers docs with both keyword and vector signal", () => {
    const merged = mergeHybridKbResults(
      [hoursDoc, wifiDoc],
      [{ id: "wifi-1", title: wifiDoc.title, content: wifiDoc.content, vectorScore: 0.92 }],
      "Do you have wifi?",
      "en",
      2
    );
    expect(merged[0].id).toBe("wifi-1");
    expect(merged[0].vectorScore).toBeGreaterThan(0);
  });

  test("can surface a semantic-only match without keyword hits", () => {
    const merged = mergeHybridKbResults(
      [],
      [{
        id: "cards-1",
        title: "Do you accept credit cards",
        content: "Yes, Visa and Mastercard are accepted.",
        vectorScore: 0.88,
      }],
      "Can I pay with my card?",
      "en",
      1
    );
    expect(merged[0].id).toBe("cards-1");
    expect(merged[0].hybridScore).toBeGreaterThan(0.4);
  });

  test("boosts Albanian wifi queries toward the wifi doc", () => {
    const merged = mergeHybridKbResults(
      [wifiDoc],
      [{ id: "wifi-1", title: wifiDoc.title, content: wifiDoc.content, vectorScore: 0.8 }],
      "A keni wifi?",
      "sq",
      1
    );
    expect(merged[0].title).toMatch(/wi fi/i);
    expect(topicScoreForItem(wifiDoc, ["wifi", "wi", "fi"])).toBeGreaterThan(30);
  });
});
