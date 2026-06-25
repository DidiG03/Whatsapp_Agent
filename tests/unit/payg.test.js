import { describe, test, expect, jest, beforeEach } from "@jest/globals";

const mockChargePayAsYouGo = jest.fn(async () => ({ charged: true, payment_intent_id: "pi_test" }));

jest.mock("../../src/schemas/mongodb.mjs", () => {
  const mockUsageStore = new Map();
  const mockPlanStore = new Map();
  const mockMonthKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  };
  const mockLeanDoc = (row) => ({
    lean: jest.fn(async () => row),
  });
  return {
    __mockUsageStore: mockUsageStore,
    __mockPlanStore: mockPlanStore,
    UsageStats: {
      findOne: jest.fn((query) => {
        const month = query.month_year || mockMonthKey();
        const key = `${query.user_id}:${month}`;
        const row = mockUsageStore.get(key);
        return mockLeanDoc(row || null);
      }),
      create: jest.fn(async (doc) => {
        const key = `${doc.user_id}:${doc.month_year}`;
        const row = { ...doc };
        mockUsageStore.set(key, row);
        return row;
      }),
      updateOne: jest.fn(async (query, update, opts = {}) => {
        const month = query.month_year || mockMonthKey();
        const key = `${query.user_id}:${month}`;
        let row = mockUsageStore.get(key);
        if (!row && opts.upsert) {
          row = {
            user_id: query.user_id,
            month_year: month,
            inbound_messages: 0,
            outbound_messages: 0,
            template_messages: 0,
            payg_charged_units: 0,
            payg_charged_cents: 0,
          };
        }
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        if (query.payg_charged_units?.$lt != null && row.payg_charged_units >= query.payg_charged_units.$lt) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (update.$inc) {
          for (const [field, delta] of Object.entries(update.$inc)) {
            row[field] = Number(row[field] || 0) + Number(delta);
          }
        }
        mockUsageStore.set(key, row);
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    },
    UserPlan: {
      findOne: jest.fn((query) => {
        const row = mockPlanStore.get(query.user_id);
        return mockLeanDoc(row || null);
      }),
      create: jest.fn(async (doc) => ({
        toObject: () => ({ ...doc }),
        ...doc,
      })),
      findOneAndUpdate: jest.fn(async () => null),
    },
  };
});

jest.mock("../../src/services/stripe.mjs", () => ({
  chargePayAsYouGo: (...args) => mockChargePayAsYouGo(...args),
}));

import {
  incrementUsage,
  isUsageExceeded,
  getCurrentMonthPaygOutstanding,
  settleOutstandingPaygCharges,
  hasPaygBillingHold,
} from "../../src/services/usage.mjs";
import * as mongo from "../../src/schemas/mongodb.mjs";

const usageStore = mongo.__mockUsageStore;
const planStore = mongo.__mockPlanStore;

function monthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

describe("pay-as-you-go usage", () => {
  const userId = "user-payg-test";
  const month = monthKey();

  beforeEach(() => {
    usageStore.clear();
    planStore.clear();
    mockChargePayAsYouGo.mockClear();
    mockChargePayAsYouGo.mockResolvedValue({ charged: true, payment_intent_id: "pi_test" });
    planStore.set(userId, {
      user_id: userId,
      plan_name: "starter",
      monthly_limit: 1000,
      payg_enabled: false,
      payg_rate_cents: 5,
      payg_currency: "usd",
    });
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 0,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
  });

  test("isUsageExceeded is false when payg is enabled even above limit", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1200,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 200,
      payg_charged_cents: 1000,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    await expect(isUsageExceeded(userId)).resolves.toBe(false);
  });

  test("isUsageExceeded blocks when payg is enabled but overage is unpaid", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1003,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 1,
      payg_charged_cents: 5,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    await expect(isUsageExceeded(userId)).resolves.toBe(true);
    await expect(hasPaygBillingHold(userId)).resolves.toBe(true);
  });

  test("isUsageExceeded blocks at monthly limit when payg is disabled", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1000,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
    await expect(isUsageExceeded(userId)).resolves.toBe(true);
  });

  test("does not charge while still within included messages", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 999,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    await incrementUsage(userId, "inbound_messages");
    expect(mockChargePayAsYouGo).not.toHaveBeenCalled();
  });

  test("charges one unit for the first message over the limit", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1000,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    await incrementUsage(userId, "inbound_messages");
    expect(mockChargePayAsYouGo).toHaveBeenCalledTimes(1);
    expect(mockChargePayAsYouGo).toHaveBeenCalledWith(
      userId,
      1,
      expect.objectContaining({ idempotencyKey: `payg_${userId}_${month}_unit_1` })
    );
    const usage = usageStore.get(`${userId}:${month}`);
    expect(usage.payg_charged_units).toBe(1);
    expect(usage.payg_charged_cents).toBe(5);
  });

  test("tracks outstanding charges when stripe charge fails", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1002,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    mockChargePayAsYouGo.mockResolvedValue({ charged: false, reason: "payment_failed" });
    await incrementUsage(userId, "inbound_messages");
    const outstanding = await getCurrentMonthPaygOutstanding(userId);
    expect(outstanding.overageUnits).toBe(3);
    expect(outstanding.chargedUnits).toBe(0);
    expect(outstanding.outstandingUnits).toBe(3);
    expect(outstanding.outstandingCents).toBe(15);
  });

  test("settleOutstandingPaygCharges clears unpaid units", async () => {
    usageStore.set(`${userId}:${month}`, {
      user_id: userId,
      month_year: month,
      inbound_messages: 1003,
      outbound_messages: 0,
      template_messages: 0,
      payg_charged_units: 0,
      payg_charged_cents: 0,
    });
    planStore.set(userId, { ...planStore.get(userId), payg_enabled: true });
    const result = await settleOutstandingPaygCharges(userId);
    expect(result.success).toBe(true);
    expect(result.chargedUnits).toBe(3);
    expect(result.remainingUnits).toBe(0);
    expect(mockChargePayAsYouGo).toHaveBeenCalledTimes(3);
  });
});
