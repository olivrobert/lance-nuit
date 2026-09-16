// runner/state/run-transitions.ts
//
// The owner of run and step transitions during execution: status, failure
// reason, verdict fields, timestamps, `run.outcome` and the fields that must
// change with them. This module neither builds nor loads pipeline definitions;
// it persists mutations through the repository.
//
// Every operation below writes a GROUP of fields that belong together and the
// journal event that records the transition, so a caller never synchronizes
// `run.status`, `run.outcome` and `step.status` by hand. The groups:
//
// - `updateStep`          step status, its timestamps and reason, and the run
//                         status/outcome a failure implies;
// - `recordStepVerdict`   what the latest attempt established about the step
//                         (`fail_kind`, `fail_cause`), before its status moves;
// - `absorbStepFailure`   a `blocking: false` failure kept as the reason of a
//                         `done` step;
// - `stopRun`             a clean stop that preserves the work left to do;
// - `abortRun`            a SIGINT/SIGTERM interruption, from the signal handler;
// - `finalizeRun`         the verdict, the outcome and the totals of a run whose
//                         loop has returned, the `run.finished` event and the
//                         last snapshot.
//
// Restoration is not a transition and is not here: `boot/resume.ts` and
// `state/run-projection.ts` rebuild statuses from the snapshot and the journal.
// The persisted child references of a composed run have their own owner
// (`state/child-transitions.ts`). Attempt closure has its own owner
// (`state/attempt-closure.ts`); the figures belong to `state/cost-accounting.ts`.
//
// After `abortRun`, the run is settled by the interruption. What is still
// allowed: the closure of the killed attempt (done by `abortRun` itself), the
// accounting of figures that reach the ledger late, and `finalizeRun`, which
// keeps `ABORTED` — `deriveRunStatus` gives the interruption precedence — while
// it completes the outcome, the totals and the snapshot. What is refused, and
// changes neither memory nor snapshot: `updateStep`, `recordStepVerdict`,
// `absorbStepFailure` and `stopRun`. `saveRun` enforces the same rule for any
// other caller: a snapshot of an aborted run must carry `ABORTED`.

import type { StepControl, StepFailCause, StepFailKind } from "../contracts/backends.js";
import type { RunOutcomeStopKind, RunStopState } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import { closeAttempt } from "./attempt-closure.js";
import { aggregateControl, aggregateUsage } from "./cost-accounting.js";
import { appendRunEvent, relativeRunPath } from "./run-journal.js";
import { saveRun } from "./run-repository.js";
import { latestAttemptLog } from "./run-timeline.js";
import { deriveRunStatus, isResumableStatus } from "./run-verdict.js";

export function updateStep(run: Run, step: RunStep, status: RunStep["status"], errors?: string): void {
  if (run.aborted) return;
  step.status = status;
  if (status === "running") {
    step.started_at = new Date().toISOString();
    // A resume/retry must not retain an earlier terminal timestamp.
    delete step.finished_at;
    // Nor an earlier failure reason. `step.errors` survives every resume round
    // trip, so the `!step.errors` guard below would keep the first run's cause
    // forever and the final report would name a timeout long after the real
    // failure became a rejected patch or a verdict.
    delete step.errors;
    // Same reasoning for the nature of the failure: a run resumed after a
    // technical error that now stops on a verdict must be reported as a verdict.
    delete step.fail_kind;
    // And for the cause: a step replayed once the external obstacle is lifted
    // must not stay marked blocked.
    delete step.fail_cause;
  } else {
    step.finished_at = new Date().toISOString();
  }
  // Persist failure reason unless an error_extractor already supplied one.
  if (status === "failed" && errors && !step.errors) step.errors = errors;
  const attemptLog = latestAttemptLog(run, step);
  if (status === "running") {
    run.status = "RUNNING";
  } else if (status === "failed") {
    run.status = "FAIL";
    run.outcome = {
      phase: step.id,
      reason: step.errors ?? errors ?? null,
      logPath: relativeRunPath(run.run_dir, attemptLog),
      resumable: true,
      ...(step.fail_kind ? { failKind: step.fail_kind } : {}),
      ...(step.fail_cause ? { failCause: step.fail_cause } : {}),
    };
  }
  // Unconditional fields, never a conditional spread: excess-property checking
  // does not reach a spread, so a misspelled name would land in the journal.
  // `undefined` is dropped by `JSON.stringify`; the shape on disk is unchanged.
  appendRunEvent(run, "step.status.changed", {
    stepId: step.id,
    status,
    reason: errors || undefined,
    logPath: attemptLog ? relativeRunPath(run.run_dir, attemptLog) : undefined,
    // The journal is the only durable trace of a stop nobody can repair once the
    // snapshot has been rewritten by a later generation.
    failCause: step.fail_cause,
  });
  saveRun(run);
}

