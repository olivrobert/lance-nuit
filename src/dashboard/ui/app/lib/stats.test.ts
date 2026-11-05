import { describe, expect, test } from "bun:test";
import type { StatsTicket } from "../api/types.js";
import {
  DEFAULT_FILTER,
  daysAgo,
  filterTickets,
  median,
  nextSort,
  type StatsFilter,
  sortTickets,
  spanMs,
  totalsOf,
} from "./stats.js";

function ticket(key: string, fields: Partial<StatsTicket> = {}): StatsTicket {
  const [project = "", id = ""] = key.split("/");
  return {
    key,
    project,
    ticket: id,
    kind: "other",
    source: "live",
    costEstimated: false,
    costUnknown: false,
    outcome: "PASS",
    pipelines: [],
    runs: [],
    ...fields,
  };
}

const a = ticket("app/T-2", { kind: "bug", costUsd: 5, activeMs: 1000 });
const b = ticket("app/T-10", { kind: "feature", costUsd: 20, activeMs: 3000, source: "archive" });
const c = ticket("web/T-1", { kind: "bug", source: "mixed", outcome: "FAIL" });
const d = ticket("web/T-3", { kind: "feature", costUsd: 1, costEstimated: true, costUnknown: true });
const { outcome: _, ...triagedOnly } = ticket("web/T-4", { kind: "other", costUsd: 0.2 });
const e: StatsTicket = triagedOnly;

describe("sortTickets", () => {
  test("figures sort either way, and a missing one stays last", () => {
    const keys = (descending: boolean) =>
      sortTickets([a, b, c, d], { column: "cost", descending }).map((entry) => entry.key);
    expect(keys(true)).toEqual(["app/T-10", "app/T-2", "web/T-3", "web/T-1"]);
    expect(keys(false)).toEqual(["web/T-3", "app/T-2", "app/T-10", "web/T-1"]);
  });

  test("text sorts naturally, so T-10 follows T-2", () => {
    const keys = sortTickets([b, a], { column: "ticket", descending: false }).map((entry) => entry.key);
    expect(keys).toEqual(["app/T-2", "app/T-10"]);
  });
});

describe("nextSort", () => {
  test("the same column flips, another starts at its natural order", () => {
    expect(nextSort({ column: "cost", descending: true }, "cost")).toEqual({ column: "cost", descending: false });
    expect(nextSort({ column: "cost", descending: true }, "ticket")).toEqual({ column: "ticket", descending: false });
    expect(nextSort({ column: "ticket", descending: false }, "active")).toEqual({ column: "active", descending: true });
  });
});

describe("filterTickets", () => {
  test("project, kind and source narrow the set; a mixed ticket answers both sources", () => {
    const keys = (filter: Pick<StatsFilter, "project" | "kind" | "source">) =>
      filterTickets([a, b, c, d], { ...DEFAULT_FILTER, ...filter, scope: "all" }).map((entry) => entry.key);
    expect(keys({ project: "web", kind: null, source: "all" })).toEqual(["web/T-1", "web/T-3"]);
    expect(keys({ project: null, kind: "bug", source: "all" })).toEqual(["app/T-2", "web/T-1"]);
    expect(keys({ project: null, kind: null, source: "archive" })).toEqual(["app/T-10", "web/T-1"]);
    expect(keys({ project: null, kind: null, source: "live" })).toEqual(["app/T-2", "web/T-1", "web/T-3"]);
  });

  test("the default scope leaves out a ticket nothing delivered", () => {
    const keys = (filter: StatsFilter) => filterTickets([d, e], filter).map((entry) => entry.key);
    expect(keys(DEFAULT_FILTER)).toEqual(["web/T-3"]);
    expect(keys({ ...DEFAULT_FILTER, scope: "all" })).toEqual(["web/T-3", "web/T-4"]);
  });

  test("the date range keeps the tickets last active within it, both days included", () => {
    const at = (key: string, day: string, time: string) =>
      ticket(key, { lastAt: new Date(`${day}T${time}`).toISOString() });
    const early = at("app/E-1", "2026-09-01", "00:00:00");
    const late = at("app/E-2", "2026-09-10", "23:59:00");
    const after = at("app/E-3", "2026-09-11", "00:00:01");
    const undated = ticket("app/E-4");
    const keys = (from: string | null, to: string | null) =>
      filterTickets([early, late, after, undated], { ...DEFAULT_FILTER, from, to }).map((entry) => entry.key);
    expect(keys(null, null)).toEqual(["app/E-1", "app/E-2", "app/E-3", "app/E-4"]);
    expect(keys("2026-09-01", "2026-09-10")).toEqual(["app/E-1", "app/E-2"]);
    expect(keys("2026-09-02", null)).toEqual(["app/E-2", "app/E-3"]);
    expect(keys(null, "2026-09-01")).toEqual(["app/E-1"]);
  });
});

describe("daysAgo", () => {
  test("counts local calendar days, across a month boundary", () => {
    expect(daysAgo(0, new Date(2026, 8, 26, 23, 30))).toBe("2026-09-26");
    expect(daysAgo(30, new Date(2026, 8, 26, 0, 10))).toBe("2026-08-27");
  });
});

describe("totalsOf", () => {
  test("passed, failed and unfinished split the set; means count only priced tickets", () => {
    const totals = totalsOf([a, b, c, d, e]);
    expect(totals.all).toMatchObject({ tickets: 5, costUsd: 26.2, activeMs: 4000, estimated: true, unknown: true });
    expect(totals.passed).toMatchObject({
      tickets: 3,
      costUsd: 26,
      meanUsd: 26 / 3,
      medianUsd: 5,
      estimated: true,
      unknown: true,
    });
    expect(totals.failed).toEqual({ tickets: 1, estimated: false, unknown: false });
    expect(totals.unfinished).toMatchObject({ tickets: 1, costUsd: 0.2, estimated: false });
  });

  test("a pass that shipped nothing is unfinished, never passed", () => {
    const unshipped = ticket("app/T-5", { outcome: "UNSHIPPED", costUsd: 3 });
    const totals = totalsOf([a, unshipped]);
    expect(totals.passed).toMatchObject({ tickets: 1, costUsd: 5 });
    expect(totals.unfinished).toMatchObject({ tickets: 1, costUsd: 3 });
  });

  test("an empty set has no figures", () => {
    const totals = totalsOf([]);
    expect(totals.all).toMatchObject({ tickets: 0, estimated: false, unknown: false });
    expect(totals.passed.meanUsd).toBeUndefined();
  });
});

describe("helpers", () => {
  test("median of an even set is the mean of its middle pair", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  test("span needs both ends, in order", () => {
    expect(spanMs(ticket("x/1", { firstAt: "2026-09-01T00:00:00Z", lastAt: "2026-09-01T01:00:00Z" }))).toBe(3_600_000);
    expect(spanMs(ticket("x/1", { firstAt: "2026-09-01T00:00:00Z" }))).toBeUndefined();
  });
});
