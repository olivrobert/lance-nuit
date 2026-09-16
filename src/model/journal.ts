// runner/model/journal.ts
//
// Contract of the run journal (`events.jsonl`).
//
// The journal is append-only and doubles as the live feed, so one file
// interleaves three kinds of line: the journal events below, the `RunnerEvent`
// lines the live feed writes, and raw backend stream lines. Only the first kind
// is contracted here; the other two are read back as `unknown` entries and kept.
//
// Reading is tolerant and writing is strict: `state/journal-schema.ts` validates
// a line against the union and never discards it, `state/run-journal.ts` appends
// through the union so a producer cannot invent a field name.

import type { AgentSession, StepControl, StepFailCause, StepUsage } from "../contracts/backends.js";
import type { PersistedAttempt, RunOutcomeState, RunStatus, RunStopState, StepStatus } from "./persisted.js";

/** Every journal event carries the instant it was appended, and the run it
 *  belongs to as soon as the run has an identity. */
interface JournalBase {
  ts: string;
  runId?: string;
}

type AttemptKind = PersistedAttempt["kind"];
type AttemptStatus = PersistedAttempt["status"];

/**
 * Closed union of the events the runner appends.
 *
 * Optionality here mirrors what a reader may find on disk, not what the writer
 * emits: a field the emitter always writes is still optional when a reader
 * already copes with its absence. The attempt events are the deliberate extreme —
 * `stepId` and `attempt` are all `projectStepAttempts` needs to keep the
 * numbering, and a stricter schema on the rest would drop an attempt and
 * overwrite the logs of the previous ones on resume.
 */
export type RunJournalKnownEvent =
  | (JournalBase & { type: "run.started"; pipeline: string; ticket: string | null })
  | (JournalBase & { type: "run.resumed"; pipeline: string })
  | (JournalBase & { type: "run.finished"; status: RunStatus; outcome?: RunOutcomeState })
  | (JournalBase & {
      type: "run.stopped";
      phase: string;
      reason: string;
      logPath: string | null;
      stop?: RunStopState;
    })
  | (JournalBase & { type: "run.aborted"; status: RunStatus; reason: string; logPath: string | null })
  | (JournalBase & {
      type: "run.budget.exceeded";
      stepId: string | null;
      cumulativeUsd: number;
      maxCostUsd: number | null;
      estimated: boolean;
      remainingSteps: number;
    })
  | (JournalBase & {
      type: "run.cost.unaccounted";
      stepId: string | null;
      /** LOWER BOUND: spend nobody could price is not in this figure. */
      cumulativeUsd: number;
      maxCostUsd: number | null;
      remainingSteps: number;
    })
  | (JournalBase & { type: "run.unmetered.authorized"; budgetScopeId: string | null; maxCostUsd: number | null })
  | (JournalBase & { type: "step.skipped"; stepId: string; reason: string; freshness?: string })
  | (JournalBase & {
      type: "step.status.changed";
      stepId: string;
      status: StepStatus;
      reason?: string;
      logPath?: string | null;
      /** Mirror of `step.fail_cause`: absent unless the step carries a cause no
       *  fix pass can change, and absent from every journal written before the
       *  field existed. */
      failCause?: StepFailCause;
    })
  | (JournalBase & {
      type: "step.attempt.started";
      stepId: string;
      attempt: number;
      kind?: AttemptKind;
      sessionId?: string | null;
      logPath?: string | null;
    })
  | (JournalBase & {
      type: "step.attempt.finished";
      stepId: string;
      attempt: number;
      kind?: AttemptKind;
      status?: AttemptStatus;
      /** Session id and provider, for readers that only need the reference. */
      sessionId?: string;
      provider?: string;
      session?: AgentSession;
      model?: string;
      costUsd?: number;
      control?: StepControl;
      usage?: StepUsage;
      logPath?: string | null;
      /** The attempt keeps it as `errors`; the journal names it `reason`. */
      reason?: string;
    })
  /** One attempt spent tokens at an unknown price. Per attempt, unlike the
   *  per-generation `run.cost.unaccounted`. */
  | (JournalBase & { type: "step.cost.unaccounted"; stepId: string; model: string | null })
  | (JournalBase & {
      type: "pipeline.child.started";
      parentNodeId: string;
      childRunId: string | null;
      childPipeline?: string;
      childTicket?: string | null;
      rootRunId?: string | null;
      budgetScopeId?: string | null;
      maxCostUsd?: number | null;
    })
  | (JournalBase & {
      type: "pipeline.child.finished";
      parentNodeId: string;
      childRunId: string | null;
      childKey?: string;
      status?: "done" | "failed";
      accountedCostUsd?: number;
      deltaCostUsd?: number;
      outcome?: RunOutcomeState | null;
    })
  | (JournalBase & {
      type: "pipeline.child.cost.reconciled";
      parentNodeId: string;
      childRunId: string | null;
      childKey?: string;
      accountedCostUsd?: number;
      deltaCostUsd?: number;
    })
  | (JournalBase & { type: "decision.recorded"; subject: string; decision: "approved" });

export type RunJournalEventType = RunJournalKnownEvent["type"];

/** A line read but outside the contract: an unknown type (the live feed, a
 *  backend stream, a later release, an extension) or a known type whose payload
 *  does not pass its schema. The raw object is kept as it was read. `ts` is
 *  optional because the backend stream lines sharing this file carry none. */
export interface RawJournalEvent {
  type: string;
  ts?: string;
  runId?: string;
  [key: string]: unknown;
}

/**
 * Result of reading one line: the envelope, never the bare event.
 *
 * `RawJournalEvent.type` is `string` and would cover every literal of the union,
 * so without the envelope `event.type === "pipeline.child.started"` would narrow
 * nothing — and the `invalid` count could not be computed.
 */
export type JournalEntry =
  | { kind: "known"; event: RunJournalKnownEvent }
  | { kind: "unknown"; event: RawJournalEvent }
  | { kind: "invalid"; event: RawJournalEvent; reason: string };

/** What the typed readers consume. Kept under this name: the readers that
 *  already spelled it now receive the closed union. */
export type RunJournalEvent = RunJournalKnownEvent;

/** Counters a diagnostic reads to tell a too-strict schema from a producer bug:
 *  `skipped` is a line that is not an event at all, `unknown` a type outside the
 *  contract, `invalid` a contracted type whose payload was refused. */
export interface RunJournalCounts {
  skipped: number;
  invalid: number;
  unknown: number;
}
