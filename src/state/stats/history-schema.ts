// state/stats/history-schema.ts
//
// Runtime schema of one line of the central history (`pipeline-history/runs.jsonl`).
//
// The interfaces in `run-stats-projector.ts` and `stats-core.ts` stay the
// authoritative types: this module imports them and proves, at compile time,
// that the schema output is assignable to `HistoryEntry` (and `HistoryEntry` to
// the schema input, so any line the sink can write stays readable). No
// public type is inferred from a schema, and nothing the installed DSL
// declarations reach may import this module — `zod` would then leak into
// projects that never installed it. See `guide/architecture.md`, section
// "Persistence and observability".
//
// Diagnostic policy for this boundary: a line that fails the schema is NOT an
// error to raise. `readHistory` skips it and keeps reading, exactly as the
// hand-written guard did — the sink deliberately preserves lines it cannot
// parse, and a reader that threw would lose the whole file over one truncated
// write. `diagnoseHistoryEntry` exposes the reason for tools that want it.
//
// What stays out of the schema (and in code, in `history-reader.ts`):
// - timestamp arithmetic: the schema checks that `startedAt` is a string, the
//   reader decides what an unparsable date means (sorted last, excluded from
//   `--since`);
// - the reading of an absent field: `parentRunId` missing means "root run",
//   `costUsd` missing means "estimate from pricing.json or report as missing";
// - every aggregation rule (child accounting, cost exactness, fail phases).
// Rule of thumb: the schema judges one line on its own; anything needing a
// second source of truth, or a policy, is code.

import * as z from "zod";
import { FAIL_CAUSES } from "../../contracts/backends.js";
import type { StepFailKind } from "../../contracts/backends.js";
import type { AssertAssignable, Plain } from "../../lib/type-assertions.js";
import type { RunOutcomeState, RunOutcomeStopKind, RunStopKind, RunStopState } from "../../model/persisted.js";
import type { PhaseStats, RunStatsEntry, UsageStatus } from "./run-stats-projector.js";
import type { TokenCounts } from "./stats-core.js";

/* ------------------------------------------------------------------------- *
 * Compatibility rules
 *
 * - Every object is `looseObject`: a field added by a later release must not
 *   make the line unreadable by an earlier one, and vice versa.
 * - Every field is optional but `runId`, because `HistoryEntry` is
 *   `Partial<RunStatsEntry> & { runId: string }`: a line may predate any schema
 *   addition, and the reader already treats each field as suspect.
 * - A field of the wrong kind, or an enumerated value this release does not
 *   know, reads as ABSENT (`tolerant`): the line is kept and aggregated on what
 *   it still says. Dropping it would silently under-report the spend of a run
 *   written by a newer runner, which is worse than showing that run with an
 *   unknown status. Only `runId` decides whether a line is a run at all — the
 *   same rule the backend NDJSON schemas apply to a provider stream.
 * ------------------------------------------------------------------------- */

const USAGE_STATUSES = ["complete", "partial", "unavailable"] as const satisfies readonly UsageStatus[];
const RUN_STATS_STATUSES = [
  "PASS",
  "FAIL",
  "STOPPED",
  "ABORTED",
  "UNKNOWN",
] as const satisfies readonly RunStatsEntry["status"][];
const STOP_KINDS = ["needs-info", "needs-decision", "needs-human", "blocked"] as const satisfies readonly RunStopKind[];
const FAIL_KINDS = ["verdict", "technical"] as const satisfies readonly StepFailKind[];
const OUTCOME_STOP_KINDS = ["budget-exceeded", "cost-unaccounted"] as const satisfies readonly RunOutcomeStopKind[];

/** Wrong kind or unknown value → absent; the line survives. */
const tolerant = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const nullableString = z.string().nullable();
const optionalNullableString = tolerant(nullableString);
const optionalString = tolerant(z.string());
const optionalNumber = tolerant(z.number());

