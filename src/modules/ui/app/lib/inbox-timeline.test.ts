import { describe, expect, test } from "bun:test";
import type { Item } from "../api/types.js";
import { rowShowsTag, rowTime, timeline, type TimelineSection } from "./inbox-timeline.js";
import { makeItem, makeLaunch } from "./testing.js";

describe("timeline", () => {
  // Local time throughout: the night boundary is a local hour. 25 Sep 2026 is a Friday.
  const local = (day: number, hour: number, minute = 0): Date => new Date(2026, 8, day, hour, minute);
  const done = (key: string, at: Date | string, overrides: Partial<Item> = {}): Item =>
    makeItem({
      key,
      group: "done",
      status: "PASS",
      updatedAt: typeof at === "string" ? at : at.toISOString(),
      ...overrides,
    });
  const shape = (sections: TimelineSection[]): [string, string, string[]][] =>
    sections.map((section) => [section.id, section.label, section.items.map((item) => item.key)]);

  test("in the morning, runs since yesterday evening are last night", () => {
    const sections = timeline([done("web/a", local(24, 23)), done("web/b", local(25, 3))], local(25, 8));
    expect(shape(sections)).toEqual([["night-0", "Last night", ["web/b", "web/a"]]]);
    expect(sections[0]?.range).toBe("Thu 24 → Fri 25");
  });

  test("in the morning, yesterday's daytime run is yesterday", () => {
    expect(shape(timeline([done("web/a", local(24, 10))], local(25, 8)))).toEqual([
      ["night-1", "Yesterday", ["web/a"]],
    ]);
  });

  test("in the evening, the labels shift by one night", () => {
    const items = [done("web/a", local(25, 19)), done("web/b", local(25, 3)), done("web/c", local(24, 10))];
    expect(shape(timeline(items, local(25, 20)))).toEqual([
      ["night-0", "Tonight", ["web/a"]],
      ["night-1", "Last night", ["web/b"]],
      ["week", "This week", ["web/c"]],
    ]);
  });

  test("a run at exactly the start hour opens the new night", () => {
    const items = [done("web/a", local(24, 18)), done("web/b", local(24, 17, 59))];
    expect(shape(timeline(items, local(25, 8)))).toEqual([
      ["night-0", "Last night", ["web/a"]],
      ["night-1", "Yesterday", ["web/b"]],
    ]);
  });

  test("a run eight days old is earlier, and collapsed", () => {
    const [section] = timeline([done("web/a", local(17, 8))], local(25, 8));
    expect(section).toMatchObject({ id: "earlier", label: "Earlier", collapsed: true });
    const [week] = timeline([done("web/b", local(18, 10))], local(25, 8));
    expect(week).toMatchObject({ id: "week", collapsed: false, range: "Thu 17 → Fri 18" });
  });

  test("waiting and running items never land in a night", () => {
    const items = [
      done("web/a", local(25, 3)),
      makeItem({ key: "web/b", group: "running", status: "RUNNING", updatedAt: local(25, 2).toISOString() }),
      makeItem({ key: "web/c", group: "failure", status: "FAIL", updatedAt: local(25, 7).toISOString() }),
      makeItem({ key: "web/d", group: "decision", updatedAt: local(25, 1).toISOString() }),
    ];
    expect(shape(timeline(items, local(25, 8)))).toEqual([
      ["needs", "Needs you", ["web/d", "web/c"]],
      ["running", "Running", ["web/b"]],
      ["night-0", "Last night", ["web/a"]],
    ]);
  });

  test("empty sections are omitted", () => {
    expect(timeline([], local(25, 8))).toEqual([]);
  });

  test("a date that does not parse lands in earlier and never throws", () => {
    expect(shape(timeline([done("web/a", "not a date")], local(25, 8)))).toEqual([["earlier", "Earlier", ["web/a"]]]);
  });

  test("the header cost sums the rows, and one unpriced row makes it a floor", () => {
    const items = [
      done("web/a", local(25, 1), { cost: { usd: 1.5, estimated: false } }),
      done("web/b", local(25, 2), { cost: { usd: 2, estimated: false, unknown: true } }),
    ];
    expect(timeline(items, local(25, 8))[0]?.cost).toEqual({ usd: 3.5, estimated: false, unknown: true });
  });

  test("a row is tagged only for an exception", () => {
    expect(rowShowsTag(done("web/a", local(25, 1)))).toBe(false);
    expect(rowShowsTag(done("web/a", local(25, 1), { closed: { at: "x", by: "olivier" }, status: "FAIL" }))).toBe(true);
    expect(rowShowsTag(makeItem({ status: "STOPPED" }))).toBe(true);
    expect(rowShowsTag(done("web/a", local(25, 1), { launch: makeLaunch({ alive: true }) }))).toBe(true);
  });

  test("the row time follows its section", () => {
    const now = local(25, 8);
    const item = done("web/a", local(23, 3, 55));
    expect(rowTime(item, "night-0", now)).toBe("03:55");
    expect(rowTime(item, "week", now)).toBe("Wed 03:55");
    expect(rowTime(item, "earlier", now)).toBe("23 Sep");
    expect(rowTime(item, "needs", now)).toBe("2d ago");
    expect(rowTime(done("web/b", "nope"), "night-1", now)).toBe("—");
  });
});
