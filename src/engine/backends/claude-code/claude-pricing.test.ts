import { expect, test } from "bun:test";
import type { ProjectPricing } from "../../../contracts/pricing.js";
import { computeCostUsd, contextWindow, DEFAULT_CONTEXT_WINDOW, MODEL_PRICING, pricingForModel } from "./pricing.js";

test("pricingForModel matches the model by substring (case-insensitive)", () => {
  expect(pricingForModel("claude-sonnet-4-6")).toBe(MODEL_PRICING.sonnet);
  expect(pricingForModel("CLAUDE-SONNET-4-6")).toBe(MODEL_PRICING.sonnet);
  expect(pricingForModel("claude-opus-4-8")).toBe(MODEL_PRICING.opus);
  expect(pricingForModel("claude-haiku-4-5")).toBe(MODEL_PRICING.haiku);
});

test("pricingForModel default = opus (most expensive) when unknown/absent", () => {
  expect(pricingForModel(undefined)).toBe(MODEL_PRICING.opus);
  expect(pricingForModel("gpt-4")).toBe(MODEL_PRICING.opus);
});

test("pricingForModel: project pricing.json has priority (exact key then substring)", () => {
  const table = {
    _currency: "$",
    "claude-opus-4-8": { in: 6, out: 30, cacheRead: 0.6, cacheWrite: 7.5 },
  };
  const p = pricingForModel("claude-opus-4-8", table);
  expect(p).toEqual({ input: 6, output: 30, cache_read: 0.6, cache_write_5m: 7.5, cache_write_1h: 7.5 });
  // pricing key contained in the model's full id
  expect(pricingForModel("claude-opus-4-8-20260101", table).output).toBe(30);
  expect(pricingForModel("CLAUDE-OPUS-4-8", table).output).toBe(30);
});

test("pricingForModel: model absent from project pricing.json → hardcoded rates", () => {
  const table = { _currency: "$", "claude-opus-4-8": { in: 6, out: 30, cacheRead: 0.6, cacheWrite: 7.5 } };
  expect(pricingForModel("claude-sonnet-4-6", table)).toBe(MODEL_PRICING.sonnet);
});

test("pricingForModel: non-USD pricing.json ignored (budget/estimate is in USD)", () => {
  const table = { _currency: "€", "claude-opus-4-8": { in: 6, out: 30, cacheRead: 0.6, cacheWrite: 7.5 } };
  expect(pricingForModel("claude-opus-4-8", table)).toBe(MODEL_PRICING.opus);
});

test("pricingForModel ignores malformed, negative, and non-finite project rates", () => {
  const malformed = { _currency: "$", opus: 1 } as unknown as ProjectPricing;
  const negative = { _currency: "$", opus: { in: -2 } } as ProjectPricing;
  const nonFinite = { _currency: "$", opus: { out: Number.NaN } } as ProjectPricing;
  expect(pricingForModel("opus", malformed)).toBe(MODEL_PRICING.opus);
  expect(pricingForModel("opus", negative)).toBe(MODEL_PRICING.opus);
  expect(pricingForModel("opus", nonFinite)).toBe(MODEL_PRICING.opus);
});

test("computeCostUsd applies cache-aware pricing ($/1M)", () => {
  // sonnet : in=3, out=15, cache_read=0.3, cache_write_5m=3.75, cache_write_1h=6
  const cost = computeCostUsd(
    {
      input_tokens: 17,
      output_tokens: 186,
      cache_read_tokens: 22855,
      cache_creation_1h_tokens: 1310,
    },
    "claude-sonnet-4-6",
  );
  const expected = (17 * 3 + 186 * 15 + 22855 * 0.3 + 1310 * 6) / 1_000_000;
  expect(cost).toBeCloseTo(expected, 8);
});

test("computeCostUsd: cache_creation_tokens without split treated as 1h", () => {
  const split = computeCostUsd({ cache_creation_1h_tokens: 1000 }, "sonnet");
  const combined = computeCostUsd({ cache_creation_tokens: 1000 }, "sonnet");
  expect(combined).toBeCloseTo(split, 8);
});

test("computeCostUsd never derives a negative 1h cache count from inconsistent counters", () => {
  const cost = computeCostUsd({ cache_creation_tokens: 100, cache_creation_5m_tokens: 200 }, "sonnet", null);
  expect(cost).toBeCloseTo((200 * 3.75) / 1_000_000, 8);
});

test("computeCostUsd: an empty breakdown costs 0", () => {
  expect(computeCostUsd({}, "opus")).toBe(0);
});

test("contextWindow: standard models = 200K", () => {
  expect(contextWindow("claude-sonnet-4-6")).toBe(200_000);
  expect(contextWindow("claude-opus-4-8")).toBe(200_000);
  expect(contextWindow("haiku")).toBe(200_000);
});

test("contextWindow: the 1M variants", () => {
  expect(contextWindow("claude-opus-4-8[1m]")).toBe(1_000_000);
  expect(contextWindow("sonnet[1m]")).toBe(1_000_000);
});

test("contextWindow: unknown/absent = default 200K", () => {
  expect(contextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindow("gpt-4")).toBe(200_000);
});
