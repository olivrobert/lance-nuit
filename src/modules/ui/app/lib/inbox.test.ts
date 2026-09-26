import { describe, expect, test } from "bun:test";
import type { Item } from "../api/types.js";
import { newlyWaiting, visibleItems, waitingCount, waitingKeys } from "./inbox.js";
import { makeItem } from "./testing.js";

describe("visibleItems", () => {
  const items: Item[] = [
    makeItem({ key: "web/ABC-1", ticket: "ABC-1", group: "decision", stop: { detail: "gate" } }),
    makeItem({
      key: "web/ABC-2",
      ticket: "ABC-2",
      group: "failure",
      status: "FAIL",
      failure: { phase: "build", reason: "npm exploded" },
    }),
    makeItem({
      key: "api/XYZ-9",
      ticket: "XYZ-9",
      group: "running",
      status: "RUNNING",
      pipeline: "hotfix",
      project: { name: "api", cwd: "/srv/api", provider: "jira" },
    }),
    makeItem({
      key: "api/XYZ-8",
      ticket: "XYZ-8",
      group: "done",
      status: "PASS",
      project: { name: "api", cwd: "/srv/api", provider: "jira" },
    }),
  ];
  const all = { filter: null, query: "" };

  test("without a filter, every item is listed whatever its group", () => {
    expect(visibleItems(items, all).map((item) => item.key)).toEqual([
      "web/ABC-1",
      "web/ABC-2",
      "api/XYZ-9",
      "api/XYZ-8",
    ]);
  });

  test("the project chip narrows to one project", () => {
    expect(visibleItems(items, { ...all, filter: "web" }).map((item) => item.key)).toEqual(["web/ABC-1", "web/ABC-2"]);
    expect(visibleItems(items, { ...all, filter: "api" }).map((item) => item.key)).toEqual(["api/XYZ-9", "api/XYZ-8"]);
  });

  test("the search matches the ticket, the title, the pipeline, the project and the reason", () => {
    expect(visibleItems(items, { ...all, query: "abc-2" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, query: "exploded" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, query: "hotfix" }).map((item) => item.key)).toEqual(["api/XYZ-9"]);
    expect(visibleItems(items, { ...all, query: "api" }).map((item) => item.key)).toEqual(["api/XYZ-9", "api/XYZ-8"]);
    const titled = [makeItem({ key: "web/T-1", title: "Export CSV of members" })];
    expect(visibleItems(titled, { ...all, query: "csv" }).map((item) => item.key)).toEqual(["web/T-1"]);
  });

  test("the search is case-insensitive and ignores surrounding blanks", () => {
    expect(visibleItems(items, { ...all, query: "  GATE  " }).map((item) => item.key)).toEqual(["web/ABC-1"]);
  });

  test("filters cross: a project and a search that disagree keep nothing", () => {
    expect(visibleItems(items, { ...all, filter: "web", query: "xyz" })).toEqual([]);
  });
});

describe("waitingCount", () => {
  const items: Item[] = [
    makeItem({ key: "web/1", group: "decision" }),
    makeItem({ key: "web/2", group: "failure" }),
    makeItem({ key: "api/3", group: "running", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/4", group: "done", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/5", group: "decision", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
  ];

  test("waiting counts narrow to one project, or to all of them", () => {
    expect(waitingCount(items, null)).toBe(3);
    expect(waitingCount(items, "web")).toBe(2);
    expect(waitingCount(items, "api")).toBe(1);
  });
});

describe("newlyWaiting", () => {
  const stopped = makeItem({ key: "web/ABC-1" });
  const failed = makeItem({ key: "web/ABC-2", ticket: "ABC-2", status: "FAIL", group: "failure" });
  const done = makeItem({ key: "web/ABC-3", ticket: "ABC-3", status: "PASS", group: "done" });

  test("announces nothing on the first poll: what waits is already on screen", () => {
    expect(newlyWaiting(null, [stopped, failed])).toEqual([]);
  });

  test("announces an item that started waiting since the previous poll", () => {
    expect(newlyWaiting(waitingKeys([stopped, done]), [stopped, failed, done])).toEqual([failed]);
  });

  test("announces again an item that left the queue and came back", () => {
    const rerunning = { ...stopped, status: "RUNNING" as const, group: "running" as const };
    const previous = waitingKeys([rerunning]);
    expect(newlyWaiting(previous, [stopped])).toEqual([stopped]);
  });

  test("never announces a completed run", () => {
    expect(newlyWaiting(new Set(), [done])).toEqual([]);
  });
});
