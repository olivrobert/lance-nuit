import {
  type ModelPricing,
  type ProjectPricing,
  resolveModelPricing,
  type TokenBreakdown,
  tokenCostUsd,
} from "../../../contracts/index.js";
import { loadProjectPricing } from "../../../env/pricing.js";
export const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
  haiku: { input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
};
export const DEFAULT_PRICING_KEY = "opus";
export function pricingForModel(
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): ModelPricing {
  return (
    resolveModelPricing(model, MODEL_PRICING, DEFAULT_PRICING_KEY, projectPricing) ?? MODEL_PRICING[DEFAULT_PRICING_KEY]
  );
}
export function computeCostUsd(
  breakdown: TokenBreakdown,
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): number {
  return tokenCostUsd(breakdown, pricingForModel(model, projectPricing), breakdown.input_tokens ?? 0);
}
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export function contextWindow(model?: string): number {
  return model?.toLowerCase().includes("1m") ? 1_000_000 : DEFAULT_CONTEXT_WINDOW;
}
