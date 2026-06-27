import { describe, expect, test } from "@jest/globals";
import {
  normalizeTemporal,
  parseRequestedDateTime,
  parseDateOnly,
  findBookingDatetimeInHistory,
  resolveBookDatetime,
} from "../../src/routes/webhook.mjs";

function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

describe("booking datetime parsing (Albanian 'sonte' / split date+time)", () => {
  test("normalizeTemporal maps 'sonte' (tonight) to today + evening", () => {
    const out = normalizeTemporal("a ka vende te lira per sonte ne dark?");
    expect(out).toMatch(/\btoday\b/);
    expect(out).toMatch(/\bevening\b/);
  });

  test("parseRequestedDateTime resolves 'sonte ne ora 8' to today 20:00", () => {
    const parsed = parseRequestedDateTime("sonte ne ora 8");
    expect(parsed).not.toBeNull();
    expect(parsed.dateISO).toBe(todayISO());
    expect(parsed.hour).toBe(20);
  });

  test("merges a date and a time stated in separate messages", () => {
    const history = [
      { role: "user", content: "a ka vende te lira per sonte ne dark?" },
      { role: "assistant", content: "Për sonte në darkë, patjetër. Cila orë?" },
      { role: "user", content: "ora 8" },
      { role: "assistant", content: "Në rregull, për sonte në orën 20:00. Sa persona?" },
    ];
    const merged = findBookingDatetimeInHistory(history, "4 persona");
    expect(merged).not.toBeNull();
    expect(merged.dateISO).toBe(todayISO());
    expect(merged.hour).toBe(20);
  });

  test("resolveBookDatetime completes the booking from the party-size reply", () => {
    const history = [
      { role: "user", content: "a ka vende te lira per sonte ne dark?" },
      { role: "user", content: "ora 8" },
    ];
    const resolved = resolveBookDatetime("4 persona", history, {});
    expect(resolved).not.toBeNull();
    expect(resolved.dateISO).toBe(todayISO());
    expect(resolved.hour).toBe(20);
  });

  test("'today' uses the business timezone, not the server's UTC clock", () => {
    // Anchor "now" to 23:30 UTC, which is already the next calendar day in any
    // east-of-UTC timezone. Without timezone awareness, "today" resolves to the
    // UTC date and a "tonight" booking lands in the past.
    const fixed = new Date("2026-06-25T23:30:00.000Z");
    const RealDate = Date;
    // eslint-disable-next-line no-global-assign
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(fixed.getTime());
        return new RealDate(...args);
      }
      static now() {
        return fixed.getTime();
      }
    };
    try {
      // UTC sees Jun 25.
      expect(parseDateOnly("sonte")).toBe("2026-06-25");
      // A timezone two hours ahead of UTC has already rolled over to Jun 26.
      expect(parseDateOnly("sonte", "Europe/Athens")).toBe("2026-06-26");
      const parsed = parseRequestedDateTime("sonte ora 8", "Europe/Athens");
      expect(parsed.dateISO).toBe("2026-06-26");
      expect(parsed.hour).toBe(20);
    } finally {
      // eslint-disable-next-line no-global-assign
      global.Date = RealDate;
    }
  });
});
