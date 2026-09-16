// runner/step/step-attempt.ts
//
// The only loop spawn entry points are `runAttempt` (step command) and
// `runFixAttempt` (repair pass). Both use the same middleware chain, so rerun and
// fix loops share bookkeeping without duplication.
//
// Middleware lives here rather than in attempt-chain.ts because each middleware is
// tied to its bookkeeping; the chain itself remains runner-agnostic.
//
// The attempt itself is closed once, by `closeAttempt` (state/attempt-closure.ts):
// status, stats, merge into the step total and the `step.attempt.finished` event.
// `finishAttempt` below is the one caller of that closure for a tracked attempt,
// on the returned-record path and on the rejection path alike, and it charges the
// in-loop ledger from the figures the closure accepted. Middleware observes the
// attempt (banner, session, remaining budget before spawn); none of it is needed
// for the accounting to be right.

import { appendFileSync } from "node:fs";
import type {
  AgentBackend,
  AgentBackendRegistry,
  AgentSession,
  ArtifactScope,
  BackendSpec,
  StepControl,
  StepUsage,
} from "../contracts/backends.js";
import type { executeStep, runWithAgent, StepResult } from "../exec/runners.js";
import { errorMessage } from "../lib/errors.js";
import type { PipelineContext } from "../model/context.js";
import type { PipelineStep } from "../model/definition.js";
import type { PersistedAttempt } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import { clearLiveAttemptCost } from "../runtime/live-cost.js";
import { log } from "../runtime/logging.js";
import { type RunBudget, remainingBudget } from "../state/budget.js";
import { chargeAttemptToLedger, isUnpricedSpend, type SettledSpend } from "../state/cost-accounting.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import {
  fingerprintInputs,
  mergeProvenance,
  pureInputsOf,
  removeProvenance,
  revisedInPlace,
  writeProvenance,
} from "../state/provenance.js";
import { appendRunEvent, relativeRunPath } from "../state/run-journal.js";
import { closeAttempt } from "../state/attempt-closure.js";
import { logicalAttemptLogPath, nextAttemptLogPath } from "../state/run-timeline.js";
import { saveRun } from "../state/run-repository.js";
import { recordStepVerdict } from "../state/run-transitions.js";
import {
  type AttemptContext,
  type AttemptHandler,
  type AttemptMiddleware,
  type AttemptRecord,
  compose,
} from "./attempt-chain.js";

/** Warn ONCE per attempt when spend was left at an unknown price. Silence here
 * would read as a free attempt: the ledger stops advancing, so `max_cost_usd` can
 * never be reached and the run spends without a ceiling.
 *
 * Guarded on `cost_unknown`: the warning belongs to the uncertainty itself, not
 * to the strict stop, so it also fires for an attempt that died before reporting
 * any figure — whose total is a lower bound even though the run keeps going. A
 * control with a usable price is silent. */
function warnUnaccountedCost(run: Run, step: RunStep, control: StepControl, usage: StepUsage | undefined): void {
  if (control.cost_unknown !== true) return;
  const model = control.model ?? "unknown model";
  // Name the uncertainty the figures actually show. "no pricing entry" over an
  // attempt that reported no usage at all (a 400 before the first token, a
  // transport break) sent an operator to fix a rate table that was complete.
  const cause = isUnpricedSpend(control, usage) ? "no pricing entry" : "no usage reported by the attempt";
  // `log.warn` and not `runner.message`: this warning is raised from the attempt
  // lifecycle (`runTrackedAttempt`), which carries no `RunOutput`. Threading the
  // port through every attempt entry point is the way to move it onto the bus;
  // until then it takes the direct stderr path, like the sites in boot/ and
  // dispatch/.
  log.warn(
    `  Cost not computable (${model}: ${cause}) — spend is not counted toward the budget` +
      (run.max_cost_usd != null ? `; the $${run.max_cost_usd} ceiling is no longer guaranteed` : ""),
  );
  appendRunEvent(run, "step.cost.unaccounted", { stepId: step.id, model: control.model ?? null });
}

/**
 * Session bookkeeping for an attempt that executes the step (initial, rerun, or
 * retry after a fix): a backend that minted or rotated the session reports it,
 * and the step remembers that one.
 *
 * Never apply it to a repair pass: the fix session is not the step session and
 * must not overwrite `step.session`. The fix loop's `resumeSession` mode
 * writes its forked session back to the resumed step itself.
 */
export function applyStepSession(step: RunStep, result: AttemptRecord): void {
  if (result.session) step.session = result.session;
}

