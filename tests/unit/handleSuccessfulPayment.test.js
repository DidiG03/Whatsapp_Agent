import { describe, test, expect, jest, beforeEach } from "@jest/globals";

const mockUpdateUserPlan = jest.fn(async () => ({}));
const mockSendPaymentReceiptEmail = jest.fn(async () => true);

jest.mock("../../src/services/usage.mjs", () => ({
  updateUserPlan: (...args) => mockUpdateUserPlan(...args),
  getPlanPricing: () => ({
    starter: {
      name: "Starter",
      price: 14,
      monthly_limit: 1000,
      whatsapp_numbers: 1,
    },
  }),
}));

jest.mock("../../src/services/email.mjs", () => ({
  sendPaymentReceiptEmail: (...args) => mockSendPaymentReceiptEmail(...args),
}));

jest.mock("../../src/db-mongodb.mjs", () => {
  const mockCheckoutSessions = new Map();
  return {
    __mockCheckoutSessions: mockCheckoutSessions,
    getDB: () => ({
      collection: () => ({
        findOneAndUpdate: jest.fn(async (query, update, opts) => {
          const sessionId = String(query.session_id);
          const existing = mockCheckoutSessions.get(sessionId) || null;
          if (!existing && opts?.upsert) {
            mockCheckoutSessions.set(sessionId, {
              session_id: sessionId,
              user_id: update.$setOnInsert.user_id,
            });
          }
          return existing;
        }),
      }),
    }),
  };
});

import { handleSuccessfulPayment } from "../../src/services/stripe.mjs";
import * as mongoDb from "../../src/db-mongodb.mjs";

const mockCheckoutSessions = mongoDb.__mockCheckoutSessions;

describe("handleSuccessfulPayment", () => {
  const session = {
    id: "cs_test_abc",
    metadata: { user_id: "user-1", plan_name: "starter" },
    subscription: "sub_test",
    customer: "cus_test",
    amount_total: 2900,
    currency: "usd",
  };

  beforeEach(() => {
    mockCheckoutSessions.clear();
    mockUpdateUserPlan.mockClear();
    mockSendPaymentReceiptEmail.mockClear();
  });

  test("awaits plan update and sends receipt on first processing", async () => {
    const result = await handleSuccessfulPayment(session);
    expect(result).toEqual({ ok: true, alreadyProcessed: false });
    expect(mockUpdateUserPlan).toHaveBeenCalledTimes(1);
    expect(mockUpdateUserPlan).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        plan_name: "starter",
        status: "active",
        stripe_subscription_id: "sub_test",
        stripe_customer_id: "cus_test",
      })
    );
    expect(mockSendPaymentReceiptEmail).toHaveBeenCalledTimes(1);
  });

  test("is idempotent for duplicate webhook and success redirect", async () => {
    const first = await handleSuccessfulPayment(session);
    const second = await handleSuccessfulPayment(session);
    expect(first.alreadyProcessed).toBe(false);
    expect(second).toEqual({ ok: true, alreadyProcessed: true });
    expect(mockUpdateUserPlan).toHaveBeenCalledTimes(1);
    expect(mockSendPaymentReceiptEmail).toHaveBeenCalledTimes(1);
  });
});
