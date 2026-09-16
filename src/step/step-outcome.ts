// runner/step/step-outcome.ts
//
// Resolve an attempt result: extraction, blocking, non-blocking, escalation, and
// on_failure dispatch. This phase does not know how spawn happened; it applies only
// verdict business rules.

import { backendSpecForStep } from "../contracts/backends.js";
import type { ExtractionResult } from "../contracts/extraction.js";
import type { extractErrors } from "../exec/report-extraction.js";
import type { executeStep, StepResult } from "../exec/runners.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Run, RunStep } from "../model/run.js";
import type { AbortScope } from "../runtime/abort.js";
import type { RunOutput } from "../runtime/run-output.js";
import { costDecision, type RunBudget } from "../state/budget.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import { latestAttemptLog } from "../state/run-timeline.js";
import { stopRun, updateStep } from "../state/run-transitions.js";
import type { runFixLoop } from "./fix-loop.js";
import { absorbNonBlocking } from "./non-blocking.js";
import { onFailureHandlerFor } from "./on-failure.js";
import { runAttempt } from "./step-attempt.js";

/** Step verdict for the orchestration loop. */
export type OutcomeAction = "continue" | "failed" | "stopped";

export interface ResolveOutcomeDeps {
  executeStep: typeof executeStep;
  extractErrors: typeof extractErrors;
  runFixLoop: typeof runFixLoop;
}

export interface ResolveOutcomeInput {
  run: Run;
  step: RunStep;
  command: string;
  baseCtx: PipelineContext;
  budget: RunBudget;
  /** Scope the retry and repair loops read; the verdict itself reads `run.aborted`. */
  abort: AbortScope;
  result: StepResult;
  stepLog: string;
  deps: ResolveOutcomeDeps;
  output: RunOutput;
}

/** Where the attempt's output landed, said once per settled failure. Informational:
 * the severity of the failure is already carried by the line above it. */
function emitOutputPath(output: RunOutput, stepLog: string): void {
  output.emit({ type: "runner.message", level: "info", message: `  📄 Output: ${stepLog}` });
}

/** What the re-ask sends into the resumed session. Deliberately not the step
 * command: the work is done and sits in the session, only the returned object is
 * wanted again. The backend re-declares the schema on its own, so the message
 * carries the one thing the schema could not say — why the object was refused. */
function reaskCommand(failReason: string | undefined): string {
  const refusal = failReason ? `: ${failReason}` : ".";
  return (
    `The structured output you returned was refused by the pipeline's output contract${refusal}\n` +
    "Do not redo the work. Return the structured output again, corrected so that it satisfies the contract."
  );
}

/** The cheap guard against insisting: a re-ask that hands back the very object
 * that was refused has nothing more to say. Key order comes from one parser, so
 * the serialized form is a faithful identity. */
function sameStructuredOutput(a: StepResult, b: StepResult): boolean {
  return JSON.stringify(a.structuredOutput) === JSON.stringify(b.structuredOutput);
}

/**
 * Ask the session that produced a refused structured output for a corrected one,
 * ONCE. The DSL keeps cross-field invariants out of the schema (`assertStrictSchema`
 * refuses combinators), so the artifact's parser is the only place a kit can
 * check them — and a pipeline cannot express the re-ask itself, since a step may
 * not resume its own session through `onFail`. The runner therefore owns it.
 *
 * A full attempt of its own (log, ledger, verdict), never a second spawn inside
 * the refused attempt: `finishAttempt` charges one result per attempt. Returns
 * the re-asked result, or `undefined` when no re-ask was made — no refusal, no
 * session to resume, a backend that cannot resume, or a budget that withholds it.
 */
async function reaskRefusedCapture(input: ResolveOutcomeInput): Promise<StepResult | undefined> {
  const { run, step, baseCtx, budget, result, deps } = input;
  if (!result.captureRefused) return undefined;
  const session = step.session;
  if (!session?.resumable) return undefined;
  const spec = backendSpecForStep(step.def);
  const backend = spec ? requireAgentBackendRegistry(baseCtx).resolve(spec) : undefined;
  if (!backend?.capabilities.resume) return undefined;

  // A withheld re-ask is withheld work, recorded like a withheld retry so the
  // report names the accounting stop rather than the step it left red.
  const cost = costDecision(run.max_cost_usd, budget);
  if (cost !== "continue") {
    input.output.emit({
      type: "runner.message",
      level: "warn",
      message: cost === "unaccounted" ? "  Spending unaccounted, no re-ask" : "  Budget exceeded, no re-ask",
    });
    recordCostStop(run, budget, cost, { kind: "gate", stepId: step.id });
    return undefined;
  }

  input.output.emit({
    type: "runner.message",
    level: "info",
    message: `  → Re-ask (1/1): output contract refused${result.failReason ? ` — ${result.failReason}` : ""}...`,
  });
  const reasked = await runAttempt(run, step, {
    command: reaskCommand(result.failReason),
    context: baseCtx,
    budget,
    executeStep: deps.executeStep,
    banner: "re-ask 1/1",
    spawn: { resumeSession: session },
  });
  if (reasked.captureRefused && sameStructuredOutput(reasked, result)) {
    input.output.emit({
      type: "runner.message",
      level: "warn",
      message: "  Re-ask returned the same refused output — not insisting",
    });
  }
  return reasked;
}

