// runner/run-record/step-bookkeeping.ts
//
// The named writes of an execution that are neither a transition
// (`run-transitions.ts`), the end of an attempt (`attempt-lifecycle.ts`) nor a
// child reference (`child-transitions.ts`): the retry quotas of a step, the
// session it continues, the command it was last given, a source it could not
// read, a step admission skipped or found unfinished outputs for, and a human
// decision the run journals. The step layer and the entry
// point call them instead of writing a field and saving the run by hand.
//
// Each operation writes its field, the journal event that already recorded the
// fact if there is one, then the snapshot. Four write no snapshot, because the
// snapshot carries nothing they change: the last command (left out of the
// snapshot, see `run-repository.ts`), and an unavailable source, a skip and
// unfinished outputs (journal only: the skip's status goes through `updateStep`).

import type { AgentSession } from "../contracts/backends.js";
import type { RunStepView, RunView } from "../model/run.js";
import { writable } from "./run.js";
import { appendRunEvent } from "./run-journal.js";
import { saveRun } from "./run-repository.js";

/** The quota a retry loop draws on. Reruns and repair passes share `retries`;
 *  the timeout drain has its own, so it cannot consume the repair quota. */
export type RetryQuota = "retries" | "timeout_retries";

/**
 * Count one more attempt against a quota and persist it before the attempt
 * runs, so a resume finds the quota spent by an attempt that had its chance.
 * Returns the attempts the quota has now consumed.
 */
export function consumeRetry(runView: RunView, stepView: RunStepView, quota: RetryQuota): number {
  const run = writable(runView);
  const step = writable(stepView);
  const consumed = (step[quota] ?? 0) + 1;
  step[quota] = consumed;
  saveRun(run);
  return consumed;
}

/** What a settled attempt says about the cost guard that may have cut it short. */
export interface CostCut {
  budgetExceeded?: boolean;
  costUnaccounted?: boolean;
}

/**
 * Give the quota back for an attempt the cost guard cut short, and only for
 * one: the quota counts attempts that had their chance, and a `--budget`
 * resume must still be able to run this one instead of reporting the quota as
 * consumed. Returns whether the quota was refunded.
 */
export function refundRetry(runView: RunView, stepView: RunStepView, quota: RetryQuota, attempt: CostCut): boolean {
  const run = writable(runView);
  const step = writable(stepView);
  if (!attempt.budgetExceeded && !attempt.costUnaccounted) return false;
  step[quota] = (step[quota] ?? 0) - 1;
  saveRun(run);
  return true;
}

/**
 * Bind the session a step continues from now on: one opened fresh for its next
 * attempt, the one a step attempt reported, or the fork a resumed repair left on
 * the step it resumed. A later gate or repair resumes the session the snapshot
 * names, so it is persisted at once.
 */
export function bindSession(runView: RunView, stepView: RunStepView, session: AgentSession): void {
  const run = writable(runView);
  const step = writable(stepView);
  step.session = session;
  saveRun(run);
}

/** The command a step was last given, resolved. Memory only: the snapshot
 *  leaves it out, since it is the full agent prompt. */
export function recordLastCommand(stepView: RunStepView, command: string): void {
  const step = writable(stepView);
  step.last_command = command;
}

/** A source the step declares and could not read: its freshness is unknown and
 *  the step runs, and the journal is where a diagnosis learns why. */
export function recordUnavailableSource(
  run: RunView,
  step: RunStepView,
  unavailable: { source: string; reason: string },
): void {
  appendRunEvent(run, "step.source.unavailable", {
    stepId: step.id,
    source: unavailable.source,
    reason: unavailable.reason,
  });
}

/** Why admission skipped a step. Journaled before the status it settles the
 *  step on (`updateStep`), or alone when the step keeps its status: the console
 *  line is transient, and a later diagnosis reads the journal. */
export function recordSkip(run: RunView, step: RunStepView, skip: { reason: string; freshness?: string }): void {
  appendRunEvent(run, "step.skipped", { stepId: step.id, reason: skip.reason, freshness: skip.freshness });
}

/** Outputs an attempt that never succeeded left behind, which make the step run
 *  whatever the run remembers of that attempt: the journal says which. */
export function recordUnfinishedOutputs(run: RunView, step: RunStepView, outputs: readonly string[]): void {
  appendRunEvent(run, "step.outputs.unfinished", { stepId: step.id, outputs: [...outputs] });
}

/** A human decision `--approve` or `--reject` recorded before the run started. */
export interface RecordedDecision {
  subject: string;
  /** `rejected`, or a decision that lets the run go on (`approved`, `applied`). */
  decision: string;
  reason?: string;
  round?: number;
}

/** Journal the decision the invocation recorded, then persist the run. A
 *  decision that is not a rejection is journaled as an approval. */
export function recordDecision(runView: RunView, recorded: RecordedDecision): void {
  const run = writable(runView);
  appendRunEvent(run, "decision.recorded", {
    subject: recorded.subject,
    decision: recorded.decision === "rejected" ? "rejected" : "approved",
    ...(recorded.reason !== undefined ? { reason: recorded.reason } : {}),
    ...(recorded.round !== undefined ? { round: recorded.round } : {}),
  });
  saveRun(run);
}
