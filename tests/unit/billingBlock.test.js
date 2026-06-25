import { describe, test, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../../src/schemas/mongodb.mjs", () => {
  const mockPlanStore = new Map();
  const mockLeanDoc = (row) => ({
    lean: jest.fn(async () => row),
  });
  return {
    __mockPlanStore: mockPlanStore,
    UsageStats: {
      findOne: jest.fn(() => mockLeanDoc(null)),
      create: jest.fn(),
      updateOne: jest.fn(),
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
      findOneAndUpdate: jest.fn(),
    },
  };
});

import {
  isSubscriptionBillingBlocked,
  isUsageExceeded,
  getMessagingBlockReason,
  getMessagingBlockMessage,
  getMessagingBlockNoticeI18nKey,
  shouldNotifyCustomerMessagingBlocked,
} from "../../src/services/usage.mjs";
import * as mongo from "../../src/schemas/mongodb.mjs";

const planStore = mongo.__mockPlanStore;

const mockContactState = new Map();

jest.mock("../../src/db-mongodb.mjs", () => ({
  getDB: () => ({
    collection: () => ({
      findOne: jest.fn(async (query) => {
        const key = `${query.user_id}:${query.contact_id}`;
        return mockContactState.get(key) || null;
      }),
      updateOne: jest.fn(async (query, update) => {
        const key = `${query.user_id}:${query.contact_id}`;
        const prev = mockContactState.get(key) || {};
        mockContactState.set(key, {
          ...prev,
          ...update.$set,
        });
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    }),
  }),
}));

describe("subscription billing block", () => {
  const userId = "user_billing_block";

  beforeEach(() => {
    planStore.clear();
    mockContactState.clear();
  });

  test("isSubscriptionBillingBlocked is true for past_due and unpaid", () => {
    expect(isSubscriptionBillingBlocked({ status: "past_due" })).toBe(true);
    expect(isSubscriptionBillingBlocked({ status: "unpaid" })).toBe(true);
    expect(isSubscriptionBillingBlocked({ status: "active" })).toBe(false);
    expect(isSubscriptionBillingBlocked({ status: undefined })).toBe(false);
  });

  test("isUsageExceeded returns true when subscription is past_due even under message limit", async () => {
    planStore.set(userId, {
      user_id: userId,
      plan_name: "starter",
      status: "past_due",
      monthly_limit: 1000,
      payg_enabled: false,
    });
    expect(await isUsageExceeded(userId)).toBe(true);
  });

  test("getMessagingBlockReason returns subscription_payment for past_due", async () => {
    planStore.set(userId, {
      user_id: userId,
      plan_name: "starter",
      status: "past_due",
      monthly_limit: 1000,
      payg_enabled: false,
    });
    expect(await getMessagingBlockReason(userId)).toBe("subscription_payment");
    const message = await getMessagingBlockMessage(userId);
    expect(message).toMatch(/subscription payment failed/i);
  });

  test("getMessagingBlockNoticeI18nKey maps block reasons to customer notice keys", () => {
    expect(getMessagingBlockNoticeI18nKey("subscription_payment")).toBe(
      "messaging_unavailable_subscription"
    );
    expect(getMessagingBlockNoticeI18nKey("usage_limit")).toBe("messaging_unavailable_limit");
  });

  test("shouldNotifyCustomerMessagingBlocked throttles repeat notices per contact", async () => {
    const contactId = "355691234567";
    expect(await shouldNotifyCustomerMessagingBlocked(userId, contactId)).toBe(true);
    expect(await shouldNotifyCustomerMessagingBlocked(userId, contactId)).toBe(false);
  });
});
