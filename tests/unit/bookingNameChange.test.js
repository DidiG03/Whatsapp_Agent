import { describe, expect, test } from "@jest/globals";
import {
  isBookingNameChangeRequest,
  parseBookingNameChange,
} from "../../src/services/agent-intelligence.mjs";
import {
  parseNameFromAppointmentNotes,
  rebuildNotesWithName,
} from "../../src/services/booking.mjs";

describe("parseBookingNameChange", () => {
  test("parses Albanian from-to name change", () => {
    const result = parseBookingNameChange(
      "a mund ta ndryshoni emrin nga sefrid kapllani ne klajd bisha?"
    );
    expect(result?.oldName).toBe("Sefrid Kapllani");
    expect(result?.newName).toBe("Klajd Bisha");
  });

  test("parses English change name to", () => {
    const result = parseBookingNameChange("Can you change the name to Jane Doe?");
    expect(result?.newName).toBe("Jane Doe");
  });

  test("returns null for unrelated messages", () => {
    expect(parseBookingNameChange("What time is my booking?")).toBeNull();
  });
});

describe("isBookingNameChangeRequest", () => {
  test("detects Albanian rename request", () => {
    expect(isBookingNameChangeRequest("a mund ta ndryshoni emrin nga ana ne ben?")).toBe(true);
  });

  test("does not treat time change as name change", () => {
    expect(isBookingNameChangeRequest("a mund ta ndryshoj rezervimin ne oren 9?")).toBe(false);
  });
});

describe("appointment notes name helpers", () => {
  test("reads and rewrites Name field in notes", () => {
    const notes = "Name: Sefrid Kapllani | Party size: 4";
    expect(parseNameFromAppointmentNotes(notes)).toBe("Sefrid Kapllani");
    expect(rebuildNotesWithName(notes, "Klajd Bisha")).toBe("Name: Klajd Bisha | Party size: 4");
  });
});
