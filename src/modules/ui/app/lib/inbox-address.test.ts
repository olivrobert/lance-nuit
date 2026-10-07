import { describe, expect, test } from "bun:test";
import type { ProjectView } from "../api/types.js";
import { addressOf, inboxTarget, knownChip, resolveSelection, sheetSearchOf } from "./inbox-address.js";
import { makeItem } from "./testing.js";

describe("addressOf", () => {
  test("reads the chip and the item from each inbox route's params", () => {
    expect(addressOf({}, "/")).toEqual({ view: "inbox", chip: null, item: null });
    expect(addressOf({ project: "web" }, "/projects/web")).toEqual({ view: "inbox", chip: "web", item: null });
    expect(addressOf({ project: "web", ticket: "PAC-1" }, "/projects/web/tickets/PAC-1")).toEqual({
      view: "inbox",
      chip: "web",
      item: "web/PAC-1",
    });
    expect(addressOf({ itemProject: "web", ticket: "a/b" }, "/tickets/web/a/b")).toEqual({
      view: "inbox",
      chip: null,
      item: "web/a/b",
    });
  });

  test("reads the view from the path", () => {
    expect(addressOf({}, "/history").view).toBe("history");
    expect(addressOf({ project: "web" }, "/history/projects/web").view).toBe("history");
    // A project named `history` is not the history view.
    expect(addressOf({ itemProject: "history", ticket: "A" }, "/tickets/history/A").view).toBe("inbox");
    expect(addressOf({ project: "history" }, "/projects/history").view).toBe("inbox");
  });
});

describe("inboxTarget", () => {
  test("names the route of each address", () => {
    expect(inboxTarget({ view: "inbox", chip: null, item: null })).toEqual({ to: "/" });
    expect(inboxTarget({ view: "inbox", chip: "web", item: null })).toEqual({
      to: "/projects/$project",
      params: { project: "web" },
    });
    expect(inboxTarget({ view: "inbox", chip: "web", item: "web/PAC-1" })).toEqual({
      to: "/projects/$project/tickets/$ticket",
      params: { project: "web", ticket: "PAC-1" },
    });
    expect(inboxTarget({ view: "inbox", chip: null, item: "my web/a/b#c" })).toEqual({
      to: "/tickets/$itemProject/$ticket",
      params: { itemProject: "my web", ticket: "a/b#c" },
    });
  });

  test("prefixes every route of the history view", () => {
    expect(inboxTarget({ view: "history", chip: null, item: null })).toEqual({ to: "/history" });
    expect(inboxTarget({ view: "history", chip: "web", item: null }).to).toBe("/history/projects/$project");
    expect(inboxTarget({ view: "history", chip: "web", item: "web/A" }).to).toBe(
      "/history/projects/$project/tickets/$ticket",
    );
    expect(inboxTarget({ view: "history", chip: null, item: "web/A" }).to).toBe(
      "/history/tickets/$itemProject/$ticket",
    );
  });

  test("an item outside the chip is left out of the address", () => {
    expect(inboxTarget({ view: "inbox", chip: "api", item: "web/PAC-1" })).toEqual({
      to: "/projects/$project",
      params: { project: "api" },
    });
  });

  test("round-trips through addressOf", () => {
    for (const view of ["inbox", "history"] as const) {
      for (const address of [
        { view, chip: "web", item: "web/PAC-1" },
        { view, chip: null, item: "web/a/b" },
        { view, chip: "web", item: null },
        { view, chip: null, item: null },
      ]) {
        const target = inboxTarget(address);
        const params: Record<string, string> = "params" in target ? target.params : {};
        const path = target.to.replace(/\$(\w+)/g, (_, name: string) => params[name] ?? "");
        expect(addressOf(params, path)).toEqual(address);
      }
    }
  });
});

describe("knownChip", () => {
  const projects = [{ name: "web" }] as ProjectView[];

  test("keeps a listed project and drops any other", () => {
    expect(knownChip("web", projects)).toBe("web");
    expect(knownChip("gone", projects)).toBeNull();
    expect(knownChip(null, projects)).toBeNull();
  });
});

describe("resolveSelection", () => {
  const done = makeItem({ key: "web/A", group: "done", status: "PASS" });
  const waiting = makeItem({ key: "web/B", group: "decision" });
  const running = makeItem({ key: "web/C", group: "running" });
  const older = makeItem({ key: "web/D", group: "done", status: "PASS" });

  test("keeps the requested item while it is on screen", () => {
    expect(resolveSelection([done, waiting], "history", "web/A")).toEqual({ view: "history", item: done });
  });

  test("moves to the view the requested item is filed in", () => {
    expect(resolveSelection([done, waiting], "inbox", "web/A")).toEqual({ view: "history", item: done });
    expect(resolveSelection([done, waiting], "history", "web/B")).toEqual({ view: "inbox", item: waiting });
  });

  test("falls back to the view's first row waiting for the reader, then to its first row", () => {
    expect(resolveSelection([done, running, waiting], "inbox", "web/gone")).toEqual({ view: "inbox", item: waiting });
    expect(resolveSelection([done, running], "inbox", null)).toEqual({ view: "inbox", item: running });
    expect(resolveSelection([waiting, done, older], "history", null)).toEqual({ view: "history", item: done });
    expect(resolveSelection([done], "inbox", null)).toEqual({ view: "inbox", item: null });
    expect(resolveSelection([], "inbox", "web/A")).toEqual({ view: "inbox", item: null });
  });
});

describe("sheetSearchOf", () => {
  test("keeps a known tab and a file path, drops everything else", () => {
    expect(sheetSearchOf({ tab: "files", file: "artifacts/plan.md", other: "x" })).toEqual({
      tab: "files",
      file: "artifacts/plan.md",
    });
    expect(sheetSearchOf({ tab: "nope", file: "" })).toEqual({});
    expect(sheetSearchOf({ file: 12 })).toEqual({ file: "12" });
    expect(sheetSearchOf({ file: { a: 1 } })).toEqual({});
  });
});
