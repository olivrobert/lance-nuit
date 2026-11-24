//
// Keep `blocking: false` handling in one place, so every guard absorbs a step
// failure into `step.errors` the same way regardless of which one caught it.

import type { RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import { absorbStepFailure, updateStep } from "../../run/index.js";

/**
 * Absorb a non-blocking step failure: keep the reason visible in JSON and the
 * timeline, and let the run continue. The step is not settled here: inside a pass
 * the caller returns `"succeeded"` and the pass writes `done`
 * (`step-pass.ts`); before any pass, `refuseStep` writes it.
 *
 * If `reason` is absent, preserve the reason already on the step (typically written
 * by the fix loop); use the generic label only as a last resort.
 *
 * `detail` completes the message label ("after 3 rerun(s)"), never `step.errors`:
 * that field is read by reports and stats and carries only the reason.
 *
 * `output` is required for the same reason as everywhere in the step loop: an
 * absorbed failure is a warning an operator must be able to read, so the caller
 * says where it goes instead of the message reaching for a global logger.
 */
export function absorbNonBlocking(
  run: RunView,
  step: RunStepView,
  output: RunOutput,
  reason?: string,
  detail?: string,
): void {
  const kept = reason ?? step.errors ?? "non-blocking failure";
  absorbStepFailure(run, step, kept);
  output.emit({
    type: "runner.message",
    level: "warn",
    message: `${step.def.name} — non-blocking warning${detail ? ` ${detail}` : ""}: ${kept}`,
  });
}

/**
 * Fail a step before any spawn whatever `blocking` says. For a fault of the
 * runner's own state (the freshness lock), not a verdict on the step: absorbed as
 * `done`, the step would settle without anyone knowing whether its work holds.
 */
export function failStep(run: RunView, step: RunStepView, output: RunOutput, reason: string): void {
  updateStep(run, step, "failed", reason);
  output.emit({ type: "step.failed", step, suffix: ` (${reason})` });
}

/**
 * Refuse a step before any spawn, with the blocking rule applied: a non-blocking
 * step absorbs the refusal and settles `done` here, since no pass will; a
 * blocking one fails. Used by admission guards.
 */
export function refuseStep(run: RunView, step: RunStepView, output: RunOutput, reason: string): { failed: boolean } {
  if (step.def.blocking === false) {
    absorbNonBlocking(run, step, output, reason);
    updateStep(run, step, "done");
    return { failed: false };
  }
  failStep(run, step, output, reason);
  return { failed: true };
}

/**
 * Settle a failure once its retry budget is spent, applying the blocking rule in
 * one place: a non-blocking step absorbs the failure and the run continues, a
 * blocking one is marked failed and reported. Every retry-loop epilogue must
 * end here — a direct `updateStep(failed)` would let a non-blocking step fail
 * the run.
 *
 * `costStopped` overrides `blocking: false`: a cost stop (a live guard's kill, or
 * a gate that withheld a retry or a repair) is the run's decision, not a verdict
 * on the step. Absorbed as `done`, the withheld work would never run again — a
 * resume skips done steps, even after `--budget` approved the spend.
 *
 * `absorbDetail` completes the absorb log line; `failSuffix` completes the
 * step.failed event of a blocking step.
 */
export function settleStepFailure(
  run: RunView,
  step: RunStepView,
  output: RunOutput,
  reason: string | undefined,
  labels: { absorbDetail?: string; failSuffix: string },
  costStopped = false,
): { failed: boolean } {
  if (step.def.blocking === false && !costStopped) {
    absorbNonBlocking(run, step, output, reason, labels.absorbDetail);
    return { failed: false };
  }
  updateStep(run, step, "failed", reason);
  output.emit({ type: "step.failed", step, suffix: labels.failSuffix });
  return { failed: true };
}
