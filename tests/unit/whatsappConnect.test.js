import test from "node:test";
import assert from "node:assert/strict";
import { buildConnectionStatus } from "../../src/services/whatsappConnect.mjs";

test("buildConnectionStatus reports connected when token and phone id exist", () => {
  const status = buildConnectionStatus({
    whatsapp_token: "token",
    phone_number_id: "123",
    waba_id: "waba",
    business_phone: "15551234567",
    verify_token: "verify",
  });
  assert.equal(status.connected, true);
  assert.equal(status.phoneNumberId, "123");
  assert.equal(status.wabaId, "waba");
});

test("buildConnectionStatus reports disconnected without token", () => {
  const status = buildConnectionStatus({ phone_number_id: "123" });
  assert.equal(status.connected, false);
});
