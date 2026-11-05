import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER, DEFAULT_SORT, type StatsFilter, type StatsSort } from "./stats.js";
import { searchOfStatsView, statsSearchOf, statsViewOf } from "./stats-search.js";

describe("stats search params", () => {
  test("the default view has an empty search", () => {
    expect(searchOfStatsView(DEFAULT_FILTER, DEFAULT_SORT)).toEqual({});
    expect(statsViewOf({})).toEqual({ filter: DEFAULT_FILTER, sort: DEFAULT_SORT });
  });

  test("a view round-trips through its search", () => {
    const filter: StatsFilter = {
      project: "web",
      kind: "bug",
      source: "archive",
      scope: "all",
      from: "2026-09-01",
      to: "2026-09-30",
    };
    const sort: StatsSort = { column: "project", descending: false };
    const search = searchOfStatsView(filter, sort);
    expect(statsViewOf(statsSearchOf({ ...search }))).toEqual({ filter, sort });
  });

  test("a bad value falls back to its default alone", () => {
    expect(
      statsSearchOf({ project: 42, kind: "epic", source: "live", from: "yesterday", sort: "size", desc: "no" }),
    ).toEqual({ project: "42", source: "live" });
  });
});