/**
 * Resolve an attempt and apply exactly one loop action: continue, stop cleanly, or
 * mark the run failed.
 */
export async function resolveOutcome(input: ResolveOutcomeInput): Promise<OutcomeAction> {
  const { run, step, command, baseCtx, deps } = input;
  if (run.aborted) return "stopped";
  // The re-ask comes first because its result is the one the verdict is read
  // from: a corrected object takes the success path below like any other. It
  // loses nothing to the failures that outrank it — a refused capture is by
  // construction neither a block nor a kill, since the command had succeeded.
  const reasked = await reaskRefusedCapture(input);
  if (run.aborted) return "stopped";
  const result = reasked ?? input.result;
  const stepLog = reasked ? (latestAttemptLog(run, step) ?? input.stepLog) : input.stepLog;
  const { output, ok } = result;
  // Persist the initial attempt failure reason on the step, or pass it to
  // on_failure handlers so their attempts can refine it.
  const lastFailReason = result.failReason;

  // A wall-clock timeout truncates output; no extractor error is not evidence of
  // success, so never force "done".
  const wasKilled = !!result.timedOut;
  // Extracted once and carried to the on_failure handlers: `extractErrors` is not
  // free, and the fix policy must decide on the very result that produced this
  // warning rather than on a second, possibly different, extraction.
  let extraction: ExtractionResult | undefined;
  if (!ok && !wasKilled && step.def.error_extractor) {
    extraction = await deps.extractErrors(step, output);
    if (run.aborted) return "stopped";
    if (!extraction.hasErrors) {
      input.output.emit({
        type: "runner.message",
        level: "warn",
        message: `  ${step.def.error_extractor} found no actionable error — exit code remains failed`,
      });
    }
  }

  if (ok) {
    if (run.aborted) return "stopped";
    updateStep(run, step, "done");
    input.output.emit({ type: "step.done", step });
    return "continue";
  }

  // `failCause: "blocked"` means a fix cannot resolve an obstacle outside the
  // code. The signal is a field, decided at the two boundaries that read agent
  // and extension text; this loop never parses prose.
  if (result.failCause === "blocked") {
    // A backend may report the cause without a message. The stop still needs a
    // detail: the reader is told what happened, not left with an empty reason.
    const blockedReason = lastFailReason ?? "blocked by an obstacle outside the code";
    if (step.def.blocking === false) {
      absorbNonBlocking(run, step, input.output, blockedReason);
      return "continue";
    }
    // The step ran and failed: keep it visible as a failure so the report names it
    // and a resume replays it once the external obstacle is lifted. `stopRun` then
    // overrides the run verdict, since a clean stop outranks the failure.
    updateStep(run, step, "failed", blockedReason);
    stopRun(run, step, blockedReason, { kind: "blocked", detail: blockedReason });
    input.output.emit({
      type: "runner.message",
      level: "info",
      message: `⏹ ${step.def.name} — non-code block, stopping without repair: ${blockedReason}`,
    });
    emitOutputPath(input.output, stepLog);
    return "stopped";
  }

  // Non-blocking checks remain visible in JSON and the timeline without stopping a
  // run that is otherwise valid.
  if (step.def.blocking === false && !step.def.on_failure) {
    absorbNonBlocking(run, step, input.output, lastFailReason);
    emitOutputPath(input.output, stepLog);
    return "continue";
  }

  if (!step.def.on_failure) {
    if (run.aborted) return "stopped";
    updateStep(run, step, "failed", lastFailReason);
    // A `fix: false` contract intentionally has no retry; report a final verdict
    // rather than making the absence of retry look like an omission. A refused
    // output contract is neither: the command succeeded, the returned object did
    // not, and the re-ask above is the runner's own answer to it.
    const noRetry =
      step.fail_kind === "verdict"
        ? " (final verdict, no fix configured)"
        : result.captureRefused
          ? " (output contract refused, no fix configured)"
          : " (no retry configured)";
    input.output.emit({
      type: "step.failed",
      step,
      suffix: `${noRetry}${lastFailReason ? ` — ${lastFailReason}` : ""}`,
    });
    emitOutputPath(input.output, stepLog);
    return "failed";
  }

  const outcome = await onFailureHandlerFor(step.def.on_failure)({
    run,
    step,
    command,
    output,
    baseCtx,
    budget: input.budget,
    abort: input.abort,
    lastFailReason,
    timedOut: result.timedOut ?? false,
    ...(extraction ? { extraction } : {}),
    runOutput: input.output,
    deps: { executeStep: deps.executeStep, runFixLoop: deps.runFixLoop },
  });
  if (run.aborted) return "stopped";
  return outcome.failed ? "failed" : "continue";
}
