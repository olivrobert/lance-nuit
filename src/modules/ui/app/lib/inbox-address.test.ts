import { describe, expect, test } from "bun:test";
import type { ProjectView } from "../api/types.js";
import { addressOf, inboxTarget, knownChip, resolveSelection, sheetSearchOf } from "./inbox-address.js";
import { makeItem } from "./testing.js";

describe("addressOf", () => {
  test("reads the chip and the item from each inbox route's params", () => {
    expect(addressOf({})).toEqual({ chip: null, item: null });
    expect(addressOf({ project: "web" })).toEqual({ chip: "web", item: null });
    expect(addressOf({ project: "web", ticket: "PAC-1" })).toEqual({ chip: "web", item: "web/PAC-1" });
    expect(addressOf({ itemProject: "web", ticket: "a/b" })).toEqual({ chip: null, item: "web/a/b" });
  });
});

describe("inboxTarget", () => {
  test("names the route of each address", () => {
    expect(inboxTarget({ chip: null, item: null })).toEqual({ to: "/" });
    expect(inboxTarget({ chip: "web", item: null })).toEqual({ to: "/projects/$project", params: { project: "web" } });
    expect(inboxTarget({ chip: "web", item: "web/PAC-1" })).toEqual({
      to: "/projects/$project/tickets/$ticket",
      params: { project: "web", ticket: "PAC-1" },
    });
    expect(inboxTarget({ chip: null, item: "my web/a/b#c" })).toEqual({
      to: "/tickets/$itemProject/$ticket",
      params: { itemProject: "my web", ticket: "a/b#c" },
    });
  });

  test("an item outside the chip is left out of the address", () => {
    expect(inboxTarget({ chip: "api", item: "web/PAC-1" })).toEqual({
      to: "/projects/$project",
      params: { project: "api" },
    });
  });

  test("round-trips through addressOf", () => {
    for (const address of [
      { chip: "web", item: "web/PAC-1" },
      { chip: null, item: "web/a/b" },
      { chip: "web", item: null },
    ]) {
      const target = inboxTarget(address);
      expect(addressOf("params" in target ? target.params : {})).toEqual(address);
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
  const done = makeItem({ key: "web/A", group: "done" });
  const waiting = makeItem({ key: "web/B", group: "decision" });
  const running = makeItem({ key: "web/C", group: "running" });

  test("keeps the requested item while it is on screen", () => {
    expect(resolveSelection([done, waiting], "web/A")).toBe(done);
  });

  test("falls back to the first item waiting for the reader, then to the first row", () => {
    expect(resolveSelection([done, waiting], "web/gone")).toBe(waiting);
    expect(resolveSelection([done, waiting], null)).toBe(waiting);
    expect(resolveSelection([running, done], null)).toBe(running);
    expect(resolveSelection([], "web/A")).toBeNull();
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
