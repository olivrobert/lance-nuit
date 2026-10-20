import { expect, test } from "bun:test";
import { type ProjectPricing, projectPricingForModel, tokenCostUsd } from "../contracts/pricing.js";
import * as core from "./stats-core.js";

const PRICING = {
  _currency: "$",
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

test("zeroTokens/addTokens: validates the contract", () => {
  const acc = core.zeroTokens();
  core.addTokens(acc, { in: 10, out: 20, cacheRead: 30, cacheWrite: 40 });
  core.addTokens(acc, { in: 1, out: 2 });
  expect(acc).toEqual({ in: 11, out: 22, cacheRead: 30, cacheWrite: 40 });
});

test("fmtInt: validates the contract", () => {
  expect(core.fmtInt(999)).toBe("999");
  expect(core.fmtInt(57000)).toBe("57.0k");
});

test("statusBadge: validates the contract", () => {
  expect(core.statusBadge("PASS")).toBe("✅ PASS");
  expect(core.statusBadge("FAIL")).toBe("❌ FAIL");
  expect(core.statusBadge("STOPPED")).toBe("⏹ STOPPED");
  expect(core.statusBadge(undefined)).toBe("⚪ ?");
});

test("currencyOf: validates the contract", () => {
  expect(core.currencyOf(null)).toBe("$");
  expect(core.currencyOf({})).toBe("$");
  expect(core.currencyOf({ _currency: "€" })).toBe("€");
});

test("currencyOf: an empty currency is not the dollar, as for the runner's rate lookup", () => {
  const table = { _currency: "", "claude-opus-4-8": { in: 5 } };
  expect(projectPricingForModel("claude-opus-4-8", table)).toBeNull();
  expect(core.currencyOf(table)).toBe("");
  expect(core.usablePricing(table)).toBeNull();
  expect(core.costOf({ "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } }, table)).toBeNull();
});

test("costOf: validates the contract", () => {
  const models = { "claude-opus-4-8": { in: 1000, out: 2000, cacheRead: 10000, cacheWrite: 4000 } };
  expect(core.costOf(models, null)).toBeNull();
  const expected = (1000 * 5 + 2000 * 25 + 10000 * 0.5 + 4000 * 6.25) / 1e6;
  expect(core.costOf(models, PRICING)).toBeCloseTo(expected, 10);
  // A model the table does not cover makes the run unpriceable, not free: $0.00
  // would be read as a measured cost.
  expect(core.costOf({ "gpt-4": { in: 1e6, out: 1e6, cacheRead: 0, cacheWrite: 0 } }, PRICING)).toBeNull();
  // An unlisted model that spent nothing costs nothing; it hides no spend.
  expect(core.costOf({ "gpt-4": { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }, PRICING)).toBe(0);
  // Fragment matching, like the runner: a dated or vendor-prefixed id resolves to
  // the shortest listed name it contains.
  expect(
    core.costOf({ "anthropic/claude-opus-4-8-20260115": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } }, PRICING),
  ).toBe(5);
});

test("costOf: each model is priced by the runner's rate lookup and formula", () => {
  const table = {
    ...PRICING,
    // Partial rates: what a table leaves out costs nothing.
    "gpt-5.6-luna": { in: 0.2, cacheRead: 0.02 },
  };
  const models = {
    "anthropic/claude-opus-4-8-20260115": { in: 1200, out: 45000, cacheRead: 900000, cacheWrite: 120000 },
    "claude-sonnet-4-6": { in: 3, out: 7, cacheRead: 11, cacheWrite: 13 },
    "gpt-5.6-luna": { in: 200_000, out: 10, cacheRead: 800_000, cacheWrite: 0 },
  };
  const runner = Object.entries(models).reduce((usd, [model, t]) => {
    const rate = projectPricingForModel(model, table as ProjectPricing);
    if (!rate) throw new Error(`the runner cannot price ${model}`);
    const breakdown = { output_tokens: t.out, cache_read_tokens: t.cacheRead, cache_creation_tokens: t.cacheWrite };
    return usd + tokenCostUsd(breakdown, rate, t.in);
  }, 0);

  expect(core.costOf(models, table)).toBe(runner);
});

test("costOf: a model the runner's lookup cannot price leaves the run unpriced", () => {
  // The longest fragment wins, as in the runner, even when it holds no rates: the
  // stats reader no longer skips it to fall back on a shorter key.
  const table = { _currency: "$", "claude-opus": "renamed, see claude", claude: { in: 1 } };
  const models = { "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } };

  expect(projectPricingForModel("claude-opus-4-8", table)).toBeNull();
  expect(core.costOf(models, table)).toBeNull();
});

test("entryCost: validates the contract", () => {
  const entry = {
    costUsd: 1.23,
    models: { "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } }, // = $5 via pricing
  };
  expect(core.entryCost(entry, PRICING)).toBe(1.23);
});

test("entryCost: validates the contract", () => {
  const models = { "claude-sonnet-4-6": { in: 0, out: 1e6, cacheRead: 0, cacheWrite: 0 } };
  expect(core.entryCost({ models }, PRICING)).toBeCloseTo(15, 10);
  expect(core.entryCost({ models }, null)).toBeNull();
  expect(core.entryCost({}, null)).toBeNull();
});

test("usablePricing: validates the contract", () => {
  expect(core.usablePricing(PRICING)).toBe(PRICING);
  expect(core.usablePricing(null)).toBeNull();
  // A euro table cannot price a run whose cost the runner reports in dollars.
  expect(core.usablePricing({ _currency: "€", "claude-opus-4-8": { in: 5 } })).toBeNull();
});

test("costOf: rejects a non-USD table and unusable rates", () => {
  const models = { "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } };
  expect(core.costOf(models, { ...PRICING, _currency: "€" })).toBeNull();
  // A negative or non-finite rate makes the run unpriceable, exactly as the runner
  // treats it; a coerced 0 would report the run as free.
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": { in: -5 } })).toBeNull();
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": { in: Number.NaN } })).toBeNull();
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": {} })).toBeNull();
});