/** What one attempt established about the step it executed. */
export interface StepVerdict {
  ok: boolean;
  failKind?: StepFailKind;
  failCause?: StepFailCause;
}

/**
 * Record the verdict of the latest attempt on the step: `fail_kind` and
 * `fail_cause` are set on failure and cleared on success, and the next attempt
 * clears them again (`updateStep(running)`), so a step that stopped as blocked
 * and now fails for another reason is never reported as still blocked.
 *
 * Neither field is persisted here: the transition that follows (`updateStep`
 * to `failed`, or a clean stop) stamps the run outcome from them and writes
 * the snapshot. A run settled by an interruption ignores the verdict: the late
 * result of a killed attempt is not what the resumed step will answer.
 */
export function recordStepVerdict(run: Run, step: RunStep, verdict: StepVerdict): void {
  if (run.aborted) return;
  if (verdict.ok || !verdict.failKind) delete step.fail_kind;
  else step.fail_kind = verdict.failKind;
  if (verdict.ok || !verdict.failCause) delete step.fail_cause;
  else step.fail_cause = verdict.failCause;
}

/**
 * Settle a `blocking: false` step whose failure the run absorbs: the step is
 * `done`, and the reason stays visible in the snapshot, the timeline and the
 * stats. `reason` is the caller's decision — typically the failure reason, or
 * the one the fix loop already wrote on the step.
 */
export function absorbStepFailure(run: Run, step: RunStep, reason: string): void {
  if (run.aborted) return;
  step.errors = reason;
  updateStep(run, step, "done");
}

/** Finalize bookkeeping when the process receives SIGINT/SIGTERM.
 *  `estimatedCostUsd` carries the killed attempt's live spend estimate: without
 *  it the budget ledger loses everything the interrupted agent consumed. */
export function abortRun(run: Run, signal: "SIGINT" | "SIGTERM", options: { estimatedCostUsd?: number } = {}): void {
  const reason = `${signal}: run interrupted manually`;
  const now = new Date().toISOString();
  const activeStep = run.steps.find((step) => step.status === "running");
  const activeAttempt = activeStep
    ? [...(activeStep.attempts ?? [])].reverse().find((attempt) => attempt.status === "running")
    : undefined;
  const logPath =
    activeAttempt?.log_path ?? (activeStep ? relativeRunPath(run.run_dir, latestAttemptLog(run, activeStep)) : null);

  if (activeStep) {
    activeStep.status = "aborted";
    activeStep.finished_at = now;
    activeStep.errors = reason;

    if (activeAttempt) {
      const started = Date.parse(activeAttempt.started_at);
      const duration = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
      const abortedCost =
        options.estimatedCostUsd != null && options.estimatedCostUsd > 0 ? options.estimatedCostUsd : undefined;
      // `closeAttempt` applies the `cost_unknown` rule (agent or fix attempt
      // killed before a live estimate reached us) and merges into the step total.
      const control: StepControl = {
        duration_ms: duration,
        ...(abortedCost != null ? { total_cost_usd: abortedCost } : {}),
        model: activeStep.control?.model,
        provider: activeStep.control?.provider ?? activeStep.session?.provider,
        cost_estimated: true,
      };
      closeAttempt(run, activeStep, activeAttempt, { status: "aborted", control, reason });
    }

    appendRunEvent(run, "step.status.changed", {
      stepId: activeStep.id,
      status: "aborted",
      reason,
      logPath: logPath ?? undefined,
      // Absent in practice — an interruption is not a cause the step established
      // — but written unconditionally like every other field of this event, so
      // the two `step.status.changed` sites keep the same shape.
      failCause: activeStep.fail_cause,
    });
  }

  run.aborted = true;
  run.status = "ABORTED";
  run.outcome = {
    phase: activeStep?.id ?? null,
    reason,
    logPath,
    // A manual interruption resumes by default: completed steps are kept and the
    // aborted step is replayed from scratch (fresh attempt, no session resume).
    resumable: true,
  };
  run.total_control = aggregateControl(run.steps);
  run.total_usage = aggregateUsage(run.steps);
  appendRunEvent(run, "run.aborted", { status: run.status, reason, logPath });
  saveRun(run);
}