/**
 * Open a fresh session for an attempt that must not continue the previous one
 * (initial attempt, rerun, retry after a fix). Backends that mint their session
 * lazily return nothing, and the step keeps whatever the attempt reports later.
 * The snapshot is the caller's: it is written together with the attempt counter.
 */
export function startFreshSession(step: RunStep, backend: AgentBackend | undefined): AgentSession | undefined {
  const session = backend?.createSession?.();
  if (session) step.session = session;
  return session;
}

/** Attempt separator in the step log (`--- rerun 2/3 ---`). This is the only place
 * that formats attempt banners, leaving a natural hook for future events. No
 * banner is written for the initial attempt. */
export const bannerMiddleware: AttemptMiddleware = async (ctx, next) => {
  if (ctx.banner && ctx.stepLogPath) {
    appendFileSync(ctx.stepLogPath, `\n--- ${ctx.banner} ---\n`);
  }
  return next(ctx);
};

/** Rotate sessions for step attempts. Kept separate from
 * cost because session bookkeeping is load-bearing for resume.
 *
 * An attempt already closed by the signal handler keeps the step session as it
 * was: the abort promises a fresh attempt on resume, so a backend draining after
 * the kill must not rotate `step.session` under it. */
export const sessionMiddleware: AttemptMiddleware = async (ctx, next) => {
  const record = await next(ctx);
  if (ctx.kind === "step" && ctx.attempt.status === "running") applyStepSession(ctx.step, record);
  return record;
};

/**
 * The accepted closure reaches the in-loop budget ledger.
 *
 * Called by `finishAttempt` with the figures `closeAttempt` actually stored, so
 * the ledger, the attempt and the step total never disagree on what one attempt
 * cost: there is one normalization, and it happened at closure. The charge itself
 * is arithmetic and owned by cost accounting; the journaling below belongs to the
 * stop decisions, not to the charge.
 */
function chargeLedger(run: Run, step: RunStep, budget: RunBudget, settled: SettledSpend, result: AttemptRecord): void {
  const { control, usage } = settled;
  // The ledger, the materialized run totals it invalidates, and the accounting
  // latch derived from the figures are one charge, owned by cost accounting.
  // Two roads to that latch: the attempt closed on figures that PROVE unpriceable
  // consumption, or a live guard proved the usage unpriceable and killed the
  // process before it could report figures a mapper could normalize — which is
  // why the second proof is read from the record rather than from the figures.
  chargeAttemptToLedger(run, budget, control, usage, {
    guardProvedUnpriced: result.costUnaccounted === true,
  });
  // A guard kill is a budget verdict, not a technical break, and a live
  // accounting kill is a STOP, not just the latch above: the guard withheld the
  // rest of this attempt the way a gate withholds the next one. Both are recorded
  // by the stop owner (ledger latches, `run.budget_exceeded`, journal), so the
  // retry loops stop and the report headlines the cost stop instead of the
  // process the guard had to kill to reach it.
  const origin = { kind: "live-guard", stepId: step.id } as const;
  if (result.budgetExceeded) recordCostStop(run, budget, "exceeded", origin);
  if (result.costUnaccounted === true) recordCostStop(run, budget, "unaccounted", origin);
  // The uncertainty is worth saying out loud in both cases: the report will print
  // the total as a lower bound either way.
  warnUnaccountedCost(run, step, result.costUnaccounted === true ? { ...control, cost_unknown: true } : control, usage);
}

/** Pass the remaining cost budget to spawn. As the innermost middleware, it reads
 * the changing cumulative value at the last moment. Removing it disables
 * max_cost_usd enforcement. */
export const budgetGateMiddleware: AttemptMiddleware = async (ctx, next) => {
  ctx.budget.remaining = remainingBudget(ctx.run.max_cost_usd, ctx.budget.cumulative);
  return next(ctx);
};

/**
 * Whether a live guard must stop this attempt on provably unpriceable usage.
 *
 * Both conditions of the strict policy, read at spawn time: a ceiling exists,
 * and no human authorized spend nobody can price. Without the ceiling there is
 * nothing to enforce; with the authorization the run has already accepted the
 * uncertainty and the attempt runs to completion.
 */
export function strictCostAccountingFor(run: Run, budget: RunBudget): boolean {
  return run.max_cost_usd != null && budget.allowUnmetered !== true;
}

/** Order from outermost to innermost. Removing an entry disables that middleware;
 * budgetGateMiddleware must remain last. The ledger charge is not a middleware:
 * it belongs to the attempt lifecycle (`finishAttempt`) and cannot be removed. */
