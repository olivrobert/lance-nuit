//
// What happens to a step once admission has answered: a refusal becomes the stop it
// asks of the loop, and an admitted step gets its pass (the transition to `running`,
// the attempt or the composed call, then the verdict). Which step comes next stays
// with the loop; a pass only tells it whether it may go on.

import { join } from "node:path";
import { backendSpecForStep } from "../../contracts/backends.js";
import type { extractErrors } from "../report-extraction.js";
import type { executeStep, StepResult } from "../runners.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import type { RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import type { AbortScope } from "../abort.js";
import { emitRunnerEvent } from "../../shared/runtime/events.js";
import {
  inheritChildBudgetStop,
  latestAttemptLog,
  recordAbsorbedInputs,
  type RunBudget,
  updateStep,
} from "../../run/index.js";
import { fingerprintInputs, pureInputsOf } from "../../work-items/index.js";

import type { runFixLoop } from "./fix-loop.js";
import { executePipelineOrchestration } from "./pipeline-orchestration.js";
import { answersToOutputs, type StepAdmission } from "./step-admission.js";
import { runAttempt, startFreshSession } from "./step-attempt.js";
import { resolveOutcome } from "./step-outcome.js";

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
  /** The mode as boot read it from the definition the steps come from. */
  reconcile: boolean;
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
  return { result, stepLog: latestAttemptLog(run, step) ?? join(stepLogDir, "attempt-001", "output.log") };
}

/** Run one admitted step to its verdict. Returns the stop it asks of the loop, or
 *  nothing when the loop may go on. */
export async function runStepPass(
  env: StepPassEnv,
  step: RunStepView,
  { command, stepLogDir }: Extract<StepAdmission, { kind: "ready" }>,
): Promise<StepLoopStop | undefined> {
  const { run, baseCtx, budget, abort, deps } = env;
  const stepIndex = run.steps.indexOf(step) + 1;
  deps.output.emit({ type: "step.started", step, index: stepIndex, total: run.steps.length });
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

  const action = await resolveOutcome({
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
  // `updateStep(running)` cleared `errors` for this pass, so a `done` step
  // carrying one absorbed its failure. Fingerprinted here, after any fix that
  // rewrote the inputs and before a later step can: a resume then re-checks
  // the step only when something else changed them. In reconcile mode a step
  // without input answers to its missing outputs too, so it needs the same
  // record (an empty one) not to replay its failure on every invocation.
  if (answersToOutputs(step.def, env.reconcile) && step.status === "done" && step.errors !== undefined) {
    recordAbsorbedInputs(run, step, await fingerprintInputs(baseCtx, pureInputsOf(step.def)));
  }
  if (action === "failed") return { failed: true };
  if (action === "stopped") return { stopped: true };
  return undefined;
}
