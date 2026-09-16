// state/schema.ts
//
// Runtime schema of the persisted run snapshot (`state.json`).
//
// The interfaces in `model/persisted.ts` stay the public, authoritative types:
// that module ships in the installed DSL declarations. This module imports them
// and proves, at compile time, that the schema output is assignable to them (and
// the interfaces to the schema input). It must never be imported by a file that
// the DSL declarations reach, otherwise `zod` would leak into projects that do
// not install it. See `guide/architecture.md`, section
// "Persistence and observability".
//
// Diagnostic policy for this boundary: a snapshot that fails the schema is NOT an
// error to raise. Readers (`readRunSnapshot`, catalogs, the UI) treat it as
// absent and move on, exactly as they did with the hand-written guard. The
// diagnostic is available separately for tools that want to display it.

import * as z from "zod";
import { FAIL_CAUSES } from "../contracts/backends.js";
import type { AgentSession, StepControl, StepFailKind, StepUsage } from "../contracts/backends.js";
import type { AssertAssignable, Plain } from "../lib/type-assertions.js";
import type { PipelineLot } from "../model/context.js";
import type {
  PersistedPipelineChildRef,
  PersistedPipelineOrchestrationState,
  PersistedRun,
  PersistedStepState,
  PipelineLineageEntry,
  RunOutcomeState,
  RunOutcomeStopKind,
  RunStatus,
  RunStopKind,
  RunStopState,
  StepStatus,
} from "../model/persisted.js";
import { isStepProfileName, STEP_PROFILE_NAMES, type StepProfileName } from "../model/profiles.js";

/* ------------------------------------------------------------------------- *
 * Compatibility rules
 *
 * - Persisted objects are `looseObject`: a field added by a later release must
 *   not make the snapshot unreadable by an earlier one, and vice versa.
 * - Every field the interface marks optional is optional here, including the
 *   ones a current release always writes.
 * - `retries` is optional on disk and normalized to 0 when absent: the persisted
 *   shape (`z.input`) is what the disk may hold, the normalized shape
 *   (`z.output`) is what readers consume.
 * ------------------------------------------------------------------------- */

/** Shared with `state/journal-schema.ts`: the journal records the same statuses. */
export const RUN_STATUSES = [
  "RUNNING",
  "PASS",
  "FAIL",
  "STOPPED",
  "ABORTED",
  "UNKNOWN",
] as const satisfies readonly RunStatus[];
export const STEP_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
  "aborted",
] as const satisfies readonly StepStatus[];
const STOP_KINDS = ["needs-info", "needs-decision", "needs-human", "blocked"] as const satisfies readonly RunStopKind[];
const FAIL_KINDS = ["verdict", "technical"] as const satisfies readonly StepFailKind[];
const OUTCOME_STOP_KINDS = ["budget-exceeded", "cost-unaccounted"] as const satisfies readonly RunOutcomeStopKind[];
// Roles are closed (`StepProfileName`). Removing a name from STEP_PROFILE_NAMES
// makes snapshots that used it unreadable: such a removal needs a migration here.
// The list comes from `model/profiles.ts`, a leaf module free of any cycle with
// the run stores, so it is read eagerly. `z.custom` rather than `z.enum` only to
// spell the accepted names in the message, as `env/config.schema.ts` does.
const profileName = z.custom<StepProfileName>((value) => typeof value === "string" && isStepProfileName(value), {
  error: () => `unknown profile (expected: ${STEP_PROFILE_NAMES.join(", ")})`,
});

const nonNegativeInt = z.number().int().nonnegative();

export const AgentSessionSchema = z.looseObject({
  provider: z.string(),
  id: z.string(),
  resumable: z.boolean(),
});

export const StepControlSchema = z.looseObject({
  duration_ms: z.number(),
  total_cost_usd: z.number().optional(),
  cost_estimated: z.boolean().optional(),
  cost_unknown: z.boolean().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  last_turn_context_tokens: z.number().optional(),
  context_window: z.number().optional(),
});

export const StepUsageSchema = z.looseObject({
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cache_creation_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  tools_used: z.array(z.string()).optional(),
});

export const RunStopStateSchema = z.looseObject({
  subject: z.string().optional(),
  kind: z.enum(STOP_KINDS).optional(),
  detail: z.string(),
});

export const RunOutcomeStateSchema = z.looseObject({
  phase: z.string().nullable(),
  reason: z.string().nullable(),
  logPath: z.string().nullable(),
  resumable: z.boolean(),
  failKind: z.enum(FAIL_KINDS).optional(),
  failCause: z.enum(FAIL_CAUSES).optional(),
  at: z.string().optional(),
  stop: RunStopStateSchema.optional(),
  stopKind: z.enum(OUTCOME_STOP_KINDS).optional(),
});

const PipelineLineageEntrySchema = z.looseObject({
  pipelinePath: z.string(),
  ticket: z.string().optional(),
});

const PipelineLotSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  risk: z.number(),
  steps: z.array(z.number()),
  dependsOn: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});

