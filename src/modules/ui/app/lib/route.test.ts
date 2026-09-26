import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute } from "./route.js";

describe("parseRoute", () => {
  test("an empty or unknown hash is the inbox", () => {
    for (const hash of ["", "#", "#/", "#/items", "#/terminal/", "#terminal/ln-web-A"]) {
      expect(parseRoute(hash)).toEqual({ view: "inbox" });
    }
  });

  test("a terminal hash carries its decoded id", () => {
    expect(parseRoute("#/terminal/ln-web-ABC-1")).toEqual({ view: "terminal", id: "ln-web-ABC-1" });
    expect(parseRoute("#/terminal/ln%20odd")).toEqual({ view: "terminal", id: "ln odd" });
  });

  test("the stats hash is the stats screen, and nothing below it", () => {
    expect(parseRoute("#/stats")).toEqual({ view: "stats" });
    expect(parseRoute("#/stats/x")).toEqual({ view: "inbox" });
  });

  test("a malformed escape or a nested path is not an id", () => {
    expect(parseRoute("#/terminal/%E0%A4%A")).toEqual({ view: "inbox" });
    expect(parseRoute("#/terminal/a/b")).toEqual({ view: "inbox" });
  });
});

describe("formatRoute", () => {
  test("round-trips through parseRoute", () => {
    for (const id of ["ln-web-ABC-1", "ln odd", "a#b"]) {
      expect(parseRoute(formatRoute({ view: "terminal", id }))).toEqual({ view: "terminal", id });
    }
    expect(formatRoute({ view: "inbox" })).toBe("#/");
    expect(parseRoute(formatRoute({ view: "stats" }))).toEqual({ view: "stats" });
  });
});