export const DEFAULT_ATTEMPT_MIDDLEWARES: readonly AttemptMiddleware[] = [
  bannerMiddleware,
  sessionMiddleware,
  budgetGateMiddleware,
];

/** Spawn options shared by both entry points. `budgetRemaining` is intentionally
 * absent because the chain calculates it at spawn time. */
interface SpawnOptions {
  cwd?: string;
  runnerDir?: string;
  timeout?: number;
  role?: string;
  session?: AgentSession;
  resumeSession?: AgentSession;
  agentOptions?: unknown;
  artifactScope?: ArtifactScope;
  registry?: AgentBackendRegistry;
}

interface AttemptOptionsBase {
  /** Run budget mutated by the chain. */
  budget: RunBudget;
  /** Step-log separator label; absent means no banner. */
  banner?: string;
  /** Chain applied to this attempt; overridden only by tests. */
  middlewares?: readonly AttemptMiddleware[];
}

export interface RunTrackedAttemptOptions<R extends AttemptRecord> extends AttemptOptionsBase {
  run: Run;
  step: RunStep;
  kind: "step" | "fix";
  /** Resolved step command or repair prompt. */
  command: string;
  /** Common spawn options; the invocation may extend them. */
  spawn?: SpawnOptions;
  /** Facades provide only behavior specific to the attempt kind. */
  invoke: AttemptHandler<R>;
}

/**
 * The one exit of an attempt started by `runTrackedAttempt`, whether the chain
 * returned a record or rejected: closure, then — for an accepted closure only —
 * the step verdict fields and the ledger charge, then the snapshot.
 *
 * An attempt the signal handler already closed and charged from live telemetry
 * returns no figures here, so a backend resolving while its process drains cannot
 * charge the same work twice, cannot rewrite `fail_kind`/`fail_cause` from a
 * result the resumed step will not give — and the run keeps the step session as
 * it was, since the abort promises a fresh attempt on resume.
 */
function finishAttempt(
  run: Run,
  step: RunStep,
  kind: "step" | "fix",
  attempt: PersistedAttempt,
  path: string,
  budget: RunBudget,
  result: AttemptRecord,
): void {
  const logPath = run.logStore
    ? logicalAttemptLogPath(step.id, attempt.attempt)
    : (relativeRunPath(run.run_dir, path) ?? attempt.log_path);
  const settled = closeAttempt(run, step, attempt, {
    status: result.ok ? "done" : "failed",
    stats: result.stats,
    session: result.session,
    reason: result.failReason,
    logPath,
  });
  // A refused closure means another closer already settled this attempt — the
  // signal handler, or a crash reconciliation — and its late result no longer
  // describes the step: neither the verdict nor the ledger read it. Nothing of
  // the run changed here, so the snapshot the earlier closer wrote stands as is.
  if (!settled) return;
  // A fix pass repairs rather than judging; only kind === "step" carries the
  // command verdict to return.
  if (kind === "step") {
    recordStepVerdict(run, step, { ok: result.ok, failKind: result.failKind, failCause: result.failCause });
  }
  chargeLedger(run, step, budget, settled, result);
  saveRun(run);
}

/**
 * Execute one attempt end to end.
 *
 * Every attempt follows the same lifecycle: allocation before spawn, start event
 * and snapshot, middleware chain, finalization, and end snapshot. The facades only
 * provide their invocation; the generic type preserves the exact result, including
 * step output, without exposing it to bookkeeping.
 *
 * Spawn errors remain visible to callers, but close the attempt as failed before
 * rethrowing so a snapshot never leaves an interrupted attempt as `running`.
 */
