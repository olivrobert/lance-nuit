import {
  type ModelPricing,
  type ProjectPricing,
  resolveModelPricing,
  type TokenBreakdown,
  tokenCostUsd,
} from "../../../contracts/index.js";
import { loadProjectPricing } from "../../../env/pricing.js";
import { CODEX_MODEL } from "./types.js";

export const MODEL_PRICING: Record<string, ModelPricing> = {
  [CODEX_MODEL.GPT_5_CODEX]: { input: 1.25, output: 10, cache_read: 0.125, cache_write_5m: 0, cache_write_1h: 0 },
  [CODEX_MODEL.GPT_5_6_LUNA]: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write_5m: 0.25, cache_write_1h: 0.25 },
};

export const CODEX_MODEL_PRICING = MODEL_PRICING;

export function pricingForModel(
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): ModelPricing | null {
  return resolveModelPricing(model, MODEL_PRICING, undefined, projectPricing);
}

export function computeCostUsd(
  breakdown: TokenBreakdown,
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): number | undefined {
  const pricing = pricingForModel(model, projectPricing);
  if (!pricing) return undefined;
  const billedInputTokens = Math.max(0, (breakdown.input_tokens ?? 0) - (breakdown.cache_read_tokens ?? 0));
  return tokenCostUsd(breakdown, pricing, billedInputTokens);
}
