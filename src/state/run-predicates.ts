import type { PersistedAttempt, PersistedRun, PersistedStepState, StepStatus } from "../model/persisted.js";

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
  attempts?: readonly PersistedAttempt[];
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
export function replayedAfterInterruption(step: { attempts?: readonly PersistedAttempt[] }): boolean {
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

/**
 * Every step is settled but no verdict was ever stamped: the run still owes a
 * `finalizeRun`. `hydrate` applies the same rule on its own hydrated steps, so
 * such a snapshot loads as a live run instead of a terminal one — a terminal
 * load leaves nobody able to finalize it.
 *
 * An `ABORTED` snapshot whose outcome opted out of resuming is excluded by the
 * `resumable === false` guard in `resumeDecision`, which runs first. The
 * explicit `--run` path has no such guard: naming a run is the decision.
 */
export function settledButUnfinalized(run: PersistedRun | null): boolean {
  if (!run) return false;
  if (run.status !== "RUNNING" && run.status !== "ABORTED") return false;
  return allStepsSettled(run.steps);
}

/** Steps still to execute, which determines resumability. */
export function pendingSteps(run: PersistedRun | null): PersistedStepState[] {
  return run?.steps?.filter((step) => owesWork(step.status)) ?? [];
}

/**
 * Work this run still owes, pending steps AND composed work.
 *
 * A `pendingSteps` read alone misses a fan-out stopped mid-list: an orchestration
 * node keeps its remaining items and children inside its own state, and its step
 * can even read `done` from an earlier generation. Anything the run could still
 * execute counts, which is what makes "a completed run is not failed after the
 * fact" safe to apply to the cost stops.
 */
export function hasUnfinishedWork(run: PersistedRun | null): boolean {
  if (!run) return false;
  if (pendingSteps(run).length > 0) return true;
  return (run.steps ?? []).some((step) => {
    const state = step.orchestration;
    if (!state) return false;
    if (state.children.some((child) => owesWork(child.status))) return true;
    // A `forEachPipeline` creates one child per item as it walks the list: items
    // it never reached have no child reference at all.
    const launched = state.children.filter((child) => child.kind === "main").length;
    return (state.items?.length ?? 0) > launched;
  });
}

/**
 * Single resume policy. `resolveRunDir` uses it to decide, and discarded-resume
 * notices use it to explain why.
 *
 * A manually interrupted run (SIGINT/SIGTERM → ABORTED) resumes by default:
 * completed steps are kept, and the step that was running is replayed from
 * scratch. Only an outcome that explicitly opted out (`resumable: false`, which
 * includes snapshots aborted before this policy) is discarded.
 */
export function resumeDecision(run: PersistedRun | null): ResumeDecision {
  if (!run) return { resume: false, rejection: "unreadable" };
  if (run.outcome?.resumable === false) {
    return { resume: false, rejection: "discarded" };
  }
  // A run can lose its process after the final step snapshot is written but
  // before finalizeRun stamps the verdict: a crash leaves it RUNNING, a manual
  // SIGINT with no step in flight leaves it ABORTED with every step settled.
  // Both describe the same gap — all the work is done, only the verdict is
  // missing — so keep the run as the latest one and let the next invocation
  // finalize it instead of creating a new run and replaying every step.
  if (settledButUnfinalized(run)) return { resume: true };
  return run.steps.some((step) => owesWork(step.status)) ? { resume: true } : { resume: false, rejection: "settled" };
}

export function isPersistedRunResumable(run: PersistedRun | null): boolean {
  return resumeDecision(run).resume;
}

/** A PASS run is complete; interrupted, failed, or running runs are not. */
export function isPersistedRunComplete(run: PersistedRun | null): boolean {
  if (!run || run.aborted) return false;
  if (run.status && run.status !== "PASS") return false;
  return run.steps.length > 0 && pendingSteps(run).length === 0;
}