export async function runTrackedAttempt<R extends AttemptRecord>(options: RunTrackedAttemptOptions<R>): Promise<R> {
  const { run, step, kind, command, spawn } = options;
  // The complete attempt lifecycle owns the live-cost slot. A transport can exit
  // before output validation and durable bookkeeping have completed.
  clearLiveAttemptCost();
  const stepLogPath = nextAttemptLogPath(run, step, kind);
  // `nextAttemptLogPath` has just pushed the running attempt; it is the object
  // every closer identifies the attempt by.
  const attempt = step.attempts!.at(-1)!;
  appendRunEvent(run, "step.attempt.started", {
    stepId: step.id,
    attempt: attempt.attempt,
    kind,
    sessionId:
      kind === "step" ? (spawn?.session?.id ?? spawn?.resumeSession?.id ?? null) : (spawn?.resumeSession?.id ?? null),
    logPath: attempt.log_path ?? relativeRunPath(run.run_dir, stepLogPath),
  });
  // Snapshot the attempt before spawn: a kill may happen before the runner can
  // persist its result.
  saveRun(run);

  const context: AttemptContext = {
    run,
    step,
    attempt,
    kind,
    command,
    banner: options.banner,
    stepLogPath,
    budget: options.budget,
  };

  let result: R;
  try {
    result = await runChain(options, options.invoke, context);
  } catch (error) {
    const failReason = errorMessage(error);
    try {
      // The same exit as a returned record: an attempt that rejected still closed,
      // still reached the ledger, and still invalidated the materialized totals.
      finishAttempt(run, step, kind, attempt, stepLogPath, options.budget, { ok: false, failReason });
    } catch {
      // Never mask the spawn error with a finalization persistence error; the
      // public API must continue to rethrow it.
    }
    clearLiveAttemptCost();
    throw error;
  }

  finishAttempt(run, step, kind, attempt, stepLogPath, options.budget, result);
  clearLiveAttemptCost();
  return result;
}

export interface RunAttemptOptions extends AttemptOptionsBase {
  command: string;
  context: PipelineContext;
  executeStep: typeof executeStep;
  spawn?: SpawnOptions;
}

/** Execute one step-command attempt through the chain. */
export async function runAttempt(run: Run, step: RunStep, options: RunAttemptOptions): Promise<StepResult> {
  return runTrackedAttempt({
    run,
    step,
    kind: "step",
    command: options.command,
    banner: options.banner,
    budget: options.budget,
    middlewares: options.middlewares,
    spawn: options.spawn,
    invoke: async (ctx) => {
      const declaresInput = (ctx.step.def.sources?.length ?? 0) > 0;
      const revised = declaresInput ? revisedInPlace(ctx.step.def) : new Set<string>();
      // Read the inputs BEFORE the attempt: the fingerprints must describe what
      // the step was given, not what a later step may have rewritten.
      const fingerprints = declaresInput
        ? await fingerprintInputs(options.context, pureInputsOf(ctx.step.def))
        : undefined;

      // A declared output proves this attempt completed; its previous version was
      // removed before spawn, like report_paths. An output the step also declares
      // as input is revised in place, so it survives the erasure.
      for (const output of ctx.step.def.outputs ?? []) {
        if (revised.has(output.name)) continue;
        await output.remove(options.context);
        if (declaresInput) await removeProvenance(options.context, output);
      }

      const result = await options.executeStep(
        ctx.step,
        ctx.command,
        {
          ...options.spawn,
          stepLogPath: ctx.stepLogPath,
          budgetRemaining: ctx.budget.remaining,
          strictCostAccounting: strictCostAccountingFor(ctx.run, ctx.budget),
        },
        options.context,
      );

      // Transport, timeout, and negative verdicts retain diagnostic priority.
      if (!result.ok) return result;
      // A refused capture is a failure of its own kind: the command succeeded and
      // the agent answered, but the object it returned does not satisfy the
      // artifact's contract. The outcome phase may ask the same session for a
      // corrected object, so the refusal is told apart from a missing `require`
      // (nothing to re-ask for) and from a write error (nothing the agent can fix).
      let captured: CapturedValue[];
      try {
        captured = readCaptures(ctx.step.def, result.structuredOutput);
      } catch (error) {
        const failReason = errorMessage(error);
        // The step log only carries the assistant's prose; the structured output
        // travels through a tool call the log never sees. Without this entry, a
        // refusal leaves no trace of what was refused.
        if (ctx.stepLogPath) appendFileSync(ctx.stepLogPath, refusedCaptureEntry(failReason, result.structuredOutput));
        return { ...result, ok: false, failReason, captureRefused: true };
      }
      try {
        // Captured fields are written BEFORE the outputs are verified: a captured
        // artifact is an output, and `require` below is what proves it landed.
        for (const { capture, value } of captured) await capture.artifact.write(options.context, value);
        for (const output of ctx.step.def.outputs ?? []) await output.require(options.context);
      } catch (error) {
        const failReason = errorMessage(error);
        return { ...result, ok: false, failReason };
      }
      // Only here is "command succeeded and outputs verified" true, so only here
      // may a fingerprint be recorded.
      if (fingerprints) {
        for (const output of ctx.step.def.outputs ?? []) {
          const record = revised.has(output.name) ? mergeProvenance : writeProvenance;
          await record(options.context, output, ctx.step.id, fingerprints);
        }
      }
      return result;
    },
  });
}

