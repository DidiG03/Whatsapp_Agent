import { describe, expect, test } from "@jest/globals";
import { enforceSettingsPolicy } from "../../src/services/settingsPolicy.mjs";

describe("enforceSettingsPolicy", () => {
  test("strips gated fields for free plan", () => {
    const { filtered, deniedFields } = enforceSettingsPolicy({
      bookings_enabled: true,
      smtp_host: "smtp.example.com",
      name: "Acme"
    }, { planName: "free" });

    expect(filtered.name).toBe("Acme");
    expect(filtered.bookings_enabled).toBeUndefined();
    expect(filtered.smtp_host).toBeUndefined();
    expect(deniedFields).toEqual(expect.arrayContaining(["bookings_enabled", "smtp_host"]));
  });

  test("keeps fields for upgraded plan", () => {
    const { filtered, deniedFields } = enforceSettingsPolicy({
      bookings_enabled: true,
      smtp_host: "smtp.example.com"
    }, { planName: "pro" });

    expect(filtered.bookings_enabled).toBe(true);
    expect(filtered.smtp_host).toBe("smtp.example.com");
    expect(deniedFields).toHaveLength(0);
  });
});

