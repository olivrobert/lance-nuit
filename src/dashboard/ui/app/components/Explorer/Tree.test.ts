import { describe, expect, test } from "bun:test";
import { isOpen } from "./Tree.js";

describe("isOpen", () => {
  test("closed by default", () => {
    expect(isOpen("runs", [], null)).toBe(false);
  });

  test("open when listed in openDirs", () => {
    expect(isOpen("runs", ["runs"], null)).toBe(true);
  });

  test("open when it holds the selected file, without being listed", () => {
    expect(isOpen("runs/feature", [], "runs/feature/state.json")).toBe(true);
  });

  test("not open for a sibling that merely shares a prefix", () => {
    expect(isOpen("runs/feature", [], "runs/feature-2/state.json")).toBe(false);
  });

  test("open for every ancestor of the selected file, not just its direct parent", () => {
    expect(isOpen("runs", [], "runs/feature/state.json")).toBe(true);
  });
});
