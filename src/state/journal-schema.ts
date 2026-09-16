// state/journal-schema.ts
//
// Runtime schema of the run journal (`events.jsonl`), the read side of the
// contract declared in `model/journal.ts`.
//
// Diagnostic policy at this boundary: no line is ever discarded for a schema
// reason. A line that is not an event at all is *skipped*, a type outside the
// contract is kept as *unknown*, and a contracted type whose payload is refused
// is kept as *invalid* with its reason. The three counters are what tells a
// too-strict schema from a producer bug, and `state/diagnostics.ts` exposes them.
//
// Same rules as `state/schema.ts` and `state/stats/history-schema.ts`:
//
// - `z.looseObject` everywhere, so a field added by a later release does not make
//   the journal unreadable by an earlier one, and vice versa.
// - Every field the interface marks optional is optional here.
// - An optional field of the wrong kind, or an enumerated value this release does
//   not know, reads as ABSENT (`tolerant`) instead of refusing the event. Only
//   the load-bearing fields decide validity — the ones a reader needs to act:
//   `stepId` and a positive integer `attempt` on the attempt events,
//   `parentNodeId` and `childRunId` on the composed-child events. This is what
//   `history-schema.ts` already does for `pipeline-history/runs.jsonl`, for the
//   same reason: an event refused whole is an event absent from the projections,
//   and the readers already cope with a missing field through their own
//   fallbacks (`attemptKind`, `attemptStatus`, `attemptSession`).
//
// The cost of getting this wrong is not academic. `closeAttempt` appends
// `step.attempt.finished` BEFORE it writes the snapshot: a crash in that window
// leaves the attempt's price in the journal alone. `reconcileStepSpend`
// (`state/run-projection.ts`) rebuilds the step total from those events, so an
// event refused for a mistyped `kind` would read as a free attempt and let the
// resume spend past `max_cost_usd`.

import * as z from "zod";
import { FAIL_CAUSES } from "../contracts/backends.js";
import type { AssertAssignable, Plain } from "../lib/type-assertions.js";
import type { JournalEntry, RawJournalEvent, RunJournalEventType, RunJournalKnownEvent } from "../model/journal.js";
import {
  AgentSessionSchema,
  RUN_STATUSES,
  RunOutcomeStateSchema,
  RunStopStateSchema,
  STEP_STATUSES,
  StepControlSchema,
  StepUsageSchema,
} from "./schema.js";

/** Wrong kind or unknown value → absent; the event survives. */
const tolerant = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const base = {
  ts: z.string(),
  runId: tolerant(z.string()),
};

/** Load-bearing: `projectStepAttempts` keys an attempt by these two, and an
 *  attempt it cannot key is an attempt absent from the resume projection. */
const stepId = z.string().min(1);
const attemptNumber = z.number().int().positive();

const optionalString = tolerant(z.string());
const optionalNullableString = tolerant(z.string().nullable());
const optionalNumber = tolerant(z.number());
const optionalNullableNumber = tolerant(z.number().nullable());
const attemptKind = tolerant(z.enum(["step", "fix"]));
const attemptStatus = tolerant(z.enum(["running", "done", "failed", "aborted"]));
const runStatus = z.enum(RUN_STATUSES);
const stepStatus = z.enum(STEP_STATUSES);

