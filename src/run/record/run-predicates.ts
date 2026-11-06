import type { PersistedRun, RunStatus, StepStatus } from "../persisted.js";
import type { RunAttemptView } from "../run.js";
import { isCompleted, isProvisionalStatus } from "./run-status.js";

/**
 * A step in this status has nothing left to execute. Every rule about what a
 * step still owes reads this one: a status added to `StepStatus` is classified
 * here once, not at each site that enumerates statuses.
 */
export function isSettledStatus(status: StepStatus): boolean {
  return status === "done" || status === "skipped";
}

/** The step still has executable work: it never ran, is running, or its last
 *  pass failed or was interrupted. */
export function owesWork(status: StepStatus): boolean {
  return !isSettledStatus(status);
}

interface StepAttempts {
  status: StepStatus;
  attempts?: readonly RunAttemptView[];
}

/**
 * The step still owes work and its latest attempt was cut short by the runner
 * dying. Keyed on the attempt, never on `running` alone: an orchestration node is
 * `running` for the whole life of its children and has no attempt of its own.
 * The marker clears itself once the replay appends a new attempt.
 */
export function lastPassInterrupted(step: StepAttempts): boolean {
  return owesWork(step.status) && step.attempts?.at(-1)?.interrupted === true;
}

/** An interrupted attempt was followed by another one: the step was replayed. */
export function replayedAfterInterruption(step: { attempts?: readonly RunAttemptView[] }): boolean {
  const attempts = step.attempts ?? [];
  return attempts.slice(0, -1).some((attempt) => attempt.interrupted === true);
}

/**
 * Every step reached a terminal success state (`done` or `skipped`). An empty
 * list is never settled: a run without steps has produced nothing to trust.
 */
export function allStepsSettled(steps: ReadonlyArray<{ status: StepStatus }>): boolean {
  return steps.length > 0 && steps.every((step) => isSettledStatus(step.status));
}

/** Resume rejection reason, so callers can EXPLAIN it instead of recomputing it
 *  (two divergent reads would produce a misleading message). */
export type ResumeRejection = "unreadable" | "discarded" | "settled";

export interface ResumeDecision {
  resume: boolean;
  rejection?: ResumeRejection;
}

/** Steps still to execute. */
export function pendingSteps<S extends { readonly status: StepStatus }>(
  run: { readonly steps: readonly S[] } | null,
): S[] {
  return run?.steps?.filter((step) => owesWork(step.status)) ?? [];
}

/** What a run still owes, read once from its status, its outcome and its steps. */
export interface RemainingWork<S> {
  /** Steps with executable work left. */
  steps: S[];
  /** The run has steps and every one of them is settled. */
  settled: boolean;
  /** Every step is settled but no verdict was ever stamped: a crash left the run
   *  `RUNNING`, or an interruption with no step in flight left it `ABORTED`. The
   *  run still owes a `finalizeRun`. */
  verdictOwed: boolean;
  /** The outcome opted out of automatic resume (`resumable: false`). Naming the
   *  run with `--run` still reaches it: naming a run is the decision. */
  discarded: boolean;
  /** An automatic resume has something to do: steps to execute, or a verdict to
   *  stamp on a run that did not opt out. */
  owed: boolean;
}

/**
 * The one reading of what is left to do in a run. Resume, `--run`, the step loop,
 * the opening of a run, a composing parent and the dashboard all take it from
 * here.
 *
 * Work is read from the step statuses only. An orchestration node keeps its items
 * and children inside its own state, but its status already says whether it owes
 * them: it turns `done` only once its last child settled
 * (`execution/step/pipeline-orchestration.ts`), a fan-out stopped mid-list leaves
 * it failed, running or aborted, and a node `--skip` set aside is a decision that
 * its remaining children are not owed.
 */
export function remainingWork<S extends { readonly status: StepStatus }>(run: {
  readonly status?: RunStatus;
  readonly outcome?: { readonly resumable?: boolean };
  readonly steps: readonly S[];
}): RemainingWork<S> {
  const steps = pendingSteps(run);
  const settled = allStepsSettled(run.steps);
  const verdictOwed = settled && isProvisionalStatus(run.status);
  const discarded = run.outcome?.resumable === false;
  return { steps, settled, verdictOwed, discarded, owed: steps.length > 0 || (verdictOwed && !discarded) };
}

/**
 * Single resume policy. `resolveRunDir` uses it to decide, and discarded-resume
 * notices use it to explain why.
 *
 * A manually interrupted run (SIGINT/SIGTERM → ABORTED) resumes by default:
 * completed steps are kept, and the step that was running is replayed from
 * scratch. Only an outcome that explicitly opted out (`resumable: false`, which
 * includes snapshots aborted before this policy) is discarded. A run whose steps
 * are all settled but which never received its verdict stays the latest one, so
 * the next invocation finalizes it instead of replaying every step in a new run.
 */
export function resumeDecision(run: PersistedRun | null): ResumeDecision {
  if (!run) return { resume: false, rejection: "unreadable" };
  const remaining = remainingWork(run);
  if (remaining.discarded) return { resume: false, rejection: "discarded" };
  return remaining.owed ? { resume: true } : { resume: false, rejection: "settled" };
}

export function isPersistedRunResumable(run: PersistedRun | null): boolean {
  return resumeDecision(run).resume;
}

/** A PASS run is complete; interrupted, failed, or running runs are not. */
export function isPersistedRunComplete(run: PersistedRun | null): boolean {
  if (!run || run.aborted) return false;
  if (run.status !== undefined && !isCompleted(run.status)) return false;
  return remainingWork(run).settled;
}
