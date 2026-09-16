// runner/step/on-failure.ts
//
// `on_failure` handlers. A policy without `fix_prompt` replays the command; with one,
// it repairs then replays. Both share step-attempt.ts's middleware chain, so
// step-loop only picks the branch.

import { backendSpecForStep } from "../contracts/backends.js";
import type { ExtractionResult } from "../contracts/extraction.js";
import type { executeStep } from "../exec/runners.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { StepFailure } from "../model/definition.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunOutput } from "../runtime/run-output.js";
import type { AbortScope } from "../runtime/abort.js";
import { costDecision, type RunBudget } from "../state/budget.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import { saveRun } from "../state/run-repository.js";
import { updateStep } from "../state/run-transitions.js";
import { type EscalationLadder, EscalationLatch, escalationLadderFor } from "./escalation.js";
import type { runFixLoop } from "./fix-loop.js";
import { settleStepFailure } from "./non-blocking.js";
import { runAttempt, startFreshSession } from "./step-attempt.js";

export interface OnFailureContext {
  run: Run;
  step: RunStep;
  /** Resolved step command. */
  command: string;
  /** Last attempt output, used by the first fix_prompt. */
  output: string;
  baseCtx: PipelineContext;
  /** Run budget mutated by each attempt. */
  budget: RunBudget;
  /** Abort scope the loops consult between attempts. Required: an interruption
   *  of the process must end a rerun loop of an in-process child run, which never
   *  receives `run.aborted`. */
  abort: AbortScope;
  /** Last known failure reason, persisted when no better reason appears. */
  lastFailReason?: string;
  /** Whether the initial attempt timed out; seeds timeout rerun handling. */
  timedOut: boolean;
  /** Extraction of the failed attempt, already computed by the outcome phase.
   *  Absent when the step declares no extractor or when the attempt was killed, in
   *  which case no policy may conclude anything from the extraction. */
  extraction?: ExtractionResult;
  runOutput: RunOutput;
  deps: {
    executeStep: typeof executeStep;
    runFixLoop: typeof runFixLoop;
  };
}

export interface OnFailureOutcome {
  /** True when the run stops for a blocking failure. */
  failed: boolean;
}

export type OnFailureHandler = (ctx: OnFailureContext) => Promise<OnFailureOutcome>;

/** Only the behavior that differs between retry loops; plain rerun and timeout
 * drain loops differ only in these fields. */
interface RetryLoopSpec {
  /** Consumed quota, separate per loop so timeout drain cannot consume fix quota. */
  counter: "retries" | "timeout_retries";
  /** Log line label. */
  label: string;
  /** Step-log separator. */
  banner: string;
  /** Additional entry condition; absent means quota alone bounds the loop. */
  while?: (state: RetryLoopState) => boolean;
  /** Escalation axes, if configured; absent means an identical rerun. */
  ladder?: EscalationLadder;
  escalateAfter?: number;
}

/** Rolling retry-loop state, also used as its return value. */
interface RetryLoopState {
  /** Attempts consumed by this loop. */
  attempts: number;
  /** Last attempt verdict: timed out, successful, or interrupted. */
  timedOut: boolean;
  ok: boolean;
  aborted: boolean;
  output: string;
  lastFailReason?: string;
}

/**
 * Replay the step command until quota exhaustion, using a fresh session each time.
 * Shared mechanics—budget guard, escalation latch, counter, snapshot, middleware
 * spawn, and verdict reporting—live here; strategies provide only their epilogue.
 */
