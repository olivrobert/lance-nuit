//
// The `on_failure` loop. One loop serves every policy: a policy without
// `fix_prompt` replays the command, one with it repairs then replays, and a
// replay that times out is drained with fresh reruns. What differs between them
// is a `Pass`; the loop owns the order of the steps around it (gate, escalation,
// counter) and each step is a function of its own.

import { type AgentBackend, type BackendSpec, backendSpecForStep } from "../../contracts/backends.js";
import type { ExtractionResult } from "../../contracts/extraction.js";
import type { StepResult } from "../runners.js";
import { requireAgentBackendRegistry } from "../../shared/language/context.js";
import type { RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import { consumeRetry, costGate, type RetryQuota, type RunBudget, refundRetry } from "../../run/index.js";
import { EscalationLatch, escalationLadderFor } from "./escalation.js";
import { performFixAttempt, type WorkState, workState, workStateChanged } from "./fix-loop-pass.js";
import { type FixRun, type FixRunInput, prepareFixRun } from "./fix-loop-runtime.js";
import { settleStepFailure } from "./non-blocking.js";
import { INTERRUPTED, type StepIssue } from "./step-issue.js";
import { runAttempt, startFreshSession } from "./step-attempt.js";

export type { OnFailureDeps } from "./fix-loop-runtime.js";

export interface OnFailureContext extends FixRunInput {
  /** Resolved step command. */
  command: string;
  /** Last attempt output, used by the first fix_prompt. */
  output: string;
  /** Last known failure reason, persisted when no better reason appears. */
  lastFailReason?: string;
  /** Whether the initial attempt timed out; seeds timeout rerun handling. */
  timedOut: boolean;
  /** Extraction of the failed attempt, already computed by the outcome phase.
   *  Absent when the step declares no extractor or when the attempt was killed, in
   *  which case no policy may conclude anything from the extraction. */
  extraction?: ExtractionResult;
}

/** Withhold the next paid piece of work when the cost gate says so, and say which
 *  stop it hit. The gate records the stop, so the report names the accounting stop
 *  rather than the step it left red. `consequence` ends the log line. */
export function withholdWhenGated(
  run: RunView,
  step: RunStepView,
  budget: RunBudget,
  output: RunOutput,
  consequence: string,
): boolean {
  const stop = costGate(run, budget, step.id);
  if (!stop) return false;
  const why = stop === "cost-unaccounted" ? "Spending unaccounted" : "Budget exceeded";
  output.emit({ type: "runner.message", level: "warn", message: `  ${why}, ${consequence}` });
  return true;
}

interface LoopEnv {
  ctx: OnFailureContext;
  maxRetries: number;
  /** Step backend; absent for bash/noop steps that do not use an agent. */
  backend?: AgentBackend;
  backendSpec?: BackendSpec;
}

/** What the loop knows about the failure it is working on. */
interface LoopState {
  output: string;
  failReason?: string;
  /** Extraction of `output`; absent until computed, and again once `output` changed. */
  extraction?: ExtractionResult;
  /** The last command attempt was killed by the wall clock: its output is truncated. */
  timedOut: boolean;
  /** The escalating pass saw a timeout on its last attempt: effort cannot fix one. */
  escalateOnTimeout: boolean;
  /** A gate withheld the next piece of work, or the guard cut the last one short.
   *  The step then stays resumable, never absorbed. */
  costStopped: boolean;
}

/** How a pass or the loop ended. A `StepIssue` ends the policy as it is. */
type Ending = "ok" | "spent" | StepIssue;
type PassEnd = Ending | "again";

/** The part of the loop that differs between policies. */
interface Pass {
  /** Consumed quota, separate per pass so the timeout drain cannot consume the
   *  repair quota. */
  counter: RetryQuota;
  /** Escalation latch; absent means an identical attempt each time. */
  latch?: EscalationLatch;
  /** Entry condition beyond the quota. */
  proceeds(state: LoopState): boolean;
  /** Said once, past the gate, before the first attempt it describes. */
  announce?(): void;
  escalationNotice(state: LoopState, attempt: number): string;
  attempt(state: LoopState, attempt: number): Promise<PassEnd>;
}

function consumed(step: RunStepView, counter: RetryQuota): number {
  return step[counter] ?? 0;
}

/** The latch reads the attempts already made, so it moves before the counter does:
 *  the one place that order is written. */
function claimAttempt(env: LoopEnv, state: LoopState, pass: Pass): number {
  const { run, step, runOutput } = env.ctx;
  const escalated =
    pass.latch?.advance({ timedOut: state.escalateOnTimeout, retries: consumed(step, pass.counter) }) ?? false;
  const attempt = consumeRetry(run, step, pass.counter);
  if (escalated) {
    runOutput.emit({ type: "runner.message", level: "info", message: pass.escalationNotice(state, attempt) });
  }
  return attempt;
}

/** Run the step command in a fresh session. */
async function replayCommand(
  env: LoopEnv,
  attempt: { line: string; banner: string; agentOptions?: unknown },
): Promise<StepResult> {
  const { run, step, command, baseCtx, budget, deps, runOutput } = env.ctx;
  runOutput.emit({ type: "runner.message", level: "info", message: attempt.line });
  const session = startFreshSession(run, step, env.backend);
  return runAttempt(run, step, {
    command,
    context: baseCtx,
    budget,
    executeStep: deps.executeStep,
    banner: attempt.banner,
    spawn: { session, ...(attempt.agentOptions !== undefined ? { agentOptions: attempt.agentOptions } : {}) },
  });
}

/** What a command attempt settles, for a rerun, a drain or a replay alike: the
 *  state the next attempt starts from, and whether the loop goes on. */
function settleCommand(env: LoopEnv, state: LoopState, pass: Pass, result: StepResult): PassEnd {
  const { run, step, abort } = env.ctx;
  if (abort.isRunAborted(run)) return INTERRUPTED;
  state.timedOut = result.timedOut ?? false;
  if (pass.latch) state.escalateOnTimeout = state.timedOut;
  state.output = result.output;
  state.extraction = undefined;
  if (result.failReason) state.failReason = result.failReason;
  if (result.ok) return "ok";
  // The attempt was cut short, not refuted: its verdict is unknown.
  if (refundRetry(run, step, pass.counter, result)) {
    state.costStopped = true;
    return "spent";
  }
  // An obstacle outside the code: no further attempt, rerun or repair, can lift it.
  if (result.failCause === "blocked") return { kind: "blocked", failReason: result.failReason };
  return "again";
}

/** Attempt the pass until its quota is spent, it succeeds, or something ends it. */
async function runPasses(env: LoopEnv, state: LoopState, pass: Pass): Promise<Ending> {
  const { run, step, budget, abort, runOutput } = env.ctx;
  while (!abort.isRunAborted(run) && pass.proceeds(state) && consumed(step, pass.counter) < env.maxRetries) {
    // A cost stop is not a technical failure to repair: no attempt is paid for trying.
    if (withholdWhenGated(run, step, budget, runOutput, "stopping retries")) {
      state.costStopped = true;
      return "spent";
    }
    pass.announce?.();
    const attempt = claimAttempt(env, state, pass);
    const end = await pass.attempt(state, attempt);
    if (end !== "again") return end;
  }
  return "spent";
}

/** Replay the command as it is, escalating the step's own backend. */
function rerunPass(env: LoopEnv): Pass {
  const { step } = env.ctx;
  const failure = step.def.on_failure!;
  const latch = new EscalationLatch(escalationLadderFor(failure), failure.escalate_after);
  const pass: Pass = {
    counter: "retries",
    latch,
    proceeds: () => true,
    escalationNotice: (state) =>
      `  ↑ Escalate ${step.def.name} → ${latch.label()} (reason: ${state.escalateOnTimeout ? "timeout" : "threshold"})`,
    attempt: async (state, attempt) => {
      // A step without a backend (bash, noop) has no escalation axes; only its
      // counter changes.
      const agentOptions = env.backend?.applyEscalation?.(env.backendSpec?.options ?? {}, latch.axes());
      const rung = latch.rung === "none" ? "" : ` [${latch.label()}]`;
      const result = await replayCommand(env, {
        line: `  → Rerun (${attempt}/${env.maxRetries})${rung}...`,
        banner: `rerun ${attempt}/${env.maxRetries}`,
        agentOptions,
      });
      return settleCommand(env, state, pass, result);
    },
  };
  return pass;
}

/** Replay in a fresh session until the verdict is authentic: a timeout truncates
 *  output, so it is no verdict a fix could act on. Its own quota
 *  (`timeout_retries`): sharing `retries` could exhaust the repair budget before a
 *  repair ran. */
function drainPass(env: LoopEnv): Pass {
  const pass: Pass = {
    counter: "timeout_retries",
    // Any authentic verdict, including a negative one, ends draining; the repair
    // pass owns what follows.
    proceeds: (state) => state.timedOut,
    escalationNotice: () => "",
    attempt: async (state, attempt) => {
      const result = await replayCommand(env, {
        line: `  → Rerun post-timeout (${attempt}/${env.maxRetries})...`,
        banner: `rerun post-timeout ${attempt}/${env.maxRetries}`,
      });
      return settleCommand(env, state, pass, result);
    },
  };
  return pass;
}

/** Without a drain, a timed-out reviewer sent a blind fix into the coder session
 *  and inflated it by rereading screenshots. Returns the issue when draining
 *  concludes the step (success, persistent timeout, obstacle), `undefined` when
 *  an authentic verdict is ready for the repair. */
async function drainTimeouts(env: LoopEnv, state: LoopState): Promise<StepIssue | undefined> {
  const { run, step, abort, runOutput } = env.ctx;
  if (!state.timedOut) return undefined;
  const end = await runPasses(env, state, drainPass(env));
  if (abort.isRunAborted(run)) return INTERRUPTED;
  const attempts = consumed(step, "timeout_retries");
  if (end === "ok") return { kind: "done", suffix: ` (after ${attempts} post-timeout reruns)` };
  if (end !== "spent") return end;
  // Persistent timeout, quota, or budget exhaustion: fail without a repair; a fix
  // based on truncated output would not help.
  if (!state.timedOut) return undefined;
  return settleStepFailure(
    run,
    step,
    runOutput,
    state.failReason ?? "persistent timeout",
    {
      absorbDetail: `(persistent timeout after ${attempts} rerun(s))`,
      failSuffix: ` — persistent timeout after ${attempts} rerun(s)`,
    },
    state.costStopped,
  );
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
function withholdFixWithoutExtraction(ctx: OnFailureContext): StepIssue | undefined {
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

/** `step.retries` is persisted across run segments on purpose, so a resumed step
 *  readmitted by `rerun_on_resume` can reach the loop with its quota already
 *  spent. Say so explicitly: the loop body never runs, and silence would read as
 *  a repair that happened. */
function warnQuotaSpent(env: LoopEnv): void {
  const { run, step, abort, runOutput } = env.ctx;
  if (abort.isRunAborted(run) || consumed(step, "retries") < env.maxRetries) return;
  runOutput.emit({
    type: "runner.message",
    level: "warn",
    message: `  Fix quota already consumed (${step.retries}/${env.maxRetries} retries), no repair launched`,
  });
}

/** Errors of the output the next repair describes: the extraction the outcome phase
 *  made while it still stands, otherwise a fresh one. */
async function extractionOf(env: LoopEnv, state: LoopState): Promise<ExtractionResult> {
  state.extraction ??= await env.ctx.deps.extractErrors(env.ctx.step, state.output);
  return state.extraction;
}

/** A replay after a repair that touched nothing would pay for the same verdict. */
async function repairChangedNothing(ctx: OnFailureContext, before: WorkState | undefined): Promise<boolean> {
  if (!before) return false;
  const after = await workState(ctx.baseCtx.cwd);
  return !!after && !workStateChanged(before, after, ctx.run.run_dir);
}

/** Repair, then replay the command: one pass, the replay being part of it. */
function fixPass(env: LoopEnv, fx: FixRun): Pass {
  const { run, step, budget, abort, runOutput, baseCtx } = env.ctx;
  const failure = step.def.on_failure!;
  const latch = new EscalationLatch(escalationLadderFor(failure), failure.escalate_after);
  let announced = false;
  const pass: Pass = {
    counter: "retries",
    latch,
    proceeds: () => true,
    // The backend choice is announced past the gate and not at preparation time: a
    // repair is about to run, so the line describes a real action.
    announce: () => {
      if (announced) return;
      announced = true;
      runOutput.emit({
        type: "runner.message",
        level: "info",
        message: `  → Fix backend ${fx.fixSpec.id} — ${fx.fixReason}`,
      });
    },
    escalationNotice: (_state, attempt) => `  ↑ Escalate fix → ${latch.label()} (retry ${attempt}/${env.maxRetries})`,
    attempt: async (state, attempt) => {
      const label = `${attempt}/${env.maxRetries}`;
      const before = failure.stop_if_unchanged ? await workState(baseCtx.cwd) : undefined;
      if (abort.isRunAborted(run)) return INTERRUPTED;
      const extraction = await extractionOf(env, state);
      if (abort.isRunAborted(run)) return INTERRUPTED;
      const repaired = await performFixAttempt(fx, {
        output: state.output,
        errors: extraction.errors,
        lastFailReason: state.failReason,
        label,
        banner: `fix ${label}`,
        agentOptions: fx.fixBackend.applyEscalation?.(fx.backendOptions, latch.axes()) ?? fx.backendOptions,
      });
      if (!repaired || abort.isRunAborted(run)) return INTERRUPTED;
      if (refundRetry(run, step, "retries", repaired.fix)) {
        state.costStopped = true;
        runOutput.emit({ type: "runner.message", level: "warn", message: `  Fix stopped by the cost guard` });
        return "spent";
      }
      if (!repaired.fix.ok) {
        runOutput.emit({ type: "runner.message", level: "error", message: `  Fix failed, retry cancelled` });
        return "spent";
      }
      // The original failure is kept as the step's reason: nothing re-checked the
      // code, so reports must not read the repair as a verified success.
      if (failure.replay_after_fix === false) {
        runOutput.emit({ type: "runner.message", level: "info", message: `  Fix applied, command not replayed` });
        state.failReason = `${state.failReason ?? "failure"} (fix applied, not replayed)`;
        return "spent";
      }
      const unchanged = await repairChangedNothing(env.ctx, before);
      if (abort.isRunAborted(run)) return INTERRUPTED;
      if (unchanged) {
        runOutput.emit({ type: "runner.message", level: "info", message: `  Fix changed nothing, replay skipped` });
        return { kind: "blocked", failReason: `${state.failReason ?? "failure"} (fix changed nothing)` };
      }
      if (withholdWhenGated(run, step, budget, runOutput, "stopping retries")) {
        state.costStopped = true;
        return "spent";
      }
      const replay = await replayCommand(env, {
        line: `  → Retry ${step.def.name}...`,
        banner: `retry ${label}`,
      });
      const end = settleCommand(env, state, pass, replay);
      // The replay's truncated output is no verdict to repair from: drain it before
      // the next fix, as the first attempt's is.
      if (end !== "again" || !state.timedOut) return end;
      return (await drainTimeouts(env, state)) ?? "again";
    },
  };
  return pass;
}

/** How a policy words its outcome. */
interface Wording {
  done: (attempts: number) => string;
  absorbed: (attempts: number) => string;
  failed: (attempts: number) => string;
}

const RERUNS: Wording = {
  done: (attempts) => ` (after ${attempts} reruns)`,
  absorbed: (attempts) => `after ${attempts} rerun(s)`,
  failed: (attempts) => ` after ${attempts} reruns`,
};

function repairs(resumed: boolean): Wording {
  return {
    done: (attempts) => ` (after ${attempts} ${resumed ? "resumed fixes" : "fixes"})`,
    absorbed: (attempts) => `after ${attempts} attempt(s)`,
    failed: (attempts) => ` after ${attempts} attempts`,
  };
}

/** The issue of the policy once its loop ended. */
function settleLoop(ctx: OnFailureContext, state: LoopState, end: Ending, wording: Wording): StepIssue {
  const { run, step, abort, runOutput } = ctx;
  if (abort.isRunAborted(run)) return INTERRUPTED;
  if (end !== "ok" && end !== "spent") return end;
  const attempts = consumed(step, "retries");
  if (end === "ok") return { kind: "done", suffix: wording.done(attempts) };
  return settleStepFailure(
    run,
    step,
    runOutput,
    state.failReason,
    { absorbDetail: wording.absorbed(attempts), failSuffix: wording.failed(attempts) },
    state.costStopped,
  );
}

function loopEnv(ctx: OnFailureContext): LoopEnv {
  const { step, baseCtx, deps } = ctx;
  const backendSpec = backendSpecForStep(step.def);
  const registry = () => deps.registry ?? requireAgentBackendRegistry(baseCtx);
  return {
    ctx,
    maxRetries: step.def.on_failure!.max_retries,
    ...(backendSpec ? { backendSpec, backend: registry().resolve(backendSpec) } : {}),
  };
}

/**
 * Settle a failed step according to its `on_failure` policy. A policy answers
 * `done` with how it got there (the pass writes `done`, never the policy),
 * `absorbed`, `failed`, `blocked` (the outcome phase settles it) or `interrupted`.
 */
export async function runOnFailure(ctx: OnFailureContext): Promise<StepIssue> {
  const env = loopEnv(ctx);
  const fixes = !!ctx.step.def.on_failure!.fix_prompt;
  const state: LoopState = {
    output: ctx.output,
    failReason: ctx.lastFailReason,
    extraction: ctx.extraction,
    timedOut: ctx.timedOut,
    // A repair does not escalate on the timeout of the attempt it repairs: the
    // drain answers it.
    escalateOnTimeout: !fixes && ctx.timedOut,
    costStopped: false,
  };
  if (!fixes) return settleLoop(ctx, state, await runPasses(env, state, rerunPass(env)), RERUNS);

  const withheld = withholdFixWithoutExtraction(ctx);
  if (withheld) return withheld;
  const drained = await drainTimeouts(env, state);
  if (drained) return drained;
  warnQuotaSpent(env);
  const fx = prepareFixRun(ctx);
  const end = await runPasses(env, state, fixPass(env, fx));
  return settleLoop(ctx, state, end, repairs(fx.resumeSession !== undefined));
}
