import { describe, test, expect } from "@jest/globals";
import { allowDirectPlanChange } from "../../src/services/planPolicy.mjs";

describe("allowDirectPlanChange", () => {
  test("always allows downgrade to free", () => {
    expect(allowDirectPlanChange("free", { stripeEnabled: true })).toBe(true);
    expect(allowDirectPlanChange("free", { stripeEnabled: false })).toBe(true);
  });

  test("blocks starter upgrade when Stripe is enabled", () => {
    expect(allowDirectPlanChange("starter", { stripeEnabled: true, allowUnpaidUpgrades: true })).toBe(false);
  });

  test("blocks starter upgrade without Stripe unless dev flag is set", () => {
    expect(allowDirectPlanChange("starter", { stripeEnabled: false, allowUnpaidUpgrades: false })).toBe(false);
    expect(allowDirectPlanChange("starter", { stripeEnabled: false, allowUnpaidUpgrades: true })).toBe(true);
  });

  test("rejects unknown plans", () => {
    expect(allowDirectPlanChange("pro", { stripeEnabled: false, allowUnpaidUpgrades: true })).toBe(false);
  });
});
