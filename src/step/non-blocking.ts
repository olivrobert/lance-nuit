// runner/step/non-blocking.ts
//
// Keep `blocking: false` handling in one place, so every guard absorbs a step
// failure into `step.errors` the same way regardless of which one caught it.

import type { Run, RunStep } from "../model/run.js";
import type { RunOutput } from "../runtime/run-output.js";
import { absorbStepFailure, updateStep } from "../state/run-transitions.js";

/**
 * Absorb a non-blocking step failure: keep the reason visible in JSON and the
 * timeline, mark the step `done`, and continue the run.
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
export function absorbNonBlocking(run: Run, step: RunStep, output: RunOutput, reason?: string, detail?: string): void {
  const kept = reason ?? step.errors ?? "non-blocking failure";
  absorbStepFailure(run, step, kept);
  output.emit({
    type: "runner.message",
    level: "warn",
    message: `${step.def.name} — non-blocking warning${detail ? ` ${detail}` : ""}: ${kept}`,
  });
}

/**
 * Settle a failure once its retry budget is spent, applying the blocking rule in
 * one place: a non-blocking step absorbs the failure and the run continues, a
 * blocking one is marked failed and reported. Every retry-loop epilogue must
 * end here — a direct `updateStep(failed)` would let a non-blocking step fail
 * the run.
 *
 * `absorbDetail` completes the absorb log line; `failSuffix` completes the
 * step.failed event of a blocking step.
 */
export function settleStepFailure(
  run: Run,
  step: RunStep,
  output: RunOutput,
  reason: string | undefined,
  labels: { absorbDetail?: string; failSuffix: string },
): { failed: boolean } {
  if (step.def.blocking === false) {
    absorbNonBlocking(run, step, output, reason, labels.absorbDetail);
    return { failed: false };
  }
  updateStep(run, step, "failed", reason);
  output.emit({ type: "step.failed", step, suffix: labels.failSuffix });
  return { failed: true };
}
