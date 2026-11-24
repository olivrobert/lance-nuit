//
// The review phase of a step declaring `review`, once its produce phase
// succeeded: review attempts in fresh sessions until one returns its capture,
// then at most one fix in the producing session. It never writes `done`: it
// returns to the pass, which settles the step and writes its one stamp.

import { appendFileSync } from "node:fs";
import { backendSpecForStep } from "../../contracts/backends.js";
import { fixProfileOptions } from "../../definition/index.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { DEFAULT_PROCESS_TIMEOUT_MS } from "../../shared/process/process-runner.js";
import {
  type PipelineContext,
  requireAgentBackendRegistry,
  resolveTemplateAsync,
} from "../../shared/language/context.js";
import type { RunStepView, RunView } from "../../run/index.js";
import { bindSession, costGate, type RunBudget, reportLiveCost, strictCostAccountingFor } from "../../run/index.js";
import type { AbortScope } from "../abort.js";
import type { RunOutput } from "../run-output.js";
import { artifactScopeFor, invokeBackend, runWithAgent, type StepResult } from "../runners.js";
import { settleStepFailure } from "./non-blocking.js";
import { produceOutputs, readCaptures, refusedCaptureEntry, runFixAttempt, runTrackedAttempt } from "./step-attempt.js";
import { failed, INTERRUPTED, type StepIssue } from "./step-issue.js";

export interface ReviewPhaseInput {
  run: RunView;
  step: RunStepView;
  baseCtx: PipelineContext;
  budget: RunBudget;
  abort: AbortScope;
  output: RunOutput;
}

function fail(input: ReviewPhaseInput, reason: string, costStopped = false): StepIssue {
  settleStepFailure(input.run, input.step, input.output, reason, { failSuffix: ` — ${reason}` }, costStopped);
  return failed();
}

/** A gate that withholds the next review or fix stops the run without spawning it. */
function withheld(input: ReviewPhaseInput, what: string): StepIssue | undefined {
  const stop = costGate(input.run, input.budget, input.step.id);
  if (!stop) return undefined;
  const why = stop === "cost-unaccounted" ? "Spending unaccounted" : "Budget exceeded";
  input.output.emit({ type: "runner.message", level: "warn", message: `  ${why}, no ${what}` });
  return fail(input, `${why.toLowerCase()} before the ${what}`, true);
}

/** One review attempt: a fresh session on the review's backend, its capture
 *  added to the verdict, written once accepted. */
async function reviewAttempt(input: ReviewPhaseInput, label: string): Promise<StepResult> {
  const { run, step, baseCtx, budget } = input;
  const review = step.def.review!;
  const registry = requireAgentBackendRegistry(baseCtx);
  const command = (await resolveTemplateAsync(review.command, baseCtx))!;
  const session = registry.resolve(review.backend).createSession?.();
  return runTrackedAttempt<StepResult>({
    run,
    step,
    kind: "review",
    command,
    budget,
    banner: label,
    spawn: { session },
    invoke: async (ctx) => {
      const result = await invokeBackend({
        spec: review.backend,
        prompt: ctx.command,
        cwd: baseCtx.cwd,
        runnerDir: baseCtx.runnerDir,
        role: review.profile,
        intent: "step",
        outputFormat: "json",
        outputFields: { [review.capture.field]: review.capture.schema },
        options: review.backend.options,
        timeoutMs: step.def.timeout ? step.def.timeout * 1000 : DEFAULT_PROCESS_TIMEOUT_MS,
        budgetRemaining: ctx.budgetRemaining,
        strictCostAccounting: strictCostAccountingFor(run.max_cost_usd, budget.allowUnmetered),
        onLiveCost: (costUsd, model) => reportLiveCost(run, step, costUsd, model),
        session,
        stepLogPath: ctx.stepLogPath,
        artifactScope: artifactScopeFor(baseCtx),
        registry,
      });
      if (!result.ok) return result;
      try {
        for (const { capture, value } of readCaptures([review.capture], result.structuredOutput)) {
          await capture.artifact.write(baseCtx, value);
        }
        await review.capture.artifact.require(baseCtx);
      } catch (error) {
        const failReason = errorMessage(error);
        if (ctx.stepLogPath) appendFileSync(ctx.stepLogPath, refusedCaptureEntry(failReason, result.structuredOutput));
        return { ...result, ok: false, failReason, captureRefused: true };
      }
      return result;
    },
  });
}

