import { describe, expect, test } from "@jest/globals";
import { mergeHolidaysForDisplay, parseClosedDatesFromHolidays } from "../../src/views/holidayClosures.mjs";
import { validateSettingsPayload } from "../../src/validators/settingsPayload.mjs";

describe("holiday closures", () => {
  test("mergeHolidaysForDisplay includes legacy closed dates as full-day rows", () => {
    const rows = mergeHolidaysForDisplay(
      '[{"name":"Half day","date":"2025-12-24","start":"13:00","end":"17:00"}]',
      '["2025-12-25"]'
    );

    expect(rows).toEqual([
      { name: "Half day", date: "2025-12-24", start: "13:00", end: "17:00", fullDay: false },
      { name: "", date: "2025-12-25", start: "00:00", end: "23:59", fullDay: true },
    ]);
  });

  test("parseClosedDatesFromHolidays reads full-day checkbox rows", () => {
    expect(parseClosedDatesFromHolidays({
      holiday_date: ["2025-12-25", "2025-12-24"],
      holiday_full_day: ["1", "0"],
    })).toEqual(["2025-12-25"]);
  });

  test("validateSettingsPayload stores full-day closures from holiday rows", () => {
    const result = validateSettingsPayload({
      conversation_mode: "full",
      holiday_name: ["Christmas"],
      holiday_date: ["2025-12-25"],
      holiday_full_day: ["1"],
      holiday_start: ["00:00"],
      holiday_end: ["23:59"],
    });

    expect(result.success).toBe(true);
    expect(result.data.closed_dates_json).toBe(JSON.stringify(["2025-12-25"]));
    expect(result.data.holidays_rules_json).toBe(JSON.stringify([
      { name: "Christmas", date: "2025-12-25", start: "00:00", end: "23:59" },
    ]));
  });
});
