// opencode prices come from the provider, per step (`step_finish.part.cost`).
//
// This module exists for the case that stream does NOT cover: a provider that
// reports tokens without a cost. It ships an EMPTY table and no fallback key on
// purpose — a wrong price presented as exact is worse than an admitted unknown,
// and the catalog spans several providers and changes weekly. Users who need an
// estimate declare their rates in `.lance-nuit/pipeline-history/pricing.json`.

import {
  type ModelPricing,
  type ProjectPricing,
  resolveModelPricing,
  type TokenBreakdown,
  tokenCostUsd,
} from "../../../contracts/index.js";
import { loadProjectPricing } from "../../../env/pricing.js";

export const MODEL_PRICING: Record<string, ModelPricing> = {};

export const OPENCODE_MODEL_PRICING = MODEL_PRICING;

export function pricingForModel(
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): ModelPricing | null {
  // No fallback key: an unknown model resolves to null, which surfaces as
  // `cost_unknown` downstream instead of the price of the most expensive model.
  return resolveModelPricing(model, MODEL_PRICING, undefined, projectPricing);
}

export function computeCostUsd(
  breakdown: TokenBreakdown,
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): number | undefined {
  const pricing = pricingForModel(model, projectPricing);
  if (!pricing) return undefined;
  // `tokens.input` and `tokens.cache.read` are disjoint: opencode's own cost is the
  // plain sum of the two at their own rates, and its `tokens.total` adds them.
  // Subtracting the cache here — as Codex requires, where `input_tokens` includes
  // it — would under-price every cached turn and let the live guard fire late.
  return tokenCostUsd(breakdown, pricing, breakdown.input_tokens ?? 0);
}

/** What one attempt really spent, and how well that number is known. */
export interface OpencodeCost {
  /** Undefined when nothing could price the run at all. */
  costUsd?: number;
  /** The number comes from `pricing.json`, not from the provider. */
  estimated: boolean;
  /** The number must not be presented — or budgeted — as exact. */
  unknown: boolean;
}

function totalTokens(breakdown: TokenBreakdown): number {
  return (
    (breakdown.input_tokens ?? 0) +
    (breakdown.output_tokens ?? 0) +
    (breakdown.cache_read_tokens ?? 0) +
    (breakdown.cache_creation_tokens ?? 0) +
    (breakdown.cache_creation_5m_tokens ?? 0) +
    (breakdown.cache_creation_1h_tokens ?? 0)
  );
}

/**
 * Reads the single cost of an attempt out of what the stream reported and what
 * the project declares.
 *
 * `step-finish.cost` is mandatory in the opencode stream, so its presence proves
 * nothing: opencode writes 0 whenever it cannot price the model (custom
 * provider, Copilot, Ollama, a model missing from models.dev). A reported 0 on a
 * run that burned tokens is therefore a gap, not a price — taking it as exact is
 * what made `max_cost_usd` unfirable and `pricing.json` unreachable on those
 * models. A truly free model has no `pricing.json` entry and stays at 0, marked
 * unknown rather than exact.
 */
export function resolveOpencodeCost(
  reported: { costReported: boolean; costUsd?: number },
  breakdown: TokenBreakdown,
  model?: string,
  projectPricing: ProjectPricing | null = loadProjectPricing(),
): OpencodeCost {
  const reportedCost = reported.costReported ? (reported.costUsd ?? 0) : undefined;
  if (reportedCost != null && (reportedCost > 0 || totalTokens(breakdown) === 0)) {
    return { costUsd: reportedCost, estimated: false, unknown: false };
  }
  const estimate = computeCostUsd(breakdown, model, projectPricing);
  if (estimate != null) return { costUsd: estimate, estimated: true, unknown: false };
  // Keep the reported 0 as the amount — it is the best available — but never as
  // an exact one, so the run reports an unaccounted spend instead of a free one.
  return { ...(reportedCost != null ? { costUsd: reportedCost } : {}), estimated: false, unknown: true };
}
