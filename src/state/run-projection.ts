// runner/state/run-projection.ts
//
// Project a persisted run onto the state a resume starts from: per step, the
// snapshot state reconciled with the journal and the attempts read from it.
// Nothing here knows about a pipeline definition or a `RunStep`; assembling the
// in-memory run from a definition is `boot/resume.ts`.
//
// Spend is not recomputed here: `projectStepSpend` (`state/cost-accounting.ts`)
// rebuilds a step total from the attempts, and `closeAttempt` charges a crashed
// attempt through the same owner as any other closing attempt.

import type { RunJournalEvent } from "../model/journal.js";
import type { PersistedAttempt, PersistedRun, PersistedStepState } from "../model/persisted.js";
import type { Run } from "../model/run.js";
import { closeAttempt } from "./attempt-closure.js";
import { projectStepAttempts } from "./attempt-projection.js";
import { projectStepSpend } from "./cost-accounting.js";

/** Persisted state of one step, reconciled with the attempts the journal holds. */
export interface ProjectedStep {
  /** Undefined for a step the journal knows attempts of but the snapshot does not carry. */
  state: PersistedStepState | undefined;
  attempts: PersistedAttempt[] | undefined;
}

/** What a resume reads from storage, before any definition is involved. */
export interface ProjectedRunState {
  steps: Map<string, ProjectedStep>;
}

type StepStatusEvent = Extract<RunJournalEvent, { type: "step.status.changed" }>;

/** Statuses a step never leaves on its own: reaching one ends the step's work. */
const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "skipped", "aborted"]);

/** Statuses that still owe work, and that a terminal journal event supersedes. */
const UNFINISHED_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/** Last `step.status.changed` of each step, in journal order. */
function lastStatusEvents(events: readonly RunJournalEvent[]): Map<string, StepStatusEvent> {
  const byStep = new Map<string, StepStatusEvent>();
  for (const event of events) {
    if (event.type === "step.status.changed" && typeof event.stepId === "string") byStep.set(event.stepId, event);
  }
  return byStep;
}

/**
 * Step status to resume from: the snapshot's, unless the journal already knows
 * the step finished.
 *
 * `updateStep` appends `step.status.changed` before it writes the snapshot. A
 * hard death in that window leaves a step the journal calls `done` while the
 * snapshot still calls it `running`; resume projects attempts only, so it would
 * read the step as unfinished and run it a second time — work already done, and
 * already paid for.
 *
 * The reconciliation is deliberately one-way: only a terminal journal status over
 * an unfinished snapshot status is taken. The snapshot is written after the event,
 * so a snapshot already terminal is the later record and wins; and a journal that
 * walks a step back to `running` describes a pass the snapshot has since closed.
 * The rest of the step state is left untouched, except the fields the same event
 * carries and the snapshot could not have received either: the finish instant, the
 * failure reason, and the fail cause.
 */
function reconcileStepStatus(state: PersistedStepState, event: StepStatusEvent | undefined): PersistedStepState {
  if (!event) return state;
  if (!UNFINISHED_STEP_STATUSES.has(state.status) || !TERMINAL_STEP_STATUSES.has(event.status)) return state;
  return {
    ...state,
    status: event.status,
    // `updateStep` stamps the finish when it applies the status, so the event's
    // own instant is the closest record of it the journal holds.
    finished_at: state.finished_at ?? event.ts,
    // Same rule as `updateStep`: an extractor-supplied reason already in the
    // snapshot is never overwritten by the generic one.
    errors: state.errors ?? (event.status === "failed" ? event.reason : undefined),
    fail_cause: state.fail_cause ?? event.failCause,
  };
}

/**
 * Reconcile a snapshot with its journal, step by step.
 *
 * The snapshot no longer duplicates the attempts: the journal owns them, so a
 * resume projects them from the events and rebuilds the step total whenever the
 * journal turns out to be the more complete record.
 */
export function projectRunState(saved: PersistedRun, events: readonly RunJournalEvent[]): ProjectedRunState {
  const attemptsByStep = projectStepAttempts(events);
  const statusByStep = lastStatusEvents(events);
  const stateById = new Map(saved.steps.map((state) => [state.id, state]));
  const steps = new Map<string, ProjectedStep>();
  // The journal may hold attempts for a step the snapshot never recorded; such a
  // step still owes its spend to the ledger, so it belongs to the projection.
  for (const id of new Set([...stateById.keys(), ...attemptsByStep.keys()])) {
    const state = stateById.get(id);
    const attempts = attemptsByStep.get(id);
    const spend = projectStepSpend(state, attempts);
    const reconciled = state && reconcileStepStatus(state, statusByStep.get(id));
    steps.set(id, {
      state: reconciled && { ...reconciled, control: spend.control, usage: spend.usage },
      attempts,
    });
  }
  return { steps };
}

const CRASHED_ATTEMPT_REASON = "runner died before the attempt reported its result (crash, OOM, or SIGKILL)";

/**
 * Settle attempts the journal left `running`.
 *
 * A `running` attempt read at load time has no live producer: the process that
 * opened it died between `step.attempt.started` and `step.attempt.finished`. Only
 * a signal handler closes an attempt from outside the loop, and it writes a
 * finish; so what remains here is a hard death (SIGKILL, OOM, power loss).
 *
 * Such an attempt spent tokens nobody measured. Left as-is it reads as free: the
 * ledger does not advance, the run carries no `cost_unknown`, and `max_cost_usd`
 * can be crossed without a trace. Closing it here as failed and unpriced makes the
 * gap visible, and the finish event makes the decision durable so the next resume
 * projects it instead of re-deriving it.
 */
export function settleCrashedAttempts(run: Run): boolean {
  let settled = false;
  for (const step of run.steps) {
    for (const attempt of step.attempts ?? []) {
      // `closeAttempt` applies the `cost_unknown` rule (agent step or fix pass
      // without spend figures), charges the step total through
      // `chargeClosedAttempt` like any other closing attempt, and writes the
      // finish. The ledger itself is seeded from those step totals afterwards.
      const closed = closeAttempt(run, step, attempt, {
        status: "failed",
        control: attempt.control,
        reason: attempt.errors ?? CRASHED_ATTEMPT_REASON,
      });
      if (closed) settled = true;
    }
  }
  return settled;
}