const PersistedPipelineChildRefSchema = z.looseObject({
  key: z.string(),
  kind: z.enum(["main", "afterEach", "afterAll"]),
  pipeline: z.string(),
  ticket: z.string().optional(),
  lot: PipelineLotSchema.optional(),
  runId: z.string().optional(),
  status: z.enum(["pending", "running", "done", "failed", "skipped"]),
  accountedCostUsd: z.number(),
  accountedDurationMs: z.number().optional(),
  accountedUsage: StepUsageSchema.optional(),
  outcome: RunOutcomeStateSchema.optional(),
});

const PersistedPipelineOrchestrationStateSchema = z.looseObject({
  kind: z.enum(["runPipeline", "forEachPipeline"]),
  items: z.array(z.string()).optional(),
  children: z.array(PersistedPipelineChildRefSchema),
});

export const PersistedStepStateSchema = z.looseObject({
  id: z.string().min(1),
  status: z.enum(STEP_STATUSES),
  retries: nonNegativeInt.default(0),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  session: AgentSessionSchema.optional(),
  profile: profileName.optional(),
  control: StepControlSchema.optional(),
  usage: StepUsageSchema.optional(),
  errors: z.string().optional(),
  fail_kind: z.enum(FAIL_KINDS).optional(),
  fail_cause: z.enum(FAIL_CAUSES).optional(),
  timeout_retries: nonNegativeInt.optional(),
  last_attempt: nonNegativeInt.optional(),
  excluded: z.literal(true).optional(),
  orchestration: PersistedPipelineOrchestrationStateSchema.optional(),
});

/** Every field of `PersistedRun`, with the identity a snapshot must carry. */
export const RunSnapshotSchema = z.looseObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  name: z.string().min(1),
  ticket: z.string().optional(),
  pipeline: z.string().min(1),
  pipeline_path: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  outcome: RunOutcomeStateSchema.optional(),
  max_cost_usd: z.number().optional(),
  parentRunId: z.string().optional(),
  parentNodeId: z.string().optional(),
  rootRunId: z.string().optional(),
  budgetScopeId: z.string().optional(),
  lot: PipelineLotSchema.optional(),
  pipelineLineage: z.array(PipelineLineageEntrySchema).optional(),
  steps: z
    .array(PersistedStepStateSchema)
    .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
      error: "step ids must be unique",
    }),
  total_control: StepControlSchema.optional(),
  total_usage: StepUsageSchema.optional(),
  aborted: z.boolean().optional(),
  stopped_reason: z.string().optional(),
  worktree: z.boolean().optional(),
  cwd: z.string().optional(),
  budget_exceeded: z.boolean().optional(),
  budget_approved: z.boolean().optional(),
  cost_unaccounted: z.boolean().optional(),
  allow_unmetered: z.boolean().optional(),
  specPath: z.string().optional(),
});

/** Persisted snapshot: what the disk may hold. Differs from `RunSnapshot` by the
 * fields a later release started writing (`retries` may be absent). */
export type RunSnapshotInput = z.input<typeof RunSnapshotSchema>;

/** Normalized snapshot: what every reader consumes. */
export type RunSnapshot = PersistedRun & {
  schemaVersion: 1;
  runId: string;
  steps: PersistedRun["steps"];
};

/** Human-readable reason a value is not a valid snapshot, or undefined when it is. */
export function diagnoseRunSnapshot(value: unknown): string | undefined {
  const result = RunSnapshotSchema.safeParse(value);
  return result.success ? undefined : z.prettifyError(result.error);
}

/** Normalized snapshot, or null when the value is not a valid snapshot. */
export function parseRunSnapshot(value: unknown): RunSnapshot | null {
  const result = RunSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the interfaces describe the same data
 * (see `lib/type-assertions.ts`).
 * ------------------------------------------------------------------------- */

type _OutputIsSnapshot = AssertAssignable<z.output<typeof RunSnapshotSchema>, RunSnapshot>;
type _SnapshotIsInput = AssertAssignable<Plain<RunSnapshot>, z.input<typeof RunSnapshotSchema>>;
type _StepOutput = AssertAssignable<z.output<typeof PersistedStepStateSchema>, PersistedStepState>;
type _StepInput = AssertAssignable<Plain<PersistedStepState>, z.input<typeof PersistedStepStateSchema>>;
type _Outcome = AssertAssignable<z.output<typeof RunOutcomeStateSchema>, RunOutcomeState>;
type _Stop = AssertAssignable<z.output<typeof RunStopStateSchema>, RunStopState>;
type _Lineage = AssertAssignable<z.output<typeof PipelineLineageEntrySchema>, PipelineLineageEntry>;
type _Lot = AssertAssignable<z.output<typeof PipelineLotSchema>, PipelineLot>;
type _Child = AssertAssignable<z.output<typeof PersistedPipelineChildRefSchema>, PersistedPipelineChildRef>;
type _Orchestration = AssertAssignable<
  z.output<typeof PersistedPipelineOrchestrationStateSchema>,
  PersistedPipelineOrchestrationState
>;
type _Session = AssertAssignable<z.output<typeof AgentSessionSchema>, AgentSession>;
type _Control = AssertAssignable<z.output<typeof StepControlSchema>, StepControl>;
type _Usage = AssertAssignable<z.output<typeof StepUsageSchema>, StepUsage>;
