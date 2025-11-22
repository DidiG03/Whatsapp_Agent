import { describe, expect, test } from "@jest/globals";
import { validateSettingsPayload } from "../../src/validators/settingsPayload.mjs";

describe("validateSettingsPayload", () => {
  test("accepts minimal valid payload", () => {
    const result = validateSettingsPayload({
      name: "Acme Inc",
      conversation_mode: "full",
      reminder_windows: ["2h"],
      escalation_questions_json: "What is your name?\nHow can we help?",
      closed_dates_json: '["2025-12-25"]'
    });

    expect(result.success).toBe(true);
    expect(result.data.name).toBe("Acme Inc");
    expect(result.data.reminder_windows).toBe(JSON.stringify(["2h"]));
    expect(result.data.escalation_questions_json).toBe(JSON.stringify(["What is your name?", "How can we help?"]));
  });

  test("rejects invalid phone numbers", () => {
    const result = validateSettingsPayload({
      phone_number_id: "invalid",
      conversation_mode: "full",
      closed_dates_json: "[]"
    });

    expect(result.success).toBe(false);
  });
});

