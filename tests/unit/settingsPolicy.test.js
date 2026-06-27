import { describe, expect, test } from "@jest/globals";
import { enforceSettingsPolicy } from "../../src/services/settingsPolicy.mjs";

describe("enforceSettingsPolicy", () => {
  test("strips gated fields for free plan", () => {
    const { filtered, deniedFields } = enforceSettingsPolicy({
      bookings_enabled: true,
      wa_template_name: "appointment_reminder",
      name: "Acme"
    }, { planName: "free" });

    expect(filtered.name).toBe("Acme");
    expect(filtered.bookings_enabled).toBeUndefined();
    expect(filtered.wa_template_name).toBeUndefined();
    expect(deniedFields).toEqual(expect.arrayContaining(["bookings_enabled", "wa_template_name"]));
  });

  test("keeps fields for upgraded plan", () => {
    const { filtered, deniedFields } = enforceSettingsPolicy({
      bookings_enabled: true,
      wa_template_name: "appointment_reminder"
    }, { planName: "pro" });

    expect(filtered.bookings_enabled).toBe(true);
    expect(filtered.wa_template_name).toBe("appointment_reminder");
    expect(deniedFields).toHaveLength(0);
  });
});