const TokenCountsSchema = z.looseObject({
  in: z.number(),
  out: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

const RunStopStateSchema = z.looseObject({
  subject: optionalString,
  kind: tolerant(z.enum(STOP_KINDS)),
  detail: z.string(),
});

const RunOutcomeStateSchema = z.looseObject({
  phase: nullableString,
  reason: nullableString,
  logPath: nullableString,
  resumable: z.boolean(),
  failKind: tolerant(z.enum(FAIL_KINDS)),
  failCause: tolerant(z.enum(FAIL_CAUSES)),
  at: optionalString,
  stop: tolerant(RunStopStateSchema),
  stopKind: tolerant(z.enum(OUTCOME_STOP_KINDS)),
});

const PhaseStatsSchema = z.looseObject({
  agents: z.number(),
  fixLoops: z.number(),
  tokens: TokenCountsSchema,
  provider: optionalString,
  profile: optionalString,
  costUsd: optionalNumber,
  usageStatus: tolerant(z.enum(USAGE_STATUSES)),
  costStatus: tolerant(z.enum(USAGE_STATUSES)),
  costUnknown: tolerant(z.literal(true)),
});

const ProfileTotalsSchema = z.looseObject({
  steps: z.number(),
  tokens: TokenCountsSchema,
  costUsd: optionalNumber,
});

const WarningSchema = z.looseObject({
  phase: z.string(),
  reason: z.string(),
});

/** One line of `runs.jsonl`. `runId` is the only identity the reader requires;
 * a line without one names no run and cannot be aggregated. Every other field
 * is tolerant: unreadable means absent, never "drop the line". */
export const HistoryEntrySchema = z.looseObject({
  schemaVersion: tolerant(z.literal(1)),
  runId: z.string().min(1),
  pipeline: optionalString,
  ticket: optionalNullableString,
  ticketDir: optionalNullableString,
  parentRunId: optionalNullableString,
  lot: optionalNullableString,
  lotTitle: optionalNullableString,
  sessionId: optionalNullableString,
  sessionProvider: optionalString,
  startedAt: optionalNullableString,
  endedAt: optionalNullableString,
  status: tolerant(z.enum(RUN_STATS_STATUSES)),
  outcome: tolerant(RunOutcomeStateSchema),
  failPhase: optionalNullableString,
  failReason: optionalNullableString,
  phases: tolerant(z.record(z.string(), PhaseStatsSchema)),
  totals: tolerant(TokenCountsSchema),
  usageStatus: tolerant(z.enum(USAGE_STATUSES)),
  costStatus: tolerant(z.enum(USAGE_STATUSES)),
  costUnknown: tolerant(z.literal(true)),
  models: tolerant(z.record(z.string(), TokenCountsSchema)),
  profiles: tolerant(z.record(z.string(), ProfileTotalsSchema)),
  commit: optionalNullableString,
  branch: optionalNullableString,
  fixEvents: tolerant(z.array(z.unknown())),
  sourceRunDir: optionalNullableString,
  warnings: tolerant(z.array(WarningSchema)),
  costUsd: optionalNumber,
});

/** Entry as read back from disk, before the reader applies its own policies. */
export type HistoryEntryInput = z.input<typeof HistoryEntrySchema>;

/** Human-readable reason a value is not a usable history line (not an object,
 * or no `runId`), or undefined when it is. A field that merely reads as absent
 * is not a reason: the line is usable. Not used by `readHistory`, which stays
 * silent by contract. */
export function diagnoseHistoryEntry(value: unknown): string | undefined {
  const result = HistoryEntrySchema.safeParse(value);
  return result.success ? undefined : z.prettifyError(result.error);
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the interfaces describe the same data
 * (see `lib/type-assertions.ts`).
 * ------------------------------------------------------------------------- */

type HistoryEntryShape = Partial<RunStatsEntry> & { runId: string };

type _OutputIsEntry = AssertAssignable<z.output<typeof HistoryEntrySchema>, HistoryEntryShape>;
type _EntryIsInput = AssertAssignable<Plain<HistoryEntryShape>, z.input<typeof HistoryEntrySchema>>;
type _Tokens = AssertAssignable<z.output<typeof TokenCountsSchema>, TokenCounts>;
type _Phase = AssertAssignable<z.output<typeof PhaseStatsSchema>, PhaseStats>;
type _Outcome = AssertAssignable<z.output<typeof RunOutcomeStateSchema>, RunOutcomeState>;
type _Stop = AssertAssignable<z.output<typeof RunStopStateSchema>, RunStopState>;
