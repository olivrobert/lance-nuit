// runner/state/run-verdict.ts
//
// Single derivation of a run verdict from its steps.
//
// `finalizeRun` writes this verdict to the snapshot; `run-stats-projector` recalculates
// it when the snapshot has no usable verdict. Precedence lives only here, so
// runs.jsonl and persisted state cannot diverge on it.

import type { PersistedRun, RunStatus } from "../model/persisted.js";
import { allStepsSettled } from "./run-predicates.js";

/** Final verdict; an active run is never derived and remains `RUNNING`. */
export type RunVerdict = Exclude<RunStatus, "RUNNING">;

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
 * Precedence: interruption > clean stop > failure > success > unknown.
 *
 * An `aborted` step means interruption even without the run flag: its attempt was
 * killed, usage is partial, and the run cannot resume as-is.
 */
export function deriveRunStatus(run: VerdictInput, signals: RunVerdictSignals = {}): RunVerdict {
  if (run.aborted || run.steps.some((step) => step.status === "aborted")) return "ABORTED";
  if (signals.stopped || run.stopped_reason) return "STOPPED";
  if (
    signals.failed ||
    signals.budgetExceeded ||
    signals.costUnaccounted ||
    run.steps.some((step) => step.status === "failed")
  )
    return "FAIL";
  return allStepsSettled(run.steps) ? "PASS" : "UNKNOWN";
}

/** Completed (PASS) runs do not resume; interrupted or failed runs do. */
export function isResumableStatus(status: RunVerdict): boolean {
  return status === "FAIL" || status === "STOPPED" || status === "ABORTED" || status === "UNKNOWN";
}