/** One `capture` of a step and the value the agent returned for it, accepted by
 * the artifact's parser and ready to be written. */
interface CapturedValue {
  capture: NonNullable<PipelineStep["captures"]>[number];
  value: unknown;
}

/**
 * Read every `capture` of a step from the agent's structured output. The agent
 * RETURNS the value; the runner persists it — the only deterministic way to get a
 * short artifact out of an agent, since each backend writes files its own way
 * (and a toolless role cannot write at all). A missing or `null` field is a
 * failure of the attempt, never a silent absence: the verdict said success, the
 * contract says the field is required.
 *
 * Every capture is validated BEFORE any is written: a fix pass erases nothing, so
 * an artifact written by a failed attempt would otherwise reach the repair agent
 * as if it were good. Validation goes through the descriptor's own parser, on the
 * bytes `write` will produce, so a value the artifact refuses fails here with
 * nothing on disk. Throws on the first refusal; the caller writes what it returns.
 */
function readCaptures(def: PipelineStep, structuredOutput: unknown): CapturedValue[] {
  const captures = def.captures ?? [];
  if (captures.length === 0) return [];
  const source =
    structuredOutput !== null && typeof structuredOutput === "object" && !Array.isArray(structuredOutput)
      ? (structuredOutput as Record<string, unknown>)
      : undefined;
  const values: CapturedValue[] = [];
  for (const capture of captures) {
    const value = source?.[capture.field];
    if (value === undefined || value === null) {
      throw new Error(`capture "${capture.field}": absent from the agent's structured output`);
    }
    if (capture.text) {
      if (typeof value !== "string") {
        throw new Error(
          `capture "${capture.field}": text artifact "${capture.artifact.name}" expects a string, received ${describeValue(value)}`,
        );
      }
      capture.artifact.validate(value);
    } else {
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError(`capture "${capture.field}": value cannot be serialized as JSON`);
      capture.artifact.validate(json);
    }
    values.push({ capture, value });
  }
  return values;
}

/** Step-log entry for a refused structured output: the reason, then the object
 * as the backend parsed it, so the refusal can be read after the fact. Formatted
 * like an attempt banner, which is the only other separator the log carries. */
function refusedCaptureEntry(failReason: string, structuredOutput: unknown): string {
  const payload =
    structuredOutput === undefined
      ? "(no structured output)"
      : (JSON.stringify(structuredOutput, null, 2) ?? String(structuredOutput));
  return `\n--- capture refused: ${failReason} ---\n${payload}\n`;
}

function describeValue(value: unknown): string {
  return Array.isArray(value) ? "an array" : value === null ? "null" : `a ${typeof value}`;
}

export type FixResult = Awaited<ReturnType<typeof runWithAgent>>;

export interface RunFixAttemptOptions extends AttemptOptionsBase {
  /** Resolved repair prompt. */
  prompt: string;
  fixWithAgent: typeof runWithAgent;
  /** Repair backend, always resolved by the caller. A step without its own backend
   * (bash) uses the registry default. */
  backendSpec: BackendSpec;
  agentOptions?: unknown;
  spawn?: SpawnOptions;
  /** Registry the fix spawn runs on; it travels with the run, never resolved here. */
  registry: AgentBackendRegistry;
}

/** Execute one repair pass through the same chain as `runAttempt`. Without this
 * entry point, fix spawns would be invisible to middleware despite representing a
 * major share of run cost. */
export async function runFixAttempt(run: Run, step: RunStep, options: RunFixAttemptOptions): Promise<FixResult> {
  return runTrackedAttempt({
    run,
    step,
    kind: "fix",
    command: options.prompt,
    banner: options.banner,
    budget: options.budget,
    middlewares: options.middlewares,
    spawn: options.spawn,
    invoke: (ctx) =>
      options.fixWithAgent(ctx.command, options.backendSpec, options.agentOptions, {
        ...options.spawn,
        stepLogPath: ctx.stepLogPath,
        budgetRemaining: ctx.budget.remaining,
        strictCostAccounting: strictCostAccountingFor(ctx.run, ctx.budget),
        registry: options.registry,
      }),
  });
}

function runChain<R extends AttemptRecord>(
  options: AttemptOptionsBase,
  handler: AttemptHandler<R>,
  ctx: AttemptContext,
): Promise<R> {
  return compose(...(options.middlewares ?? DEFAULT_ATTEMPT_MIDDLEWARES))(handler)(ctx);
}
