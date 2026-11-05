import { describe, expect, test } from "bun:test";
import { freshnessOf, STALE_AFTER_MS, updatedLabel } from "./freshness.js";

describe("freshness", () => {
  const now = Date.parse("2026-01-10T10:00:00.000Z");

  test("a failed read is lost, whatever its age", () => {
    expect(freshnessOf(now, "fetch failed", now)).toBe("lost");
  });

  test("a screen whose reads stopped landing is stale", () => {
    expect(freshnessOf(now - STALE_AFTER_MS - 1, null, now)).toBe("stale");
    expect(freshnessOf(now - 20_000, null, now)).toBe("ok");
  });

  test("the label says how old the screen is", () => {
    expect(updatedLabel(null, now)).toBe("Not updated yet");
    expect(updatedLabel(now - 5_000, now)).toBe("Updated just now");
    expect(updatedLabel(now - 4 * 60_000, now)).toBe("Updated 4m ago");
  });
});
