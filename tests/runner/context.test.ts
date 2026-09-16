import { expect, test } from "bun:test";
import { contextEvent, contextTokensFromUsage } from "../../src/runtime/context.js";

test("contextTokensFromUsage sums input, cache read, and cache creation without output", () => {
  expect(
    contextTokensFromUsage({
      input_tokens: 100,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 2_000,
      output_tokens: 999,
    }),
  ).toBe(52_100);
  expect(contextTokensFromUsage(null)).toBe(0);
  expect(contextTokensFromUsage({})).toBe(0);
});

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
