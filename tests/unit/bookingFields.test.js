import { describe, expect, test } from "@jest/globals";
import {
  getBookingFieldsFromSettings,
  inferDefaultFieldsFromBusinessType,
  applyBookingFieldDirectives,
  resolveBookingFieldValues,
  bookingFieldsReady,
  formatBookingNotesFromValues,
  fieldsIncludeType,
  buildBookingFieldsPromptBlock,
} from "../../src/services/bookingFields.mjs";

describe("bookingFields", () => {
  test("restaurant default includes party size", () => {
    const config = inferDefaultFieldsFromBusinessType("Restaurant / Food");
    expect(fieldsIncludeType(config.fields, "party_size")).toBe(true);
    expect(fieldsIncludeType(config.fields, "name")).toBe(true);
  });

  test("clinic default is appointment profile without party size", () => {
    const config = inferDefaultFieldsFromBusinessType("Health / Wellness");
    expect(fieldsIncludeType(config.fields, "party_size")).toBe(false);
    expect(fieldsIncludeType(config.fields, "name")).toBe(true);
  });

  test("applyBookingFieldDirectives sets appointment profile and adds email", () => {
    const json = applyBookingFieldDirectives(null, {
      profile: "appointment",
      addFields: [{ id: "email", type: "email", prompt: "What's your email?", required: true }],
    });
    const config = getBookingFieldsFromSettings({ booking_fields_json: json });
    expect(fieldsIncludeType(config.fields, "party_size")).toBe(false);
    expect(fieldsIncludeType(config.fields, "email")).toBe(true);
  });

  test("bookingFieldsReady blocks without required email", () => {
    const fields = [
      { id: "name", type: "name", label: "Name", required: true },
      { id: "email", type: "email", label: "Email", required: true },
    ];
    const values = { name: "Ana" };
    expect(bookingFieldsReady(values, fields).ready).toBe(false);
    expect(bookingFieldsReady({ name: "Ana", email: "a@b.com" }, fields).ready).toBe(true);
  });

  test("resolveBookingFieldValues extracts email from message", () => {
    const fields = [
      { id: "name", type: "name", label: "Name", required: true },
      { id: "email", type: "email", label: "Email", required: true },
    ];
    const values = resolveBookingFieldValues({
      fields,
      text: "my email is ana@clinic.com",
      historyMessages: [],
      intentData: { name: "Ana" },
    });
    expect(values.email).toBe("ana@clinic.com");
  });

  test("formatBookingNotesFromValues writes labeled notes for calendar", () => {
    const fields = [
      { id: "name", type: "name", label: "Name", required: true },
      { id: "reason", type: "text", label: "Reason for visit", required: true },
    ];
    const notes = formatBookingNotesFromValues(
      { name: "Ana", reason: "Toothache" },
      fields
    );
    expect(notes).toContain("Name: Ana");
    expect(notes).toContain("Reason for visit: Toothache");
  });

  test("buildBookingFieldsPromptBlock omits party size note for appointment profile", () => {
    const config = inferDefaultFieldsFromBusinessType("Health / Wellness");
    const block = buildBookingFieldsPromptBlock(config.fields, "en");
    expect(block).toContain("BOOKING FIELDS");
    expect(block).toContain("Do NOT ask how many people");
  });
});
