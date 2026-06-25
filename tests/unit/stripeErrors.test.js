import { describe, test, expect } from "@jest/globals";
import { formatStripeApiError, stripeErrorHttpStatus, isStripeResourceMissingError } from "../../src/services/stripe.mjs";

describe("formatStripeApiError", () => {
  test("maps expired API key to actionable message", () => {
    const msg = formatStripeApiError({
      type: "StripeAuthenticationError",
      code: "api_key_expired",
      raw: { message: "Expired API Key provided: sk_live_xxx" },
    });
    expect(msg).toMatch(/expired/i);
    expect(msg).toMatch(/STRIPE_SECRET_KEY/i);
  });

  test("maps resource_missing customer to stale customer message", () => {
    const msg = formatStripeApiError({
      code: "resource_missing",
      raw: { message: "No such customer: 'cus_test'" },
    });
    expect(msg).toMatch(/customer was not found/i);
    expect(msg).toMatch(/test and live/i);
  });

  test("maps resource_missing subscription to stale message", () => {
    const msg = formatStripeApiError({
      code: "resource_missing",
      raw: { message: "No such subscription: 'sub_test'" },
    });
    expect(msg).toMatch(/not found in Stripe/i);
    expect(msg).toMatch(/reset to Free/i);
  });

  test("isStripeResourceMissingError detects no such subscription", () => {
    expect(
      isStripeResourceMissingError({
        code: "resource_missing",
        raw: { message: "No such subscription: 'sub_123'" },
      })
    ).toBe(true);
  });
});
