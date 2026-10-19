// runner/run-record/run-verdict.ts
//
// Single derivation of a run verdict from its steps.
//
// `finalizeRun` writes this verdict to the snapshot; `run-stats-projector` recalculates
// it when the snapshot has no usable verdict. The precedence is the one table of
// `run-status.ts`, which also names the report headline and the exit code, so
// runs.jsonl, the persisted state and the console cannot diverge on it.

import type { PersistedRun } from "../model/persisted.js";
import { allStepsSettled } from "./run-predicates.js";
import { hasVerdict, type RunVerdict, runEnding } from "./run-status.js";

/** Signals known only to the run loop and absent from steps. */
export interface RunVerdictSignals {
  failed?: boolean;
  stopped?: boolean;
  budgetExceeded?: boolean;
  /** A capped run stopped because its spending could no longer be accounted for.
   *  It fails like a budget stop — the pipeline did not finish its work — and
   *  stays resumable. */
  costUnaccounted?: boolean;
}

type VerdictInput = Pick<PersistedRun, "aborted" | "steps" | "stopped_reason">;

/**
 * The run's verdict from its steps and the loop's signals.
 *
 * An `aborted` step means interruption even without the run flag: its attempt was
 * killed, usage is partial, and the run cannot resume as-is. A failed step or a
 * persisted stop reason counts like the loop's own signal.
 */
export function deriveRunStatus(run: VerdictInput, signals: RunVerdictSignals = {}): RunVerdict {
  return runEnding({
    aborted: run.aborted === true || run.steps.some((step) => step.status === "aborted"),
    stopped: signals.stopped === true || Boolean(run.stopped_reason),
    failed: signals.failed === true || run.steps.some((step) => step.status === "failed"),
    budgetExceeded: signals.budgetExceeded,
    costUnaccounted: signals.costUnaccounted,
    settled: allStepsSettled(run.steps),
  }).status;
}

/** The verdict `finalizeRun` stamped, or the same derivation when the snapshot
 *  has none a reader can use. */
export function recordedVerdict(run: VerdictInput & Pick<PersistedRun, "status">): RunVerdict {
  return hasVerdict(run.status) ? run.status : deriveRunStatus(run);
}
