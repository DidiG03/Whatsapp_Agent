import { describe, test, expect } from "@jest/globals";
import {
  sweepTtlMap,
  sweepExpiryTimestamps,
  trimMapSize,
} from "../../src/utils/ttlCache.mjs";

describe("ttlCache", () => {
  test("sweepTtlMap removes expired entries", () => {
    const map = new Map([
      ["a", { val: 1, expires: Date.now() - 1000 }],
      ["b", { val: 2, expires: Date.now() + 60_000 }],
    ]);
    const removed = sweepTtlMap(map);
    expect(removed).toBe(1);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
  });

  test("sweepExpiryTimestamps removes stale status nonces", () => {
    const map = new Map([
      ["old", Date.now() - 1000],
      ["new", Date.now() + 60_000],
    ]);
    sweepExpiryTimestamps(map);
    expect(map.has("old")).toBe(false);
    expect(map.has("new")).toBe(true);
  });

  test("trimMapSize caps map growth", () => {
    const map = new Map();
    for (let i = 0; i < 10; i++) map.set(`k${i}`, i);
    trimMapSize(map, 5);
    expect(map.size).toBe(5);
  });
});
