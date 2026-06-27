import {
  coalesceDelayMs,
  isLikelyMessageFragment,
  resetInboundCoalescerForTests,
} from "../../src/services/inboundCoalescer.mjs";

describe("inboundCoalescer", () => {
  afterEach(() => {
    resetInboundCoalescerForTests();
    delete process.env.INBOUND_COALESCE;
    delete process.env.INBOUND_COALESCE_MS;
    delete process.env.INBOUND_COALESCE_FAST_MS;
  });

  test("isLikelyMessageFragment detects single-word bursts", () => {
    expect(isLikelyMessageFragment("doja")).toBe(true);
    expect(isLikelyMessageFragment("nje")).toBe(true);
    expect(isLikelyMessageFragment("rezervim")).toBe(true);
    expect(isLikelyMessageFragment("okej dua te bej nje")).toBe(true);
    expect(isLikelyMessageFragment("dua te bej nje rezervim per neser")).toBe(false);
  });

  test("coalesceDelayMs uses longer wait for fragments", () => {
    process.env.INBOUND_COALESCE_MS = "2500";
    process.env.INBOUND_COALESCE_FAST_MS = "600";
    expect(coalesceDelayMs("doja")).toBe(2500);
    expect(coalesceDelayMs("dua te bej nje rezervim per neser")).toBe(600);
  });

  test("coalesceDelayMs returns 0 when disabled", () => {
    process.env.INBOUND_COALESCE = "0";
    expect(coalesceDelayMs("doja")).toBe(0);
  });
});
