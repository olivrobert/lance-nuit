// stats-core — single source for the run-stats schema, its token arithmetic,
// and the labels the history readers print.
//
// Shape of an entry in the central pipeline-history/runs.jsonl projection:
//   { runId, pipeline, ticket, ticketDir, sessionId, startedAt, endedAt,
//     status, failPhase, phases: { <phase>: { agents, fixLoops, tokens } },
//     totals: { in, out, cacheRead, cacheWrite }, models: { <model-id>: tokens },
//     profiles: { <role>: { steps, tokens, costUsd? } },
//     lot, lotTitle, commit, fixEvents: [{ kind, phase, iter, contract, details }],
//     costUsd? }   <- the run's `runSpend` when the line was written; absent when
//                    nothing priced it.

import type { RunOutcomeState } from "../persisted.js";

export interface TokenCounts {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Keep counters numeric so persisted stats stay comparable. The status distinguishes a
 * real zero from a backend interrupted before its usage event. */
export type UsageStatus = "partial" | "unavailable";

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
