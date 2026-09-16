import { expect, test } from "bun:test";
import { splitAttemptStats } from "./stats.js";

test("stats: validates the integration contract", () => {
  const { control, usage } = splitAttemptStats({
    duration_ms: 100,
    total_cost_usd: 0.1,
    model: "claude-sonnet-4-6",
    output_tokens: 10,
    tools_used: ["Read"],
  });
  expect(control).toEqual({
    duration_ms: 100,
    total_cost_usd: 0.1,
    model: "claude-sonnet-4-6",
    cost_estimated: undefined,
    last_turn_context_tokens: undefined,
    context_window: undefined,
  });
  expect(usage).toEqual({
    duration_api_ms: undefined,
    num_turns: undefined,
    input_tokens: undefined,
    output_tokens: 10,
    cache_read_tokens: undefined,
    cache_creation_tokens: undefined,
    tools_used: ["Read"],
  });
});

test("cost_unknown marks tokens spent at an unknown price", () => {
  // Codex without a pricing entry: turns and tokens, no cost. Counting that as
  // zero would freeze the ledger and silently disable max_cost_usd.
  const unpriced = splitAttemptStats({ duration_ms: 100, output_tokens: 900, model: "gpt-x-unknown" });
  expect(unpriced.control.cost_unknown).toBe(true);
  expect(unpriced.control.total_cost_usd).toBeUndefined();

  // A bash step has no tokens at all: absence of cost is not an unknown cost.
  expect(splitAttemptStats(undefined).control.cost_unknown).toBeUndefined();
  expect(
    splitAttemptStats({ duration_ms: 10, total_cost_usd: 0.2, output_tokens: 5 }).control.cost_unknown,
  ).toBeUndefined();
});

test("splitAttemptStats: an explicit cost_unknown survives without tokens", () => {
  // The attempt layer flags an agent killed before its first usage event: no token
  // count, no price, yet a spend. The split must not read the flag as "free".
  const { control } = splitAttemptStats({ duration_ms: 5, cost_unknown: true });
  expect(control.cost_unknown).toBe(true);
  expect(control.total_cost_usd).toBeUndefined();
  // A price beside the flag is a lower bound, not a contradiction: the Claude
  // backend sums the discarded transport attempts under a final attempt it could
  // not measure. The price is kept AND the flag survives.
  const bounded = splitAttemptStats({ duration_ms: 5, total_cost_usd: 1, cost_unknown: true }).control;
  expect(bounded.total_cost_usd).toBe(1);
  expect(bounded.cost_unknown).toBe(true);
  // Without the flag, a priced attempt is priced.
  expect(splitAttemptStats({ duration_ms: 5, total_cost_usd: 1 }).control.cost_unknown).toBeUndefined();
});

test("splitAttemptStats: a reported $0 over consumed tokens is unknown, not free", () => {
  // Tokens alone do not establish a price. A backend that cannot price its model
  // writes 0, and taking that as exact is what let a cost ceiling look affordable
  // after an attempt nobody could bill.
  const { control } = splitAttemptStats({ duration_ms: 10, total_cost_usd: 0, input_tokens: 1200, output_tokens: 80 });
  expect(control.cost_unknown).toBe(true);
});

test("splitAttemptStats: an exact measured zero stays exact", () => {
  // No tokens at all: the attempt really did spend nothing (a shell step, an
  // agent that never reached its provider).
  const { control } = splitAttemptStats({ duration_ms: 10, total_cost_usd: 0 });
  expect(control.cost_unknown).toBeUndefined();
  expect(control.total_cost_usd).toBe(0);
});

test("splitAttemptStats: a zero produced by explicit zero rates stays an estimate", () => {
  // A matching `pricing.json` entry at rate 0 is a decision, not a gap: the
  // estimate is usable for the cap.
  const { control } = splitAttemptStats({
    duration_ms: 10,
    total_cost_usd: 0,
    cost_estimated: true,
    input_tokens: 1200,
    output_tokens: 80,
  });
  expect(control.cost_unknown).toBeUndefined();
  expect(control.cost_estimated).toBe(true);
});