/** Review attempts, plain reruns included. Returns the outcome when the phase
 *  ends here, `undefined` once a review returned its capture. */
async function reviewUntilCaptured(input: ReviewPhaseInput): Promise<StepIssue | undefined> {
  const { run, abort, output } = input;
  const total = 1 + input.step.def.review!.retries;
  let lastFailReason: string | undefined;
  for (let attempt = 1; attempt <= total; attempt++) {
    const stop = withheld(input, "review");
    if (stop) return stop;
    output.emit({ type: "runner.message", level: "info", message: `  → Review (${attempt}/${total})...` });
    let result: StepResult;
    try {
      result = await reviewAttempt(input, `review ${attempt}/${total}`);
    } catch (error) {
      if (abort.isRunAborted(run)) return INTERRUPTED;
      lastFailReason = `review: ${errorMessage(error)}`;
      continue;
    }
    if (abort.isRunAborted(run)) return INTERRUPTED;
    if (result.ok) return undefined;
    lastFailReason = result.failReason ?? "review failed";
    if (result.budgetExceeded || result.costUnaccounted) return fail(input, lastFailReason, true);
  }
  return fail(input, `review failed after ${total} attempt(s): ${lastFailReason}`);
}

/** The fix: exactly one attempt resuming the producing session, whatever its
 *  size, then every produce output must hold. */
async function fixInProducingSession(input: ReviewPhaseInput, prompt: string): Promise<StepIssue | undefined> {
  const { run, step, baseCtx, budget, abort } = input;
  const spec = backendSpecForStep(step.def);
  const session = step.session;
  if (!spec || !session?.resumable || session.provider !== spec.id) {
    return fail(input, "review fix: the step has no session to resume");
  }
  const stop = withheld(input, "review fix");
  if (stop) return stop;
  const registry = requireAgentBackendRegistry(baseCtx);
  const role = step.def.review!.fix_profile;
  const options = role
    ? (fixProfileOptions(role, spec, spec.options, baseCtx.config.profiles, registry)?.options ?? spec.options)
    : spec.options;
  input.output.emit({ type: "runner.message", level: "info", message: `  → Review fix in the session of the step...` });
  const fix = await runFixAttempt(run, step, {
    prompt,
    budget,
    fixWithAgent: runWithAgent,
    backendSpec: spec,
    agentOptions: options,
    banner: "review fix",
    spawn: {
      cwd: baseCtx.cwd,
      runnerDir: baseCtx.runnerDir,
      role: role ?? step.profile,
      artifactScope: artifactScopeFor(baseCtx),
      resumeSession: session,
    },
    registry,
  });
  if (abort.isRunAborted(run)) return INTERRUPTED;
  bindSession(run, step, fix.session ?? session);
  if (!fix.ok) {
    return fail(
      input,
      `review fix failed: ${fix.failReason ?? "no reason"}`,
      !!(fix.budgetExceeded || fix.costUnaccounted),
    );
  }
  try {
    for (const artifact of produceOutputs(step.def)) await artifact.require(baseCtx);
  } catch (error) {
    return fail(input, `after the review fix: ${errorMessage(error)}`);
  }
  return undefined;
}

/** Run the review phase. `succeeded` leaves the step to the pass to settle. */
export async function runReviewPhase(input: ReviewPhaseInput): Promise<StepIssue> {
  const { run, step, baseCtx, abort } = input;
  const review = step.def.review!;
  const ended = await reviewUntilCaptured(input);
  if (ended) return ended;
  let prompt: string | undefined;
  try {
    prompt = await review.fix(await review.capture.artifact.require(baseCtx), baseCtx);
  } catch (error) {
    return fail(input, `review fix prompt: ${errorMessage(error)}`);
  }
  if (abort.isRunAborted(run)) return INTERRUPTED;
  if (!prompt?.trim()) return { kind: "done", suffix: " (reviewed)" };
  const fixed = await fixInProducingSession(input, prompt);
  return fixed ?? { kind: "done", suffix: " (reviewed, fixed)" };
}
