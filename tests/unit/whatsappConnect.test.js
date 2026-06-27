import { describe, expect, test } from "@jest/globals";
import { buildConnectionStatus } from "../../src/services/whatsappConnect.mjs";

describe("buildConnectionStatus", () => {
  test("reports connected when token and phone id exist", () => {
    const status = buildConnectionStatus({
      whatsapp_token: "token",
      phone_number_id: "123",
      waba_id: "waba",
      business_phone: "15551234567",
      verify_token: "verify",
    });
    expect(status.connected).toBe(true);
    expect(status.phoneNumberId).toBe("123");
    expect(status.wabaId).toBe("waba");
  });

  test("reports disconnected without token", () => {
    const status = buildConnectionStatus({ phone_number_id: "123" });
    expect(status.connected).toBe(false);
  });
});
