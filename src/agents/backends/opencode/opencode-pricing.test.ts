import { expect, test } from "bun:test";
import {
  computeCostUsd,
  MODEL_PRICING,
  OPENCODE_MODEL_PRICING,
  pricingForModel,
  resolveOpencodeCost,
} from "./pricing.js";

test("opencode pricing ships no table of its own: prices come from the provider", () => {
  // The catalog moves every week and spans several providers. A hardcoded rate
  // would be wrong before it is committed; `step_finish.cost` is authoritative.
  expect(OPENCODE_MODEL_PRICING).toBe(MODEL_PRICING);
  expect(Object.keys(MODEL_PRICING)).toEqual([]);
});

test("opencode pricing never bills an unknown model with another model's rate", () => {
  expect(pricingForModel(undefined, null)).toBeNull();
  expect(pricingForModel("opencode/nemotron-3-ultra-free", null)).toBeNull();
  expect(
    computeCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "zai-coding-plan/glm-5.2", null),
  ).toBeUndefined();
});

test("opencode pricing honours a project price list, with the shared USD rules", () => {
  const table = {
    _currency: "$",
    "glm-5.2": { in: 0.6, out: 2.2, cacheRead: 0.11, cacheWrite: 0.8 },
  };

  expect(pricingForModel("zai-coding-plan/glm-5.2", table)).toEqual({
    input: 0.6,
    output: 2.2,
    cache_read: 0.11,
    cache_write_5m: 0.8,
    cache_write_1h: 0.8,
  });
  // A non-USD list is ignored rather than converted at an invented rate.
  expect(pricingForModel("zai-coding-plan/glm-5.2", { ...table, _currency: "€" })).toBeNull();
});

test("opencode cost bills input and cached read side by side", () => {
  const table = { _currency: "$", "glm-5.2": { in: 0.6, out: 2.2, cacheRead: 0.11, cacheWrite: 0.8 } };

  const cost = computeCostUsd(
    { input_tokens: 1_000_000, cache_read_tokens: 800_000, output_tokens: 10 },
    "zai-coding-plan/glm-5.2",
    table,
  );

  // `tokens.input` and `tokens.cache.read` are disjoint in opencode's own stream —
  // its reported cost is their plain sum — so the estimate must not deduct one
  // from the other and under-price every cached turn.
  expect(cost).toBeCloseTo((1_000_000 * 0.6 + 800_000 * 0.11 + 10 * 2.2) / 1_000_000, 8);
});

const TABLE = { _currency: "$", "glm-5.2": { in: 0.6, out: 2.2 } };
const SPENT = { input_tokens: 1_000_000, output_tokens: 0 };

test("resolveOpencodeCost: a non-zero provider cost is exact", () => {
  expect(resolveOpencodeCost({ costReported: true, costUsd: 0.25 }, SPENT, "zai-coding-plan/glm-5.2", TABLE)).toEqual({
    costUsd: 0.25,
    estimated: false,
    unknown: false,
  });
});

test("resolveOpencodeCost: `cost: 0` over spent tokens falls back to the declared rate", () => {
  // opencode reports 0 when it does not know the model's price, so a 0 on a run
  // that burned a million tokens is a gap the project price list can close.
  expect(resolveOpencodeCost({ costReported: true, costUsd: 0 }, SPENT, "zai-coding-plan/glm-5.2", TABLE)).toEqual({
    costUsd: 0.6,
    estimated: true,
    unknown: false,
  });
});

test("resolveOpencodeCost: `cost: 0` with no rate keeps the amount but drops the certainty", () => {
  expect(resolveOpencodeCost({ costReported: true, costUsd: 0 }, SPENT, "opencode/unpriced", null)).toEqual({
    costUsd: 0,
    estimated: false,
    unknown: true,
  });
});

test("resolveOpencodeCost: `cost: 0` without tokens is a real free turn", () => {
  expect(resolveOpencodeCost({ costReported: true, costUsd: 0 }, {}, "opencode/unpriced", null)).toEqual({
    costUsd: 0,
    estimated: false,
    unknown: false,
  });
});

test("resolveOpencodeCost: no cost field and no rate prices nothing at all", () => {
  expect(resolveOpencodeCost({ costReported: false }, SPENT, "opencode/unpriced", null)).toEqual({
    estimated: false,
    unknown: true,
  });
});
