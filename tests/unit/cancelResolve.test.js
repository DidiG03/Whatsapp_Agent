import { describe, expect, test } from "@jest/globals";
import {
  isRecentBookingCancelRequest,
  isRecentOrTargetedBookingRequest,
  extractExistingBookingTimeHint,
  parseAppointmentRefFromText,
  matchAppointmentByWallClock,
  pickMostRecentlyBooked,
  findAppointmentByRef,
} from "../../src/services/cancelResolve.mjs";

describe("cancelResolve", () => {
  test("isRecentBookingCancelRequest detects just made phrasing", () => {
    expect(isRecentBookingCancelRequest("can i cancel the booking I just made")).toBe(true);
    expect(isRecentBookingCancelRequest("cancel my appointment")).toBe(false);
  });

  test("isRecentOrTargetedBookingRequest detects modify phrasing", () => {
    expect(isRecentOrTargetedBookingRequest("reschedule the booking I just made to 10pm")).toBe(true);
    expect(isRecentOrTargetedBookingRequest("change my appointment")).toBe(false);
  });

  test("extractExistingBookingTimeHint reads current time before 'to'", () => {
    expect(extractExistingBookingTimeHint("change my 9:30 booking to 10pm")).toBe("9:30");
    expect(extractExistingBookingTimeHint("reschedule to 10pm")).toBe(null);
  });

  test("parseAppointmentRefFromText extracts ref numbers", () => {
    expect(parseAppointmentRefFromText("cancel ref #1782341852")).toBe("1782341852");
    expect(parseAppointmentRefFromText("no ref here")).toBe(null);
  });

  test("matchAppointmentByWallClock matches hour and minute", () => {
    const tz = "UTC";
    const appts = [
      { id: 100, start_ts: Math.floor(new Date("2026-06-25T20:00:00Z").getTime() / 1000) },
      { id: 200, start_ts: Math.floor(new Date("2026-06-25T21:30:00Z").getTime() / 1000) },
    ];
    const matched = matchAppointmentByWallClock(
      appts,
      { dateISO: "2026-06-25", hour: 21, minute: 30 },
      tz
    );
    expect(matched?.id).toBe(200);
  });

  test("pickMostRecentlyBooked prefers higher legacy id", () => {
    const appts = [{ id: 100 }, { id: 200 }];
    expect(pickMostRecentlyBooked(appts)?.id).toBe(200);
  });

  test("findAppointmentByRef finds by id", () => {
    const appts = [{ id: 1782341852 }, { id: 1782330297 }];
    expect(findAppointmentByRef(appts, "1782341852")?.id).toBe(1782341852);
  });
});
