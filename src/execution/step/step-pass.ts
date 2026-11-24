//
// What happens to a step once admission has answered: a refusal becomes the stop it
// asks of the loop, and an admitted step gets its pass (the transition to `running`,
// the attempt or the composed call, the verdict, the review). Which step comes next
// stays with the loop; a pass only tells it whether it may go on.
//
// A pass owns two things nobody else writes: the `done` of the step it ran, and its
// stamp in the freshness lock — cleared before the first spawn, written once that
// `done` is saved, never written for a pass that did not settle `done`.

import { basename, join } from "node:path";
import { backendSpecForStep } from "../../contracts/backends.js";
import type { extractErrors } from "../report-extraction.js";
import type { executeStep, StepResult } from "../runners.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import { errorMessage } from "../../shared/lib/errors.js";
import type { RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import type { AbortScope } from "../abort.js";
import { emitRunnerEvent } from "../../shared/runtime/events.js";
import {
  inheritChildBudgetStop,
  latestAttemptLog,
  logicalAttemptLogPath,
  type RunBudget,
  recordUnavailableSource,
  updateStep,
} from "../../run/index.js";
import {
  clearStamp,
  commitPass,
  type Freshness,
  isSource,
  readInputs,
  stampKey,
  type StepStamp,
} from "../../work-items/index.js";

import type { runFixLoop } from "./fix-loop.js";
import { failStep } from "./non-blocking.js";
import { executePipelineOrchestration } from "./pipeline-orchestration.js";
import type { StepAdmission } from "./step-admission.js";
import { runAttempt, startFreshSession } from "./step-attempt.js";
import { type ResolvedOutcome, resolveOutcome } from "./step-outcome.js";
import { runReviewPhase } from "./step-review.js";

export interface StepLoopDeps {
  executeStep: typeof executeStep;
  extractErrors: typeof extractErrors;
  runFixLoop: typeof runFixLoop;
  /** Structured destination for step progress AND for the loop's own messages.
   * Required, and so is `deps` itself on `executeRunSteps`: the port carries the
   * prose as well as the events, so a caller that omitted it would run mute. A
   * caller that wants that says so with `NULL_RUN_OUTPUT`. */
  output: RunOutput;
}

/**
 * Why the loop must not go on after a step, in the terms of `RunOutcome`. No field
 * set is an interruption: the loop ends and the run's `aborted` flag carries the
 * verdict, so the stop has nothing to add to it.
 */
export interface StepLoopStop {
  failed?: boolean;
  stopped?: boolean;
  budgetExceeded?: boolean;
  costUnaccounted?: boolean;
  costUnaccountedStop?: boolean;
}

export const INTERRUPTED: StepLoopStop = {};

/** The stop a refused admission asks for. */
export function admissionStop(admission: Exclude<StepAdmission, { kind: "skip" | "ready" }>): StepLoopStop {
  switch (admission.kind) {
    case "budget-exceeded":
      return { budgetExceeded: true };
    // Not routed through the non-blocking absorber: an unaccountable spend is a
    // run-level fact, not this step's failure, so `blocking: false` cannot
    // swallow it and keep spending.
    case "cost-unaccounted":
      return { costUnaccounted: true, costUnaccountedStop: true };
    case "stopped":
      return { stopped: true };
    case "failed":
      return { failed: true };
  }
}

/** What every pass of one execution shares. */
export interface StepPassEnv {
  run: RunView;
  baseCtx: PipelineContext;
  /** The one ledger of this execution. */
  budget: RunBudget;
  abort: AbortScope;
  replayInterrupted?: boolean;
  deps: StepLoopDeps;
}

function emitPipelineStep(run: RunView, step: RunStepView, index: number, total: number): void {
  // Keep the existing pipeline-step event on the runtime bus. Other progress
  // events use the injected output fan-out below.
  emitRunnerEvent({
    type: "pipeline-step",
    id: step.id,
    name: step.def.name,
    index,
    total,
    pipeline: run.pipeline,
    ticket: run.ticket,
  });
}

/**
 * Initial step attempt: create a fresh session when the backend provides one, then
 * run the attempt once. The backend owns context-window management,
 * including compaction; the runner does not kill or recreate a session for it.
 *
 * `budgetRemaining` is not set here; the attempt reserves it at spawn time, as it
 * does for retries and fixes.
 */
async function runInitialAttempt(input: {
  run: RunView;
  step: RunStepView;
  command: string;
  context: PipelineContext;
  stepLogDir: string;
  budget: RunBudget;
  executeStep: typeof executeStep;
  output: RunOutput;
}): Promise<{ result: StepResult; stepLog: string }> {
  const { run, step, stepLogDir } = input;
  const agentSpec = backendSpecForStep(step.def);
  const agentBackend = agentSpec ? requireAgentBackendRegistry(input.context).resolve(agentSpec) : undefined;
  const initialSession = startFreshSession(run, step, agentBackend);
  if (initialSession) {
    input.output.emit({ type: "step.session", step, sessionId: initialSession.id });
  }
  input.output.emit({
    type: "step.logs",
    step,
    path: stepLogDir,
    live: !!agentBackend?.capabilities.streaming,
  });

  const result = await runAttempt(run, step, {
    command: input.command,
    context: input.context,
    budget: input.budget,
    executeStep: input.executeStep,
    spawn: { session: step.session },
  });
  return { result, stepLog: latestAttemptLog(run, step) ?? join(run.run_dir, logicalAttemptLogPath(step.id, 1)) };
}

/** Run one admitted step to its verdict. Returns the stop it asks of the loop, or
 *  nothing when the loop may go on. */
export async function runStepPass(
  env: StepPassEnv,
  step: RunStepView,
  admission: Extract<StepAdmission, { kind: "ready" }>,
): Promise<StepLoopStop | undefined> {
  const { run, deps } = env;
  const stepIndex = run.steps.indexOf(step) + 1;
  deps.output.emit({ type: "step.started", step, index: stepIndex, total: run.steps.length });
  try {
    return await passStartedStep(env, step, admission, stepIndex);
  } finally {
    deps.output.emit({ type: "step.ended", step });
  }
}

/**
 * What the pass of a stamped step vouches for once settled `done`: the artifact
 * inputs as its admission read them, the sources and the outputs as they are now.
 * An absorbed failure vouches for no output: a step declaring some gets no stamp.
 */
async function passStamp(env: StepPassEnv, step: RunStepView, admitted: Freshness): Promise<StepStamp | undefined> {
  const { run, baseCtx } = env;
  const outputs = step.def.outputs ?? [];
  const absorbed = step.errors !== undefined;
  if (absorbed && outputs.length > 0) return undefined;
  const sources = await readInputs(baseCtx, (step.def.sources ?? []).filter(isSource));
  for (const unavailable of sources.unavailable) recordUnavailableSource(run, step, unavailable);
  const produced = await readInputs(baseCtx, outputs);
  const hashes: Record<string, string> = {};
  for (const [key, hash] of Object.entries(produced.fingerprints)) {
    // An output gone since its `require`: nothing to vouch for, so the step runs next time.
    if (hash === null) return undefined;
    hashes[key] = hash;
  }
  return {
    pipeline: run.pipeline,
    // A run's directory is named after its id; an old snapshot may lack the field.
    runId: run.runId ?? basename(run.run_dir),
    stampedAt: new Date().toISOString(),
    inputs: { ...admitted.inputs, ...sources.fingerprints },
    outputs: hashes,
    ...(absorbed ? { absorbed: true as const } : {}),
  };
}

/** Write the stamp of a pass that settled `done`. A failure leaves the step `done`
 *  without a stamp, which only makes it run again: said, never fatal. */
async function stampPass(env: StepPassEnv, step: RunStepView, admitted: Freshness): Promise<void> {
  try {
    commitPass(env.baseCtx, stampKey(step.id, env.baseCtx.lot), await passStamp(env, step, admitted), []);
  } catch (error) {
    env.deps.output.emit({
      type: "runner.message",
      level: "warn",
      message: `${step.def.name} — not stamped, it will run again: ${errorMessage(error)}`,
    });
  }
}

/** The verdict of the produce phase, then of the review when the step declares one. */
async function passVerdict(env: StepPassEnv, step: RunStepView, produced: ResolvedOutcome): Promise<ResolvedOutcome> {
  if (produced.action !== "succeeded" || !step.def.review) return produced;
  const { run, baseCtx, budget, abort, deps } = env;
  return runReviewPhase({ run, step, baseCtx, budget, abort, output: deps.output });
}

async function passStartedStep(
  env: StepPassEnv,
  step: RunStepView,
  { command, stepLogDir, freshness }: Extract<StepAdmission, { kind: "ready" }>,
  stepIndex: number,
): Promise<StepLoopStop | undefined> {
  const { run, baseCtx, budget, abort, deps } = env;
  if (freshness) {
    try {
      clearStamp(baseCtx, stampKey(step.id, baseCtx.lot));
    } catch (error) {
      failStep(run, step, deps.output, `freshness lock: ${errorMessage(error)}`);
      return { failed: true };
    }
  }
  updateStep(run, step, "running");
  emitPipelineStep(run, step, stepIndex, run.steps.length);

  if (step.def.runner === "pipeline") {
    const orchestration = await executePipelineOrchestration({
      run,
      step,
      baseCtx,
      budget,
      abort,
      replayInterrupted: env.replayInterrupted,
      output: deps.output,
    });
    if (abort.isRunAborted(run)) return INTERRUPTED;
    // A child stopped by its guard stops the parent the same durable way.
    if (orchestration.budgetExceeded) inheritChildBudgetStop(run, budget);
    if (orchestration.action === "continue") return undefined;
    return {
      failed: orchestration.action === "failed",
      stopped: orchestration.action === "stopped",
      budgetExceeded: orchestration.budgetExceeded,
      costUnaccounted: orchestration.costUnaccounted === true,
      // A fan-out that refused to launch the next child, or a child that
      // stopped at its own gate, is an accounting stop the parent reports as
      // one: the failed node is the carrier of the stop, not a defect to fix.
      costUnaccountedStop: orchestration.costUnaccountedStop === true,
    };
  }

  const attempt = await runInitialAttempt({
    run,
    step,
    command,
    context: baseCtx,
    stepLogDir,
    budget,
    executeStep: deps.executeStep,
    output: deps.output,
  });
  if (abort.isRunAborted(run)) return INTERRUPTED;

  const produced = await resolveOutcome({
    run,
    step,
    command,
    baseCtx,
    budget,
    abort,
    result: attempt.result,
    stepLog: attempt.stepLog,
    deps: {
      executeStep: deps.executeStep,
      extractErrors: deps.extractErrors,
      runFixLoop: deps.runFixLoop,
    },
    output: deps.output,
  });
  if (abort.isRunAborted(run)) return INTERRUPTED;
  const verdict = await passVerdict(env, step, produced);
  if (abort.isRunAborted(run)) return INTERRUPTED;
  if (verdict.action === "failed") return { failed: true };
  if (verdict.action === "stopped") return { stopped: true };
  // `updateStep(running)` cleared `errors` for this pass, so a step carrying one
  // absorbed its failure, which its warning already said.
  updateStep(run, step, "done");
  if (step.errors === undefined) deps.output.emit({ type: "step.done", step, suffix: verdict.doneSuffix });
  if (freshness) await stampPass(env, step, freshness);
  return undefined;
}
