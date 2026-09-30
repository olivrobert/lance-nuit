import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, type Route } from "./route.js";

const ALL: Route = { view: "inbox", project: null, item: null };

describe("parseRoute", () => {
  test("an empty or unknown hash is the inbox on every project", () => {
    for (const hash of [
      "",
      "#",
      "#/",
      "#/items",
      "#/terminal/",
      "#terminal/ln-web-A",
      "#/projects/",
      "#/tickets/web",
    ]) {
      expect(parseRoute(hash)).toEqual(ALL);
    }
  });

  test("a terminal hash carries its decoded id", () => {
    expect(parseRoute("#/terminal/ln-web-ABC-1")).toEqual({ view: "terminal", id: "ln-web-ABC-1" });
    expect(parseRoute("#/terminal/ln%20odd")).toEqual({ view: "terminal", id: "ln odd" });
  });

  test("the stats hash is the stats screen, and nothing below it", () => {
    expect(parseRoute("#/stats")).toEqual({ view: "stats" });
    expect(parseRoute("#/stats/x")).toEqual(ALL);
  });

  test("a project hash is its chip, with or without an open item", () => {
    expect(parseRoute("#/projects/web")).toEqual({ view: "inbox", project: "web", item: null });
    expect(parseRoute("#/projects/web/tickets/PAC-1")).toEqual({ view: "inbox", project: "web", item: "web/PAC-1" });
  });

  test("a ticket hash opens the item on every project", () => {
    expect(parseRoute("#/tickets/web/PAC-1")).toEqual({ view: "inbox", project: null, item: "web/PAC-1" });
  });

  test("a malformed escape or a nested path is not an address", () => {
    expect(parseRoute("#/terminal/%E0%A4%A")).toEqual(ALL);
    expect(parseRoute("#/terminal/a/b")).toEqual(ALL);
    expect(parseRoute("#/projects/web/tickets")).toEqual(ALL);
    expect(parseRoute("#/projects/web/tickets/A/B")).toEqual(ALL);
  });
});

describe("formatRoute", () => {
  test("round-trips through parseRoute", () => {
    const routes: Route[] = [
      ALL,
      { view: "stats" },
      { view: "inbox", project: "web", item: null },
      { view: "inbox", project: "web", item: "web/PAC-1" },
      { view: "inbox", project: null, item: "web/PAC-1" },
      { view: "inbox", project: "my web", item: "my web/a/b#c" },
      ...["ln-web-ABC-1", "ln odd", "a#b"].map((id): Route => ({ view: "terminal", id })),
    ];
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
    expect(formatRoute(ALL)).toBe("#/");
  });

  test("an item outside the chip is left out of the address", () => {
    expect(formatRoute({ view: "inbox", project: "api", item: "web/PAC-1" })).toBe("#/projects/api");
  });
});
