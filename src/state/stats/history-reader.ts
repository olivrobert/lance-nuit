// history-reader — cross-run reader over the central `pipeline-history/runs.jsonl`.
//
// The sink writes one logical line per run and `stats-core.ts` renders a single
// entry; nothing read the projection across runs, so the questions the history was
// built to answer ("what did this pipeline cost", "which phase keeps failing")
// could not be asked. This module is that reader: filter, aggregate, render.
//
// Two invariants shape it:
//  - A child run is emitted to the history too (pipeline-orchestration-child), and
//    its usage is already folded into its parent's step control. Summing every line
//    therefore counts the same spend twice, so aggregation keeps root runs only
//    unless the caller asks for children explicitly.
//  - Cost is exact when the runner wrote `costUsd`, estimated from `pricing.json`
//    otherwise, and simply absent when neither applies. An absent cost is reported
//    as such rather than silently read as zero.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectPricing } from "../../env/pricing.js";
import { HistoryEntrySchema } from "./history-schema.js";
import type { RunStatsEntry } from "./run-stats-projector.js";
import { addTokens, entryCost, type PricingTable, type TokenCounts, zeroTokens } from "./stats-core.js";

/** Entry as read back from disk: every field is suspect, including the ones the
 *  projector always writes, because a line may predate a schema addition. The
 *  type stays hand-written; `history-schema.ts` proves it agrees with the schema
 *  that guards `readHistory`. */
export type HistoryEntry = Partial<RunStatsEntry> & { runId: string };

export interface HistoryFilter {
  /** Keep a single pipeline (exact name). */
  pipeline?: string;
  /** Keep a single work item (exact id). */
  ticket?: string;
  /** Keep runs started at or after this epoch milliseconds. */
  sinceMs?: number;
  /** Keep only runs that did not pass. */
  failuresOnly?: boolean;
  /** Keep nested child runs, whose usage the parent already accounts for. */
  includeChildren?: boolean;
}

export interface ProfileTotals {
  steps: number;
  tokens: TokenCounts;
  costUsd: number;
}

export interface PipelineTotals {
  runs: number;
  byStatus: Record<string, number>;
  tokens: TokenCounts;
  costUsd: number;
  /** Runs whose cost is neither written nor estimable; they are excluded from `costUsd`. */
  costMissing: number;
  /** Runs whose cost comes from `pricing.json` rather than the provider. */
  costEstimated: number;
  /** Runs counted in `costUsd` whose figure is a lower bound: an attempt spent
   *  tokens no pricing table could price. */
  costUnderCounted: number;
  durationMs: number;
  /** Runs with both timestamps, hence the divisor for an average duration. */
  durationSamples: number;
}

export interface HistoryAggregate {
  runs: number;
  byStatus: Record<string, number>;
  tokens: TokenCounts;
  costUsd: number;
  costMissing: number;
  costEstimated: number;
  costUnderCounted: number;
  byPipeline: Record<string, PipelineTotals>;
  byProfile: Record<string, ProfileTotals>;
  byFailPhase: Record<string, number>;
  /** Root runs skipped as children; reported so a surprising total is explainable. */
  childrenSkipped: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
}

export function historyPath(projRoot: string = process.cwd()): string {
  return join(projRoot, ".lance-nuit", "pipeline-history", "runs.jsonl");
}

/**
 * Read every usable line of the history, newest run first.
 *
 * Malformed lines are skipped rather than fatal: the sink deliberately preserves
 * lines it cannot parse, so a reader that threw on one would lose the whole file
 * over a single truncated write.
 */
export function readHistory(projRoot: string = process.cwd()): HistoryEntry[] {
  let raw: string;
  try {
    raw = readFileSync(historyPath(projRoot), "utf-8");
  } catch {
    // A missing history is the normal case before the first run completes.
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // The schema replaces the hand-written guard; the policy is unchanged. A line
    // whose shape contradicts it is skipped rather than raised, and
    // `diagnoseHistoryEntry` carries the reason for a tool that wants to show it.
    const result = HistoryEntrySchema.safeParse(parsed);
    if (!result.success) continue;
    entries.push(result.data);
  }

  return entries.sort((a, b) => startedMs(b) - startedMs(a));
}

