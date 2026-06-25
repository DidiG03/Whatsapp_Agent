import { describe, expect, test } from "@jest/globals";
import { disambiguateBookingHour, isAdditionalBookingConfirm } from "../../src/services/bookingTime.mjs";

describe("bookingTime", () => {
  test("disambiguateBookingHour treats bare 5 as PM for reservations", () => {
    expect(disambiguateBookingHour(5, "tomorrow at 5")).toBe(17);
    expect(disambiguateBookingHour(8, "tomorrow at 8")).toBe(20);
  });

  test("disambiguateBookingHour respects explicit am", () => {
    expect(disambiguateBookingHour(9, "tomorrow at 9 am")).toBe(9);
  });

  test("disambiguateBookingHour respects explicit pm", () => {
    expect(disambiguateBookingHour(5, "tomorrow at 5 pm")).toBe(17);
  });

  test("isAdditionalBookingConfirm detects yes replies", () => {
    expect(isAdditionalBookingConfirm("yes please")).toBe(true);
    expect(isAdditionalBookingConfirm("po")).toBe(true);
    expect(isAdditionalBookingConfirm("no thanks")).toBe(false);
  });
});