/**
 * Clean run stop: the run stops now, but the work left to do is preserved.
 *
 * Step statuses belong to the caller. A stop is not a decision about the
 * remaining steps: marking them `skipped` would erase the resume cursor, and
 * `resumeDecision` would then see a settled run and replay the whole pipeline —
 * including the steps already paid for. `stopped_reason` alone carries STOPPED
 * through `deriveRunStatus`.
 *
 * `stop` records what the caller already knows about the cause — the approval
 * subject that lifts it, the expected recovery, the undecorated reason — so a
 * reader does not have to parse the console sentence. It stays optional: an
 * admission that declares nothing still stops the run, and a snapshot written
 * before this field existed remains valid.
 */
export function stopRun(run: Run, step: RunStep, reason: string, stop?: RunStopState): void {
  if (run.aborted) return;
  run.stopped_reason = reason;
  run.status = "STOPPED";
  run.outcome = {
    phase: step.id,
    reason,
    logPath: relativeRunPath(run.run_dir, latestAttemptLog(run, step)),
    resumable: true,
    ...(stop ? { stop } : {}),
  };
  appendRunEvent(run, "run.stopped", {
    phase: step.id,
    reason,
    logPath: relativeRunPath(run.run_dir, latestAttemptLog(run, step)),
    stop,
  });
  saveRun(run);
}

/**
 * What the step loop reports when it returns: the signals only the loop knows,
 * absent from the steps themselves. `finalizeRun` turns them into the verdict;
 * the console report reads them to choose its headline.
 */
export interface RunOutcome {
  failed: boolean;
  stopped: boolean;
  budgetExceeded: boolean;
  /** Spending became unaccountable under a cost ceiling. A stop of its own, kept
   *  apart from `budgetExceeded`: the ledger never reached the ceiling, it simply
   *  stopped being a ceiling. */
  costUnaccounted: boolean;
  /** The accounting stop is what ended the run: a gate withheld the next unit of
   *  work (admission, retry, fix pass, child launch, callback) rather than a step
   *  failing for its own reason. `costUnaccounted` says the ledger is a lower
   *  bound; this says the ledger is the REASON, which is what the headline and the
   *  recovery command answer to. */
  costUnaccountedStop: boolean;
  cumulativeCost: number;
}

/** The loop signals `finalizeRun` needs. Every field is optional so a run that
 *  never entered the loop — a crash finalized on resume, a test fixture — is
 *  finalized from its steps alone. */
export type RunFinalizationSignals = Partial<RunOutcome>;

/**
 * The cost policy that ended the run, as a value.
 *
 * `budget-exceeded` wins over `cost-unaccounted`, the precedence `costDecision`
 * settled: the known lower bound is the harder fact of the two. Only a run whose
 * work was actually WITHHELD takes a kind — `costUnaccountedStop`, not
 * `costUnaccounted`: an unpriced ledger beside a step that failed for its own
 * reason is a caveat on the total, and labelling that run "stopped for cost"
 * would send a post-mortem to `--allow-unmetered` for a defect in the code.
 * `reportKind` ranks the two stops the same way.
 */
function stopKindOf(outcome: RunFinalizationSignals | undefined): RunOutcomeStopKind | undefined {
  if (outcome?.budgetExceeded) return "budget-exceeded";
  if (outcome?.costUnaccountedStop) return "cost-unaccounted";
  return undefined;
}

/**
 * The last transition of a run: its verdict, its normalized outcome, its totals,
 * the `run.finished` event and the snapshot, before the statistics projection.
 *
 * Called once the step loop has returned — by the top-level entry point, by the
 * parent for a composed child, and on resume for a run that crashed between its
 * last step and this call. It is the one transition allowed on an aborted run:
 * the verdict keeps `ABORTED`, and the outcome, the totals and the snapshot are
 * completed with what the loop learned before the interruption.
 */