/** Epoch milliseconds of a run's start; 0 when unknown, which sorts it last. */
function startedMs(entry: HistoryEntry): number {
  if (!entry.startedAt) return 0;
  const parsed = Date.parse(entry.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(entry: HistoryEntry): number | null {
  if (!entry.startedAt || !entry.endedAt) return null;
  const started = Date.parse(entry.startedAt);
  const ended = Date.parse(entry.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

/** A line written before `parentRunId` existed carries no nesting information, so
 *  it is read as a root run — the shape the reader assumed before the field. */
function isChild(entry: HistoryEntry): boolean {
  return typeof entry.parentRunId === "string" && entry.parentRunId.length > 0;
}

export function filterHistory(entries: readonly HistoryEntry[], filter: HistoryFilter = {}): HistoryEntry[] {
  return entries.filter((entry) => {
    if (!filter.includeChildren && isChild(entry)) return false;
    if (filter.pipeline && entry.pipeline !== filter.pipeline) return false;
    if (filter.ticket && entry.ticket !== filter.ticket) return false;
    if (filter.failuresOnly && entry.status === "PASS") return false;
    if (filter.sinceMs !== undefined) {
      const started = startedMs(entry);
      // A run with no usable timestamp cannot be placed in the window; excluding it
      // keeps `--since` from quietly widening to undated lines.
      if (started === 0 || started < filter.sinceMs) return false;
    }
    return true;
  });
}

function emptyPipelineTotals(): PipelineTotals {
  return {
    runs: 0,
    byStatus: {},
    tokens: zeroTokens(),
    costUsd: 0,
    costMissing: 0,
    costEstimated: 0,
    costUnderCounted: 0,
    durationMs: 0,
    durationSamples: 0,
  };
}

/**
 * Roll a filtered set of entries up into per-pipeline, per-profile, and
 * per-failure-phase totals.
 *
 * `childrenSkipped` counts nested runs dropped from the input, so `stats` can say
 * why its total is lower than the raw line count.
 */
export function aggregateHistory(
  entries: readonly HistoryEntry[],
  pricing: PricingTable | null = null,
  childrenSkipped = 0,
): HistoryAggregate {
  const aggregate: HistoryAggregate = {
    runs: 0,
    byStatus: {},
    tokens: zeroTokens(),
    costUsd: 0,
    costMissing: 0,
    costEstimated: 0,
    costUnderCounted: 0,
    byPipeline: {},
    byProfile: {},
    byFailPhase: {},
    childrenSkipped,
    firstStartedAt: null,
    lastStartedAt: null,
  };

  for (const entry of entries) {
    const pipeline = entry.pipeline || "(unknown)";
    const status = entry.status || "UNKNOWN";
    aggregate.byPipeline[pipeline] ??= emptyPipelineTotals();
    const perPipeline = aggregate.byPipeline[pipeline];

    aggregate.runs += 1;
    aggregate.byStatus[status] = (aggregate.byStatus[status] ?? 0) + 1;
    perPipeline.runs += 1;
    perPipeline.byStatus[status] = (perPipeline.byStatus[status] ?? 0) + 1;

    addTokens(aggregate.tokens, entry.totals);
    addTokens(perPipeline.tokens, entry.totals);

    // Pass only the two fields the cost rule reads, rather than the whole entry:
    // `entryCost` accepts a structural subset, and narrowing here keeps a future
    // `RunStatsEntry` field from making a read-back line unassignable.
    const cost = entryCost({ models: entry.models, costUsd: entry.costUsd }, pricing);
    if (cost === null) {
      aggregate.costMissing += 1;
      perPipeline.costMissing += 1;
    } else {
      aggregate.costUsd += cost;
      perPipeline.costUsd += cost;
      // `costUsd` is exact only when the runner said so: a figure derived here
      // from pricing.json, or one the runner itself computed from a rate table
      // (`costStatus: "partial"` — Codex, opencode without a provider cost, a killed
      // Claude attempt), is an estimate, and a total mixing the two must say so.
      if (typeof entry.costUsd !== "number" || entry.costStatus === "partial") {
        aggregate.costEstimated += 1;
        perPipeline.costEstimated += 1;
      }
      // The runner's own figure can still be a lower bound: an attempt it could
      // not price is in the tokens but not in the dollars.
      if (entry.costUnknown === true) {
        aggregate.costUnderCounted += 1;
        perPipeline.costUnderCounted += 1;
      }
    }

    const elapsed = durationMs(entry);
    if (elapsed !== null) {
      perPipeline.durationMs += elapsed;
      perPipeline.durationSamples += 1;
    }

    for (const [role, usage] of Object.entries(entry.profiles ?? {})) {
      aggregate.byProfile[role] ??= { steps: 0, tokens: zeroTokens(), costUsd: 0 };
      const perProfile = aggregate.byProfile[role];
      perProfile.steps += usage?.steps ?? 0;
      addTokens(perProfile.tokens, usage?.tokens);
      perProfile.costUsd += usage?.costUsd ?? 0;
    }

    if (status !== "PASS") {
      const phase = entry.failPhase || "(unknown)";
      aggregate.byFailPhase[phase] = (aggregate.byFailPhase[phase] ?? 0) + 1;
    }

    if (entry.startedAt && startedMs(entry) !== 0) {
      if (!aggregate.firstStartedAt || entry.startedAt < aggregate.firstStartedAt) {
        aggregate.firstStartedAt = entry.startedAt;
      }
      if (!aggregate.lastStartedAt || entry.startedAt > aggregate.lastStartedAt) {
        aggregate.lastStartedAt = entry.startedAt;
      }
    }
  }

  return aggregate;
}

/**
 * `pricing.json` as the cost helpers want it.
 *
 * `ProjectPricing` types every key, `_currency` included, as a rate or a string,
 * while `PricingTable` declares `_currency` as a string. The two describe the same
 * file; this is the one place that reconciles them.
 *
 * A non-USD table is dropped, exactly as the runtime drops it: the runner's
 * `costUsd` is always in dollars, so estimating the other runs in euros and adding
 * the two would print a total in no currency at all.
 */
export function pricingTable(loaded = loadProjectPricing()): PricingTable | null {
  if (!loaded) return null;
  const currency = typeof loaded._currency === "string" ? loaded._currency : "$";
  return currency === "$" ? (loaded as PricingTable) : null;
}

/** Read, filter, and aggregate in one call; the reader's normal entry point. */
export function summarizeHistory(
  projRoot: string = process.cwd(),
  filter: HistoryFilter = {},
  pricing: PricingTable | null = pricingTable(),
): { entries: HistoryEntry[]; aggregate: HistoryAggregate } {
  const all = readHistory(projRoot);
  const entries = filterHistory(all, filter);
  // Count the children the same filter would otherwise have kept, so the reported
  // number explains this summary rather than the whole file.
  const childrenSkipped = filter.includeChildren
    ? 0
    : filterHistory(all, { ...filter, includeChildren: true }).length - entries.length;
  return { entries, aggregate: aggregateHistory(entries, pricing, childrenSkipped) };
}
