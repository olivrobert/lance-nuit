// stats-core — single source for the run-stats schema, its token arithmetic,
// and the cost and labels the history readers print.
//
// Shape of an entry in the central pipeline-history/runs.jsonl projection:
//   { runId, pipeline, ticket, ticketDir, sessionId, startedAt, endedAt,
//     status, failPhase, phases: { <phase>: { agents, fixLoops, tokens } },
//     totals: { in, out, cacheRead, cacheWrite }, models: { <model-id>: tokens },
//     profiles: { <role>: { steps, tokens, costUsd? } },
//     lot, lotTitle, commit, fixEvents: [{ kind, phase, iter, contract, details }],
//     costUsd? }   <- written by the runner (exact CLI cost); estimated from
//                    pricing.json when absent.

import { projectPricingForModel, tokenCostUsd } from "../contracts/pricing.js";
import type { RunOutcomeState } from "../model/persisted.js";

export interface TokenCounts {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Keep counters numeric so persisted stats stay comparable. The status distinguishes a
 * real zero from a backend interrupted before its usage event. */
export type UsageStatus = "complete" | "partial" | "unavailable";

export interface PhaseStats {
  agents: number;
  fixLoops: number;
  tokens: TokenCounts;
  provider?: string;
  profile?: string;
  costUsd?: number;
  usageStatus?: UsageStatus;
  costStatus?: UsageStatus;
  /** An attempt spent tokens no pricing table could price: `costUsd` is a lower
   *  bound, not an estimate. Distinct from `costStatus`, which a Codex run sets
   *  on every step because its cost is always computed from a rate table. */
  costUnknown?: true;
}

export interface RunStatsEntry {
  schemaVersion: 1;
  runId: string;
  pipeline: string;
  ticket: string | null;
  ticketDir: string | null;
  /** Run that nested this one, null for a root run. A child's usage is folded into
   *  its parent's step control, so a reader summing the history must keep only root
   *  runs or it counts the same spend twice. Absent on lines written before this
   *  field existed; such a line is read as a root run. */
  parentRunId?: string | null;
  /** Lot bounding this run; null for parent and non-feature pipelines. */
  lot?: string | null;
  lotTitle?: string | null;
  sessionId: string | null;
  sessionProvider?: string;
  startedAt: string | null;
  endedAt: string | null;
  status: "PASS" | "FAIL" | "STOPPED" | "ABORTED" | "UNKNOWN";
  outcome: RunOutcomeState;
  failPhase: string | null;
  failReason: string | null;
  phases: Record<string, PhaseStats>;
  totals: TokenCounts;
  usageStatus?: UsageStatus;
  costStatus?: UsageStatus;
  /** Set when the run's total is a lower bound (`costIsLowerBound`: a step is
   *  `costUnknown`, or the run latched unpriced spend): the run's `costUsd`
   *  under-counts the real spend and a reader must not present it as exact. */
  costUnknown?: true;
  models: Record<string, TokenCounts>;
  profiles: Record<string, { steps: number; tokens: TokenCounts; costUsd?: number }>;
  commit: string | null;
  branch: string | null;
  fixEvents: unknown[];
  sourceRunDir: string | null;
  warnings?: Array<{ phase: string; reason: string }>;
  costUsd?: number;
}

export interface PricingRate {
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// `_currency` shares the table with per-model rates; readers must skip
// non-object values when iterating models.
export type PricingTable = { _currency?: string } & {
  [model: string]: PricingRate | string;
};

/** What `entryCost` reads of a history entry. */
export interface CostedEntry {
  models?: Record<string, TokenCounts>;
  costUsd?: number;
}

export const zeroTokens = (): TokenCounts => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

// Add two counters already using the internal {in, out, cacheRead, cacheWrite} format.
export const addTokens = (acc: TokenCounts, t?: Partial<TokenCounts> | null): void => {
  for (const k of Object.keys(acc) as Array<keyof TokenCounts>) acc[k] += t?.[k] || 0;
};

export const fmtInt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Console badge of a history status; a status this runner does not know is
 *  printed as it was recorded. */
const STATUS_BADGES: Readonly<Record<string, string>> = {
  PASS: "✅ PASS",
  FAIL: "❌ FAIL",
  STOPPED: "⏹ STOPPED",
  ABORTED: "🛑 ABORTED",
};

export const statusBadge = (s?: string): string =>
  s !== undefined && Object.hasOwn(STATUS_BADGES, s) ? (STATUS_BADGES[s] as string) : `⚪ ${s || "?"}`;

// Symbol displayed before amounts; pricing.json rates use the
// currency entered by the project ("_currency": "€" for euro pricing), default "$".
// Read as `pricingTable()` and the runner's rate lookup read it, so an empty
// string is a currency other than the dollar there and here alike.
export const currencyOf = (pricing?: PricingTable | null): string =>
  pricing && typeof pricing._currency === "string" ? pricing._currency : "$";

/**
 * A pricing table these helpers may actually use, or null.
 *
 * A non-USD table is dropped exactly as `pricingTable()` drops it at the command
 * boundary: the runner's `costUsd` is always in dollars and takes precedence over
 * any estimate, so keeping a euro table would label dollar amounts "€". `costOf`
 * funnels through here, so a direct caller cannot reintroduce the mismatch.
 */
export const usablePricing = (pricing?: PricingTable | null): PricingTable | null =>
  pricing && currencyOf(pricing) === "$" ? pricing : null;

const spentTokens = (t: TokenCounts): number => (t.in || 0) + (t.out || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);

// Cost of a run from its model breakdown. Prices are never hardcoded because they
// change; use the project's pricing.json, otherwise leave the cost absent (null).
//
// The rate lookup and the formula are the runner's (`contracts/pricing.ts`): a
// second copy here priced the same run differently whenever one of them changed.
// `in` is billed as is: every backend stores the non-cached input there (Codex is
// normalized where its result is mapped), so cached reads are billed once, through
// `cacheRead`.
//
// A model the table cannot price makes the whole run unpriceable, not cheaper: a
// silent skip returned $0.00 for a table that simply did not list the model, and
// the run then read as "priced, estimated" in every total.
export function costOf(models?: Record<string, TokenCounts> | null, pricing?: PricingTable | null): number | null {
  const table = usablePricing(pricing);
  if (!table) return null;
  let usd = 0;
  let unpriced = 0;
  for (const [model, t] of Object.entries(models || {})) {
    const rate = projectPricingForModel(model, table);
    if (!rate) {
      // A model with no tokens costs nothing whether or not it is listed.
      if (spentTokens(t) > 0) unpriced += 1;
      continue;
    }
    usd += tokenCostUsd(
      { output_tokens: t.out, cache_read_tokens: t.cacheRead, cache_creation_tokens: t.cacheWrite },
      rate,
      t.in,
    );
  }
  return unpriced > 0 ? null : usd;
}

// Entry cost: costUsd written by the runner (the exact Claude CLI cost, including
// subagents) takes precedence over the token × pricing estimate.
export function entryCost(entry: CostedEntry | null | undefined, pricing?: PricingTable | null): number | null {
  if (entry && typeof entry.costUsd === "number") return entry.costUsd;
  return costOf(entry?.models, pricing);
}