async function retryStepCommand(ctx: OnFailureContext, spec: RetryLoopSpec): Promise<RetryLoopState> {
  const { run, step, command, baseCtx, budget, abort, deps, runOutput } = ctx;
  const backendSpec = backendSpecForStep(step.def);
  const backend = backendSpec ? requireAgentBackendRegistry(baseCtx).resolve(backendSpec) : undefined;
  const maxRetries = step.def.on_failure!.max_retries;
  const latch = new EscalationLatch(spec.ladder ?? {}, spec.escalateAfter);

  const consumed = () => step[spec.counter] ?? 0;
  const state: RetryLoopState = {
    attempts: consumed(),
    timedOut: ctx.timedOut,
    ok: false,
    aborted: false,
    output: ctx.output,
    lastFailReason: ctx.lastFailReason,
  };

  while (!abort.isRunAborted(run) && (spec.while?.(state) ?? true) && consumed() < maxRetries) {
    // Both cost stops end the loop, and neither is a technical failure to repair:
    // the step keeps the reason of its own last attempt, and the run reports the
    // accounting stop.
    const cost = costDecision(run.max_cost_usd, budget);
    if (cost !== "continue") {
      runOutput.emit({
        type: "runner.message",
        level: "warn",
        message:
          cost === "unaccounted" ? "  Spending unaccounted, stopping retries" : "  Budget exceeded, stopping retries",
      });
      // A withheld retry is withheld work: recorded so the report names the
      // accounting stop rather than the step it left red.
      recordCostStop(run, budget, cost, { kind: "gate", stepId: step.id });
      break;
    }

    // Before incrementing: the counter represents attempts already made (the
    // fix loop advances its latch at the same point).
    if (spec.ladder && latch.advance({ timedOut: state.timedOut, retries: consumed() })) {
      runOutput.emit({
        type: "runner.message",
        level: "info",
        message: `  ↑ Escalate ${step.def.name} → ${latch.label()} (reason: ${state.timedOut ? "timeout" : "threshold"})`,
      });
    }

    step[spec.counter] = consumed() + 1;
    const freshSession = startFreshSession(step, backend);
    saveRun(run);
    state.attempts = consumed();

    // A step without a backend (bash, noop) has no escalation axes; only its
    // counter changes.
    const attemptOptions = spec.ladder
      ? backend?.applyEscalation?.(backendSpec?.options ?? {}, latch.axes())
      : undefined;
    const rungLabel = latch.rung === "none" ? "" : ` [${latch.label()}]`;
    runOutput.emit({
      type: "runner.message",
      level: "info",
      message: `  → ${spec.label} (${state.attempts}/${maxRetries})${rungLabel}...`,
    });

    const retry = await runAttempt(run, step, {
      command,
      context: baseCtx,
      budget,
      executeStep: deps.executeStep,
      banner: `${spec.banner} ${state.attempts}/${maxRetries}`,
      spawn: {
        session: freshSession,
        ...(attemptOptions !== undefined ? { agentOptions: attemptOptions } : {}),
      },
    });
    if (abort.isRunAborted(run)) {
      state.aborted = true;
      return state;
    }
    // Arm the timeout fast path for the next iteration (sticky latch).
    state.timedOut = retry.timedOut ?? false;
    if (retry.failReason) state.lastFailReason = retry.failReason;
    state.output = retry.output;
    if (retry.ok) {
      state.ok = true;
      break;
    }
  }

  state.aborted = !!abort.isRunAborted(run);
  return state;
}

/** No fix prompt: replay the command up to max_retries with escalation latch. */
export const rerunHandler: OnFailureHandler = async (ctx) => {
  const { run, step } = ctx;
  const failure = step.def.on_failure!;
  const state = await retryStepCommand(ctx, {
    counter: "retries",
    label: "Rerun",
    banner: "rerun",
    ladder: escalationLadderFor(failure),
    escalateAfter: failure.escalate_after,
  });

  if (state.aborted) return { failed: false };
  if (state.ok) {
    updateStep(run, step, "done");
    ctx.runOutput.emit({ type: "step.done", step, suffix: ` (after ${state.attempts} reruns)` });
    return { failed: false };
  }
  return settleStepFailure(run, step, ctx.runOutput, state.lastFailReason, {
    absorbDetail: `after ${state.attempts} rerun(s)`,
    failSuffix: ` after ${state.attempts} reruns`,
  });
};

/** Timeout-drain result: final verdict or input for the fix loop. */
interface TimeoutDrainResult {
  /** Set when draining concludes the step (success or persistent timeout). */
  outcome?: OnFailureOutcome;
  output: string;
  lastFailReason?: string;
}

/**
 * A timeout is not a FAIL verdict: output is truncated and the code may be fine.
 * Replay in a fresh session until an authentic verdict; only that verdict deserves
 * a fix pass. Without draining, a timed-out reviewer sent a blind fix into the
 * coder session and inflated it by rereading screenshots.
 *
 * The drain has its own quota (`step.timeout_retries`). Sharing `step.retries` could
 * exhaust the fix-loop budget before it ran, failing the step without a fix pass.
 */
