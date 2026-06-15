import { describe, expect, test, jest, beforeEach } from "@jest/globals";

jest.mock("../../src/services/settings.mjs", () => ({
  getSettingsForUser: jest.fn(),
}));

jest.mock("../../src/services/whatsapp.mjs", () => ({
  sendWhatsAppGroupText: jest.fn(),
}));

import {
  isStaffGroupConnectCommand,
  buildStaffBookingAlertMessage,
  sendStaffGroupBookingNotification,
} from "../../src/services/staffGroupNotifications.mjs";
import { getSettingsForUser } from "../../src/services/settings.mjs";
import { sendWhatsAppGroupText } from "../../src/services/whatsapp.mjs";

describe("isStaffGroupConnectCommand", () => {
  test("recognizes CONNECT command case-insensitively", () => {
    expect(isStaffGroupConnectCommand("CONNECT")).toBe(true);
    expect(isStaffGroupConnectCommand(" connect ")).toBe(true);
    expect(isStaffGroupConnectCommand("Connect")).toBe(true);
    expect(isStaffGroupConnectCommand("hello")).toBe(false);
    expect(isStaffGroupConnectCommand("connect staff")).toBe(false);
  });
});

describe("buildStaffBookingAlertMessage", () => {
  test("includes booking details", () => {
    const msg = buildStaffBookingAlertMessage(
      {
        customerName: "Jane Doe",
        customerPhone: "+15551234567",
        startTime: "2026-06-14T17:00:00.000Z",
        endTime: "2026-06-14T18:00:00.000Z",
        appointmentId: 42,
        staffName: "Alex",
        notes: "Window seat",
      },
      { business_name: "Harbor Cafe" }
    );
    expect(msg).toContain("Harbor Cafe");
    expect(msg).toContain("#42");
    expect(msg).toContain("Jane Doe");
    expect(msg).toContain("+15551234567");
    expect(msg).toContain("Alex");
    expect(msg).toContain("Window seat");
  });
});

describe("sendStaffGroupBookingNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("skips send when staff group alerts are disabled", async () => {
    getSettingsForUser.mockResolvedValue({
      staff_whatsapp_group_enabled: false,
      staff_whatsapp_group_id: "group-123",
      whatsapp_token: "token",
      phone_number_id: "phone-id",
    });

    const result = await sendStaffGroupBookingNotification("user-1", {
      customerName: "Jane",
      customerPhone: "+1",
      startTime: "2026-06-14T17:00:00.000Z",
      endTime: "2026-06-14T18:00:00.000Z",
      appointmentId: 1,
    });

    expect(result).toEqual({ success: false, reason: "disabled" });
    expect(sendWhatsAppGroupText).not.toHaveBeenCalled();
  });

  test("sends group alert when enabled and configured", async () => {
    getSettingsForUser.mockResolvedValue({
      staff_whatsapp_group_enabled: true,
      staff_whatsapp_group_id: "group-abc",
      whatsapp_token: "token",
      phone_number_id: "phone-id",
      business_name: "Harbor Cafe",
    });
    sendWhatsAppGroupText.mockResolvedValue({ messages: [{ id: "wamid.1" }] });

    const result = await sendStaffGroupBookingNotification("user-1", {
      customerName: "Jane",
      customerPhone: "+1",
      startTime: "2026-06-14T17:00:00.000Z",
      endTime: "2026-06-14T18:00:00.000Z",
      appointmentId: 7,
    });

    expect(result).toEqual({ success: true });
    expect(sendWhatsAppGroupText).toHaveBeenCalledWith(
      "group-abc",
      expect.stringContaining("#7"),
      expect.objectContaining({ user_id: "user-1" })
    );
  });
});
