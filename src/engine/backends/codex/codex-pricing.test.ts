import { expect, test } from "bun:test";
import { CODEX_MODEL_PRICING, computeCostUsd, MODEL_PRICING, pricingForModel } from "./pricing.js";
import { CODEX_MODEL } from "./types.js";

test("Codex pricing exposes the same model-table contract as Claude", () => {
  expect(CODEX_MODEL_PRICING).toBe(MODEL_PRICING);
  expect(pricingForModel(CODEX_MODEL.GPT_5_CODEX, null)).toBe(MODEL_PRICING[CODEX_MODEL.GPT_5_CODEX]);
  expect(pricingForModel("GPT-5.6-LUNA", null)).toBe(MODEL_PRICING[CODEX_MODEL.GPT_5_6_LUNA]);
});

test("Codex pricing does not bill an unknown model with another model's rate", () => {
  expect(pricingForModel(undefined, null)).toBeNull();
  expect(pricingForModel("future-codex-model", null)).toBeNull();
});

test("Codex project pricing has priority and keeps the shared USD rules", () => {
  const table = {
    _currency: "$",
    "gpt-5.6-luna": { in: 0.4, out: 2, cacheRead: 0.04, cacheWrite: 0.5 },
  };
  expect(pricingForModel("GPT-5.6-LUNA", table)).toEqual({
    input: 0.4,
    output: 2,
    cache_read: 0.04,
    cache_write_5m: 0.5,
    cache_write_1h: 0.5,
  });
  expect(pricingForModel(CODEX_MODEL.GPT_5_6_LUNA, { ...table, _currency: "€" })).toBe(
    MODEL_PRICING[CODEX_MODEL.GPT_5_6_LUNA],
  );
});

test("Codex cost removes cached input before applying the input rate", () => {
  const cost = computeCostUsd(
    {
      input_tokens: 1_000_000,
      cache_read_tokens: 800_000,
      output_tokens: 10,
    },
    CODEX_MODEL.GPT_5_6_LUNA,
    null,
  );
  expect(cost).toBeCloseTo((200_000 * 0.2 + 800_000 * 0.02 + 10 * 1.2) / 1_000_000, 8);
  expect(computeCostUsd({ output_tokens: 1_000_000 }, "future-codex-model", null)).toBeUndefined();
});