const EVENT_SCHEMAS = {
  "run.started": z.looseObject({
    ...base,
    type: z.literal("run.started"),
    pipeline: z.string(),
    ticket: z.string().nullable(),
  }),
  "run.resumed": z.looseObject({ ...base, type: z.literal("run.resumed"), pipeline: z.string() }),
  "run.finished": z.looseObject({
    ...base,
    type: z.literal("run.finished"),
    status: runStatus,
    outcome: tolerant(RunOutcomeStateSchema),
  }),
  "run.stopped": z.looseObject({
    ...base,
    type: z.literal("run.stopped"),
    phase: z.string(),
    reason: z.string(),
    logPath: z.string().nullable(),
    stop: tolerant(RunStopStateSchema),
  }),
  "run.aborted": z.looseObject({
    ...base,
    type: z.literal("run.aborted"),
    status: runStatus,
    reason: z.string(),
    logPath: z.string().nullable(),
  }),
  "run.budget.exceeded": z.looseObject({
    ...base,
    type: z.literal("run.budget.exceeded"),
    stepId: z.string().nullable(),
    cumulativeUsd: z.number(),
    maxCostUsd: z.number().nullable(),
    estimated: z.boolean(),
    remainingSteps: z.number(),
  }),
  "run.cost.unaccounted": z.looseObject({
    ...base,
    type: z.literal("run.cost.unaccounted"),
    stepId: z.string().nullable(),
    cumulativeUsd: z.number(),
    maxCostUsd: z.number().nullable(),
    remainingSteps: z.number(),
  }),
  "run.unmetered.authorized": z.looseObject({
    ...base,
    type: z.literal("run.unmetered.authorized"),
    budgetScopeId: z.string().nullable(),
    maxCostUsd: z.number().nullable(),
  }),
  "step.skipped": z.looseObject({
    ...base,
    type: z.literal("step.skipped"),
    stepId,
    reason: z.string(),
    freshness: optionalString,
  }),
  "step.status.changed": z.looseObject({
    ...base,
    type: z.literal("step.status.changed"),
    stepId,
    status: stepStatus,
    reason: optionalString,
    logPath: optionalNullableString,
    failCause: tolerant(z.enum(FAIL_CAUSES)),
  }),
  "step.attempt.started": z.looseObject({
    ...base,
    type: z.literal("step.attempt.started"),
    stepId,
    attempt: attemptNumber,
    kind: attemptKind,
    sessionId: optionalNullableString,
    logPath: optionalNullableString,
  }),
  "step.attempt.finished": z.looseObject({
    ...base,
    type: z.literal("step.attempt.finished"),
    stepId,
    attempt: attemptNumber,
    kind: attemptKind,
    status: attemptStatus,
    sessionId: optionalString,
    provider: optionalString,
    session: tolerant(AgentSessionSchema),
    model: optionalString,
    costUsd: optionalNumber,
    control: tolerant(StepControlSchema),
    usage: tolerant(StepUsageSchema),
    logPath: optionalNullableString,
    reason: optionalString,
  }),
  "step.cost.unaccounted": z.looseObject({
    ...base,
    type: z.literal("step.cost.unaccounted"),
    stepId,
    model: z.string().nullable(),
  }),
  "pipeline.child.started": z.looseObject({
    ...base,
    type: z.literal("pipeline.child.started"),
    parentNodeId: z.string(),
    childRunId: z.string().nullable(),
    childPipeline: optionalString,
    childTicket: optionalNullableString,
    rootRunId: optionalNullableString,
    budgetScopeId: optionalNullableString,
    maxCostUsd: optionalNullableNumber,
  }),
  "pipeline.child.finished": z.looseObject({
    ...base,
    type: z.literal("pipeline.child.finished"),
    parentNodeId: z.string(),
    childRunId: z.string().nullable(),
    childKey: optionalString,
    status: tolerant(z.enum(["done", "failed"])),
    accountedCostUsd: optionalNumber,
    deltaCostUsd: optionalNumber,
    outcome: tolerant(RunOutcomeStateSchema.nullable()),
  }),
  "pipeline.child.cost.reconciled": z.looseObject({
    ...base,
    type: z.literal("pipeline.child.cost.reconciled"),
    parentNodeId: z.string(),
    childRunId: z.string().nullable(),
    childKey: optionalString,
    accountedCostUsd: optionalNumber,
    deltaCostUsd: optionalNumber,
  }),
  "decision.recorded": z.looseObject({
    ...base,
    type: z.literal("decision.recorded"),
    subject: z.string(),
    decision: z.literal("approved"),
  }),
} as const satisfies Record<RunJournalEventType, z.ZodType>;

/** The contracted types, in the order the union declares them. */
export const JOURNAL_EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as readonly RunJournalEventType[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify one already-parsed line.
 *
 * Returns `null` for a line that is not an event at all — not an object, or with
 * no string `type`. Callers count those as `skipped`, which is what they already
 * did with a line no reader could parse.
 */
export function parseJournalEntry(raw: unknown): JournalEntry | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string") return null;

  const event = raw as RawJournalEvent;
  const schema = (EVENT_SCHEMAS as Record<string, z.ZodType | undefined>)[type];
  if (!schema) return { kind: "unknown", event };

  const result = schema.safeParse(event);
  if (!result.success) return { kind: "invalid", event, reason: z.prettifyError(result.error) };
  return { kind: "known", event: result.data as RunJournalKnownEvent };
}

/** Human-readable reason a value is not the journal event it claims to be, or
 *  undefined when it is one. */
export function diagnoseJournalEntry(raw: unknown): string | undefined {
  const entry = parseJournalEntry(raw);
  if (entry === null) return "not a journal event: expected an object with a string `type`";
  if (entry.kind === "invalid") return entry.reason;
  if (entry.kind === "unknown") return `unknown event type "${entry.event.type}"`;
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the union describe the same data.
 * ------------------------------------------------------------------------- */

type SchemaOutput = { [T in RunJournalEventType]: z.output<(typeof EVENT_SCHEMAS)[T]> }[RunJournalEventType];
type SchemaInput = { [T in RunJournalEventType]: z.input<(typeof EVENT_SCHEMAS)[T]> }[RunJournalEventType];

/** What the schema produces satisfies the union the readers consume. */
type _OutputIsKnownEvent = AssertAssignable<SchemaOutput, RunJournalKnownEvent>;
/** Every event the writer can build is accepted by the schema, variant by
 *  variant: a journal this release writes stays readable by this release. */
type _KnownEventIsInput = AssertAssignable<Plain<RunJournalKnownEvent>, SchemaInput>;