async function drainTimeouts(ctx: OnFailureContext): Promise<TimeoutDrainResult> {
  const { run, step } = ctx;
  const state = await retryStepCommand(ctx, {
    counter: "timeout_retries",
    label: "Rerun post-timeout",
    banner: "rerun post-timeout",
    // Any authentic verdict, including a negative one, ends draining; the fix pass
    // owns what follows.
    while: (current) => current.timedOut,
  });
  const drained = { output: state.output, lastFailReason: state.lastFailReason };

  if (state.aborted) return { outcome: { failed: false }, ...drained };
  if (state.ok) {
    updateStep(run, step, "done", state.lastFailReason);
    ctx.runOutput.emit({ type: "step.done", step, suffix: ` (after ${state.attempts} post-timeout reruns)` });
    return { outcome: { failed: false }, ...drained };
  }

  // Persistent timeout, retries, or budget exhaustion: fail without a fix pass;
  // a fix based on truncated output would not help.
  if (state.timedOut) {
    const reason = state.lastFailReason ?? "persistent timeout";
    const outcome = settleStepFailure(run, step, ctx.runOutput, reason, {
      absorbDetail: `(persistent timeout after ${state.attempts} rerun(s))`,
      failSuffix: ` — persistent timeout after ${state.attempts} rerun(s)`,
    });
    return { outcome, ...drained };
  }

  return drained;
}

/**
 * `fixOnlyWhenExtracted`: settle the failure before any repair when the extractor
 * returned nothing actionable.
 *
 * The default is the opposite (see guide/extractors.md): a failing exit code with
 * no extracted error is still repaired from the raw output, which is what a crash
 * after a written report needs. The opt-in exists for the reverse case — the suite
 * never ran, so the raw stderr describes the infrastructure and a repair paid on it
 * edits code no test ever exercised. Returns `undefined` when the fix must proceed.
 */
function withholdFixWithoutExtraction(ctx: OnFailureContext): OnFailureOutcome | undefined {
  const { run, step, extraction } = ctx;
  if (!step.def.on_failure!.fix_only_when_extracted) return undefined;
  if (!extraction || extraction.hasErrors) return undefined;
  const extractor = step.def.error_extractor;
  // The two cases lead to the same verdict but not to the same diagnosis: a report
  // that says nothing is red is not a report that was never written.
  const detail =
    extraction.reportFound === false
      ? `no report was produced — the command failed before the suite ran`
      : `the report holds no actionable error`;
  const reason = ctx.lastFailReason ?? `${extractor} extracted no error`;
  ctx.runOutput.emit({
    type: "runner.message",
    level: "warn",
    message: `  ${extractor}: ${detail} — failing without repair (fixOnlyWhenExtracted)`,
  });
  return settleStepFailure(run, step, ctx.runOutput, reason, {
    absorbDetail: `(no extracted error, no repair attempted)`,
    failSuffix: ` without repair — ${detail}`,
  });
}

/** Repair pass then command replay; `resumeSession` names the step whose session
 * hosts the repair (see runFixLoop). */
function fixHandler(opts: { resumeSession?: string }): OnFailureHandler {
  return async (ctx) => {
    const { run, step, command, baseCtx, budget, abort, deps } = ctx;
    const withheld = withholdFixWithoutExtraction(ctx);
    if (withheld) return withheld;
    const drained = await drainTimeouts(ctx);
    if (drained.outcome) return drained.outcome;
    const result = await deps.runFixLoop(run, step, command, drained.output, baseCtx, budget, drained.lastFailReason, {
      ...opts,
      output: ctx.runOutput,
      abort,
    });
    if (abort.isRunAborted(run)) return { failed: false };
    // The fix loop settles blocking vs non-blocking itself (settleStepFailure).
    return { failed: result.failed };
  };
}

/** Handler for a failure policy: rerun alone, or repair then rerun. */
export function onFailureHandlerFor(failure: StepFailure): OnFailureHandler {
  return failure.fix_prompt ? fixHandler({ resumeSession: failure.resume_session }) : rerunHandler;
}
