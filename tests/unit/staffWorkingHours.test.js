import { parseWorkingHoursFromFields } from "../../src/views/staffWorkingHours.mjs";

describe("parseWorkingHoursFromFields", () => {
  it("parses structured open days with one shift", () => {
    const json = parseWorkingHoursFromFields({
      hours_mon_open: "1",
      hours_mon_start: "09:00",
      hours_mon_end: "17:00",
      hours_tue_open: "1",
      hours_tue_start: "10:30",
      hours_tue_end: "18:00",
    });

    expect(JSON.parse(json)).toEqual({
      mon: ["09:00-17:00"],
      tue: ["10:30-18:00"],
    });
  });

  it("parses split shifts", () => {
    const json = parseWorkingHoursFromFields({
      hours_fri_open: "1",
      hours_fri_start: "09:00",
      hours_fri_end: "13:00",
      hours_fri_start_2: "18:00",
      hours_fri_end_2: "20:00",
    });

    expect(JSON.parse(json)).toEqual({
      fri: ["09:00-13:00", "18:00-20:00"],
    });
  });

  it("ignores closed days and still supports legacy text", () => {
    const json = parseWorkingHoursFromFields({
      hours_sat: "09:00-14:00, 18:00-20:00",
    });

    expect(JSON.parse(json)).toEqual({
      sat: ["09:00-14:00", "18:00-20:00"],
    });
  });
});
