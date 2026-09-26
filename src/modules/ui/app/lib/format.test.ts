import { describe, expect, test } from "bun:test";
import { fmtAge, fmtClock, fmtCost, fmtDate, fmtDuration, fmtSize, fmtTokens, shortRunId } from "./format.js";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("fmtAge", () => {
  test("coarsens from minutes to hours to days", () => {
    expect(fmtAge("2026-01-10T11:30:00.000Z", NOW)).toBe("30m ago");
    expect(fmtAge("2026-01-10T06:00:00.000Z", NOW)).toBe("6h ago");
    expect(fmtAge("2026-01-05T12:00:00.000Z", NOW)).toBe("5d ago");
  });

  test("never shows a negative age for a clock ahead of ours", () => {
    expect(fmtAge("2026-01-10T12:05:00.000Z", NOW)).toBe("0m ago");
  });

  test("answers with a dash for an absent or unparsable date", () => {
    expect(fmtAge(undefined, NOW)).toBe("—");
    expect(fmtAge("", NOW)).toBe("—");
    expect(fmtAge("not a date", NOW)).toBe("—");
  });
});

describe("fmtCost", () => {
  test("shows two decimals, and marks an estimate", () => {
    expect(fmtCost({ usd: 1.5, estimated: false })).toBe("1.50 $");
    expect(fmtCost({ usd: 0.125, estimated: true })).toBe("0.13 $ ~");
  });

  test("answers with a dash when no attempt reported a cost", () => {
    expect(fmtCost({ estimated: false })).toBe("—");
    expect(fmtCost(null)).toBe("—");
  });

  test("marks an unpriceable spend as a lower bound, never as an exact figure", () => {
    // The case that matters: a run whose only spend could not be priced carries
    // a total of `0`. Printed bare it claims the run was free.
    expect(fmtCost({ usd: 0, estimated: false, unknown: true })).toBe("≥ 0.00 $");
    expect(fmtCost({ usd: 1.5, estimated: true, unknown: true })).toBe("≥ 1.50 $ ~");
    expect(fmtCost({ estimated: false, unknown: true })).toBe("≥ ? $");
  });
});

describe("fmtSize", () => {
  test("switches unit at each threshold", () => {
    expect(fmtSize(512)).toBe("512 o");
    expect(fmtSize(2048)).toBe("2.0 Ko");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3.0 Mo");
  });

  test("shows nothing for a size the API did not send", () => {
    expect(fmtSize(undefined)).toBe("");
  });
});

describe("fmtDate", () => {
  test("cuts an ISO timestamp to the minute", () => {
    expect(fmtDate("2026-01-10T12:34:56.789Z")).toBe("2026-01-10 12:34");
  });

  test("answers with a dash for an absent date", () => {
    expect(fmtDate(undefined)).toBe("—");
  });
});

describe("fmtDuration", () => {
  test("seconds, then minutes, then hours and minutes", () => {
    expect(fmtDuration(400)).toBe("0 s");
    expect(fmtDuration(42_000)).toBe("42 s");
    expect(fmtDuration(30 * 60_000)).toBe("30 min");
    expect(fmtDuration(64 * 60_000)).toBe("1h 04");
  });

  test("answers with a dash for an absent or negative duration", () => {
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(-1)).toBe("—");
  });
});

describe("fmtTokens", () => {
  test("whole, then thousands, then millions", () => {
    expect(fmtTokens(566)).toBe("566");
    expect(fmtTokens(2864)).toBe("2.9 k");
    expect(fmtTokens(11_841_980)).toBe("11.84 M");
    expect(fmtTokens(undefined)).toBe("—");
  });
});

describe("fmtClock", () => {
  // Built in local time: the clock is the reader's, so the test must not
  // depend on the time zone it runs in. Friday 25 September 2026, 18:00.
  const now = new Date(2026, 8, 25, 18, 0).getTime();
  const at = (day: number, hours: number, minutes: number): string =>
    new Date(2026, 8, day, hours, minutes).toISOString();

  test("shows the clock alone for today", () => {
    expect(fmtClock(at(25, 17, 36), now)).toBe("17:36");
    expect(fmtClock(at(25, 0, 5), now)).toBe("00:05");
  });

  test("adds the weekday within the last six days", () => {
    expect(fmtClock(at(24, 23, 59), now)).toBe("Thu 24, 23:59");
    expect(fmtClock(at(19, 9, 0), now)).toBe("Sat 19, 09:00");
  });

  test("shows the date beyond, and for another day ahead of our clock", () => {
    expect(fmtClock(at(18, 17, 36), now)).toBe("18 Sep, 17:36");
    expect(fmtClock(at(26, 1, 0), now)).toBe("26 Sep, 01:00");
  });

  test("answers with a dash for an absent or unparsable date", () => {
    expect(fmtClock(undefined, now)).toBe("—");
    expect(fmtClock("", now)).toBe("—");
    expect(fmtClock("not a date", now)).toBe("—");
  });
});

describe("shortRunId", () => {
  test("keeps the timestamp of a runner id, and the head of any other", () => {
    expect(shortRunId("20260925T141236.406Z-feature-a22f24")).toBe("20260925T141236");
    expect(shortRunId("run-1")).toBe("run-1");
    expect(shortRunId("abcdefghijklmnop")).toBe("abcdefghijkl");
  });
});
