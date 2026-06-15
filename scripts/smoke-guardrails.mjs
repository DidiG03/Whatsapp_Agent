#!/usr/bin/env node
import { parseDateRange, parseTimeOfDayFilter, parseDateOnly, parseDayOfMonthFromText } from "../src/routes/webhook.mjs";
import { filterSlotsByTimeOfDay } from "../src/services/booking.mjs";

const cases = [
  { text: "nesër në dark", expectDate: true, expectTod: { startHour: 17, endHour: 23 } },
  { text: "tomorrow evening", expectDate: true, expectTod: { startHour: 17, endHour: 23 } },
  { text: "neser ne mengjes", expectDate: true, expectTod: { startHour: 6, endHour: 12 } },
  { text: "tomorrow at 3 pm", expectDate: true, expectTod: null },
  { text: "besoj nga data 16 ora 8 e darkes", expectDaySuffix: "-16" },
];

let failed = 0;
for (const c of cases) {
  if (c.expectDaySuffix) {
    const day = parseDayOfMonthFromText(c.text) || parseDateOnly(c.text);
    const okDay = day && String(day).endsWith(c.expectDaySuffix);
    if (!okDay) {
      failed++;
      console.error("FAIL", c.text, { day, expect: c.expectDaySuffix });
    } else {
      console.log("OK", c.text, "→", day);
    }
    continue;
  }
  const range = parseDateRange(c.text);
  const tod = parseTimeOfDayFilter(c.text);
  const okDate = c.expectDate ? !!range?.startISO : !range;
  const okTod =
    !c.expectTod ||
    (tod?.startHour === c.expectTod.startHour && tod?.endHour === c.expectTod.endHour);
  if (!okDate || !okTod) {
    failed++;
    console.error("FAIL", c.text, { range, tod });
  } else {
    console.log("OK", c.text, "→", range?.startISO, tod ? `${tod.startHour}-${tod.endHour}` : "any");
  }
}

const evening = { startHour: 17, endHour: 23 };
const slots = [
  { start: "2026-06-15T08:00:00.000Z", end: "2026-06-15T08:30:00.000Z" },
  { start: "2026-06-15T18:00:00.000Z", end: "2026-06-15T18:30:00.000Z" },
  { start: "2026-06-15T20:00:00.000Z", end: "2026-06-15T20:30:00.000Z" },
];
const filtered = filterSlotsByTimeOfDay(slots, evening, "Europe/Tirane");
if (filtered.length !== 2) {
  failed++;
  console.error("FAIL evening filter", filtered.length);
} else {
  console.log("OK evening slot filter →", filtered.length, "slots");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll guardrail smoke checks passed.");
