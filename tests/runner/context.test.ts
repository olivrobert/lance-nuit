import { expect, test } from "bun:test";
import { contextEvent } from "../../src/shared/runtime/context.js";

test("contextEvent: the window remains observable even beyond its limit", () => {
  expect(contextEvent(245_000, 200_000, "sonnet", 123)).toEqual({
    type: "runner-event",
    event: "context",
    tokens: 245_000,
    window: 200_000,
    pct: 1.225,
    model: "sonnet",
    timestamp: 123,
  });
});
