import { describe, expect, test } from "bun:test";
import { fmtAge, fmtCost, fmtDate, fmtDuration, fmtSize, fmtTokens } from "./format.js";

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