export function finalizeRun(run: Run, outcome?: RunFinalizationSignals): void {
  run.total_control = aggregateControl(run.steps);
  run.total_usage = aggregateUsage(run.steps);
  const failed = run.steps.find((step) => step.status === "failed");
  const active = run.steps.find((step) => step.status === "running");
  const logPath = failed
    ? relativeRunPath(run.run_dir, latestAttemptLog(run, failed))
    : (run.outcome?.logPath ?? (active ? relativeRunPath(run.run_dir, latestAttemptLog(run, active)) : null));
  // Case precedence lives in run-verdict.ts, shared with projection.
  const status = deriveRunStatus(run, {
    failed: outcome?.failed,
    stopped: outcome?.stopped,
    budgetExceeded: outcome?.budgetExceeded,
    costUnaccounted: outcome?.costUnaccounted,
  });
  const resumable = isResumableStatus(status);
  run.status = status;
  // Every finalization rewrites the outcome, so it is stamped: a snapshot read
  // later says when its reason was established instead of passing off the first
  // failure of a resumed run as the current one.
  const at = new Date().toISOString();
  // A cost stop is a run-level decision, so it is stamped on the outcome instead
  // of being left to `reason`, whose wording is console text. `run.finished`
  // inherits it with the rest of the outcome, which is what makes a budget stop
  // machine-readable in the journal: `run.budget_exceeded` is wiped by a
  // `--budget` resume, and the failing step's `failKind` stays `technical`.
  const stopKind = stopKindOf(outcome);
  // What the offending step established about itself, read BEFORE `run.outcome`
  // is rebuilt below. Every finalization rewrites that object, so a field the new
  // one omits is lost: the step's own answer is the authority, and the previous
  // outcome the fallback for a resumed generation that no longer holds the step.
  const failKind = failed?.fail_kind ?? run.outcome?.failKind;
  const failCause = failed?.fail_cause ?? run.outcome?.failCause;
  const stop = run.outcome?.stop;
  if (status === "ABORTED") {
    run.outcome = {
      phase: failed?.id ?? active?.id ?? run.outcome?.phase ?? null,
      reason: run.outcome?.reason ?? "run stopped manually",
      logPath,
      resumable,
      at,
    };
  } else if (status === "STOPPED") {
    // A clean stop outranks the step's verdict as the RUN's status; it does not
    // erase what the step established. Rebuilding this outcome without the three
    // structured fields dropped them on the one path that always sets them: a
    // blocked step stops the run, so `outcome.failCause` was absent exactly when
    // it mattered, and a composed parent — which reads its child's FINALIZED
    // outcome — could never see its child's block.
    run.outcome = {
      phase: failed?.id ?? run.outcome?.phase ?? null,
      reason: run.stopped_reason ?? run.outcome?.reason ?? "clean stop",
      logPath: logPath ?? run.outcome?.logPath ?? null,
      resumable,
      at,
      ...(failKind ? { failKind } : {}),
      ...(failCause ? { failCause } : {}),
      ...(stop ? { stop } : {}),
    };
  } else if (status === "FAIL") {
    run.outcome = {
      phase: failed?.id ?? run.outcome?.phase ?? null,
      // The two cost stops keep their own words: an operator reading "budget
      // exceeded" would raise the ceiling, which does nothing for a spend nobody
      // could price. `exceeded` still wins when both hold, as in `costDecision`.
      // Only a run STOPPED for accounting takes that sentence: an unknown ledger
      // beside some other failure is a caveat on the total, not the reason.
      reason:
        failed?.errors ??
        run.outcome?.reason ??
        (outcome?.budgetExceeded
          ? "budget exceeded"
          : (outcome?.costUnaccountedStop ?? outcome?.costUnaccounted)
            ? "cost unaccounted"
            : "run failed"),
      logPath: logPath ?? run.outcome?.logPath ?? null,
      resumable,
      at,
      ...(failKind ? { failKind } : {}),
      ...(failCause ? { failCause } : {}),
      ...(stopKind ? { stopKind } : {}),
    };
  } else if (status === "PASS") {
    run.outcome = { phase: null, reason: null, logPath: null, resumable, at };
  } else {
    run.outcome = { phase: null, reason: "run not completed", logPath, resumable, at };
  }
  appendRunEvent(run, "run.finished", {
    status: run.status,
    outcome: run.outcome,
  });
  saveRun(run);
}
