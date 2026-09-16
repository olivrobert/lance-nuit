// contracts/pricing.ts
//
// Rate table shapes and the pure pricing rules. This module is published as
// `lance-nuit/contracts` and installed as a DSL declaration: it has no runtime
// dependency and performs no I/O. Reading the kit chain and caching the result
// live in `env/pricing.ts`, which passes the layers back in through
// `mergePricingLayers`; the shape check lives in `env/pricing.schema.ts`, so
// that no `import "zod"` reaches a project that never installed it. `bun run
// lint` enforces both (`contracts-pure`, `contracts-no-platform`).
import type { ModelPricing } from "./backends.js";

export type ProjectPricing = Record<
  string,
  { in?: number; out?: number; cacheRead?: number; cacheWrite?: number } | string
>;

export interface TokenBreakdown {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_creation_tokens?: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

/** Kit-relative path of the rate table, the same under every kit root. */
export const PRICING_FILE = "pipeline-history/pricing.json";

/** Exact match first, then the longest candidate contained in the model name.
 *  Public because the statistics readers must resolve a rate the same way the
 *  runner does; two matchers would price the same run differently. */
export function matchingPricingKey(model: string, candidates: readonly string[]): string | undefined {
  const normalizedModel = model.toLowerCase();
  return (
    candidates.find((candidate) => candidate.toLowerCase() === normalizedModel) ??
    [...candidates]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => normalizedModel.includes(candidate.toLowerCase()))
  );
}

/**
 * Merge the layers of the rate table, in the order the kit chain yields them:
 * `~/.lance-nuit/pipeline-history/pricing.json` supplies machine-wide rates,
 * `<project>/.lance-nuit/pipeline-history/pricing.json` overrides them model by
 * model. Layers merge by key, like `config.json`: a project can reprice one
 * model without copying the shared table. A layer the caller could not read or
 * parse is passed as `null` and skipped; the result is `null` when no layer
 * holds a table.
 */
export function mergePricingLayers(layers: readonly (ProjectPricing | null)[]): ProjectPricing | null {
  let merged: ProjectPricing | null = null;
  for (const layer of layers) {
    if (!layer) continue;
    merged = { ...(merged ?? {}), ...layer };
  }
  return merged;
}

export function projectPricingForModel(model: string, table: ProjectPricing): ModelPricing | null {
  const currency = typeof table._currency === "string" ? table._currency : "$";
  if (currency !== "$") return null;
  const key = matchingPricingKey(
    model,
    Object.keys(table).filter((candidate) => candidate !== "_currency"),
  );
  const pricing = key ? table[key] : null;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return null;
  const values = [pricing.in, pricing.out, pricing.cacheRead, pricing.cacheWrite];
  if (
    !values.some((value) => value !== undefined) ||
    values.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
  ) {
    return null;
  }
  return {
    input: pricing.in ?? 0,
    output: pricing.out ?? 0,
    cache_read: pricing.cacheRead ?? 0,
    cache_write_5m: pricing.cacheWrite ?? 0,
    cache_write_1h: pricing.cacheWrite ?? 0,
  };
}

export function resolveModelPricing(
  model: string | undefined,
  table: PricingTable,
  fallbackKey?: string,
  projectPricing: ProjectPricing | null = null,
): ModelPricing | null {
  if (model && projectPricing) {
    const project = projectPricingForModel(model, projectPricing);
    if (project) return project;
  }
  if (model) {
    const key = matchingPricingKey(model, Object.keys(table));
    if (key) return table[key];
  }
  return fallbackKey ? (table[fallbackKey] ?? null) : null;
}

export function tokenCostUsd(breakdown: TokenBreakdown, pricing: ModelPricing, billedInputTokens: number): number {
  const cacheWrite5m = breakdown.cache_creation_5m_tokens ?? 0;
  const cacheWrite1h =
    breakdown.cache_creation_1h_tokens ?? Math.max(0, (breakdown.cache_creation_tokens ?? 0) - cacheWrite5m);
  return (
    (billedInputTokens * pricing.input +
      (breakdown.output_tokens ?? 0) * pricing.output +
      (breakdown.cache_read_tokens ?? 0) * pricing.cache_read +
      cacheWrite5m * pricing.cache_write_5m +
      cacheWrite1h * pricing.cache_write_1h) /
    1_000_000
  );
}
