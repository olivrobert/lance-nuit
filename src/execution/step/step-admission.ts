//
// Step admission before any spawn: budget, `when`, the freshness lock, the
// interruption guard and preflight. This module does not know sessions or
// on_failure strategies; it decides whether execution may run.

import type { IgnoredBy, InputAction, InputDecision, StepInputCondition } from "../../definition/index.js";
import { runBashAsync, stripStderrMarker } from "../../shared/process/bash-runner.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { truncate } from "../../shared/lib/truncate.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { resolveTemplateAsync } from "../../shared/language/context.js";
import { isStamped } from "../../definition/index.js";
import type { RunStopState, RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import {
  costGate,
  lastPassInterrupted,
  owesWork,
  type RunBudget,
  forkPending,
  recordSkip,
  recordUnavailableSource,
  stopRun,
  updateStep,
  stepLogDir,
} from "../../run/index.js";
import {
  type Fingerprint,
  type Freshness,
  pendingRejection,
  readInputs,
  sourceKey,
  stampKey,
  stepFreshness,
  type UnavailableSource,
} from "../../work-items/index.js";
import { failStep, refuseStep } from "./non-blocking.js";

/** Reason logged when a step's stamp still matches its inputs and outputs. */
const SKIP_UP_TO_DATE = "up to date";

/** Reason logged when this invocation's `--steps`, `--skip` or
 *  `--start-at` leaves the step out. */
const SKIP_OPERATOR_SELECTION = "operator selection";

export type StepAdmission =
  | { kind: "budget-exceeded" }
  /** Spending became unaccountable under a cost ceiling: an attempt spent tokens
   *  no pricing table could price, so the ceiling can no longer be enforced. A
   *  stop of its own, never absorbed by `blocking: false` — it is not a step
   *  failure to repair but a run-level accounting fact. */
  | { kind: "cost-unaccounted" }
  | { kind: "skip" }
  | { kind: "stopped"; reason: string }
  | { kind: "failed"; reason: string }
  /** `freshness` is the reading of a stamped step, which its pass records
   *  instead of hashing its artifact inputs again; absent for an unstamped one.
   *  `ignored` carries the consumers that ignore this step, with the sources as
   *  this admission read them. */
  | { kind: "ready"; command: string; stepLogDir: string; freshness?: Freshness; ignored?: IgnoredReading };

/** The sources some consumer does not count this step's changes to, as the step
 *  found them: what its pass compares to the consumers' stamps. */
export interface IgnoredReading {
  consumers: readonly IgnoredBy[];
  before: Record<string, Fingerprint>;
}

/** Evaluate `when` admissions in declaration order. */
export async function checkInputs(
  step: RunStepView,
  ctx: PipelineContext,
  conditions: readonly StepInputCondition[] = step.def.inputs ?? [],
): Promise<InputDecision> {
  for (const condition of conditions) {
    if (condition.kind === "function") {
      const decision = await condition.evaluate(ctx);
      if (decision.action !== "pass") return decision;
      continue;
    }

    const command = (await resolveTemplateAsync(condition.command, ctx))!;
    // Same bound as the preflight below: an admission check that hangs (e.g. git
    // prompting for credentials) must not freeze the run before any spawn.
    const result = await runBashAsync(command, {
      timeoutMs: step.def.timeout ? step.def.timeout * 1000 : 30_000,
    });
    if (!result.ok) {
      return {
        action: condition.onFailure,
        // The runner joins stderr behind a `--- stderr ---` marker; a `git` or
        // `test` guard says why it refused on stderr, so the text is kept and only
        // the marker goes, or the skip line reads `skipped: --- stderr --- ...`.
        reason: stripStderrMarker(result.output).trim() || command,
      };
    }
  }
  return { action: "pass" };
}

function applyInputDecision(
  run: RunView,
  step: RunStepView,
  output: RunOutput,
  action: InputAction,
  reason: string,
  freshness?: string,
  stop?: RunStopState,
): Exclude<StepAdmission, { kind: "ready" } | { kind: "budget-exceeded" } | { kind: "cost-unaccounted" }> {
  if (action === "skip") {
    // Not `control`: a failed or interrupted pass carries its spend there too, yet never completed.
    const alreadyCompleted = step.status === "done";
    recordSkip(run, step, { reason, freshness });
    updateStep(run, step, alreadyCompleted ? "done" : "skipped");
    output.emit({
      type: "runner.message",
      level: "info",
      message: `⊘ ${step.def.name} — ${alreadyCompleted ? "already completed" : "skipped"}: ${reason}`,
    });
    return { kind: "skip" };
  }
  if (action === "stop") {
    stopRun(run, step, reason, stop);
    output.emit({
      type: "runner.message",
      level: "info",
      message: `⏹ ${step.def.name} — clean pipeline stop: ${reason}`,
    });
    return { kind: "stopped", reason };
  }
  updateStep(run, step, "failed", `input failed: ${reason}`);
  output.emit({ type: "runner.message", level: "error", message: `${step.def.name} — input failed: ${reason}` });
  return { kind: "failed", reason };
}

/** How a step the operator's selection left out of this invocation stands. */
export type OperatorSelectionSkip = "settled" | "unfinished";

/**
 * Leave a step out of this invocation on the operator's selection, without
 * admitting it: no budget gate, no `when`, no freshness. Nothing marks the
 * step for later invocations, so the next one
 * admits it like any other. A `done` step stays `done`, as on a freshness skip.
 *
 * A step whose last pass is unfinished keeps its status (`unfinished`), and the
 * loop stops the run for a decision rather than pass over it. Those are run
 * facts, and the next invocation's admission reads them: settled, an interrupted
 * pass would replay without anyone authorizing it, and a failed one would read
 * as settled (`passLeftUnfinished`). Whether its outputs still hold is not decided
 * here: its stamp was cleared when that pass started.
 */
export function skipForOperatorSelection(run: RunView, step: RunStepView, output: RunOutput): OperatorSelectionSkip {
  if (passLeftUnfinished(step) || lastPassInterrupted(step)) {
    recordSkip(run, step, { reason: SKIP_OPERATOR_SELECTION });
    output.emit({
      type: "runner.message",
      level: "info",
      message: `⊘ ${step.def.name} — not run: ${SKIP_OPERATOR_SELECTION}; its last pass is unfinished, so it stays ${step.status}`,
    });
    return "unfinished";
  }
  applyInputDecision(run, step, output, "skip", SKIP_OPERATOR_SELECTION);
  return "settled";
}

export interface AdmitStepInput {
  run: RunView;
  step: RunStepView;
  baseCtx: PipelineContext;
  budget: RunBudget;
  output: RunOutput;
  /** `--replay-interrupted`: this invocation authorizes replaying a step the
   *  runner died in. */
  replayInterrupted?: boolean;
  /** The pipeline's `work_item_source.step_id`, never stamped. */
  workItemSourceStepId?: string;
  /** The consumers whose sources ignore this step (`Source.ignoring`). */
  ignoredBy?: readonly IgnoredBy[];
}

/** A source that could not be read makes the step run, or stop on `onStale`,
 *  without anyone seeing why: the journal keeps the reason, the console says it once. */
function reportUnavailableSources(
  input: AdmitStepInput,
  unavailable: readonly UnavailableSource[],
  then: "running" | "stopping",
): void {
  const { run, step } = input;
  for (const { source, reason } of unavailable) {
    recordUnavailableSource(run, step, { source, reason });
    input.output.emit({
      type: "runner.message",
      level: "warn",
      message: `${step.def.name} — source "${source}" unavailable, inputs stale, ${then}: ${reason}`,
    });
  }
}

/** The ignored sources as this step finds them, reusing what its own freshness
 *  already read. A source that cannot be read is `null`: nothing will move. */
async function readIgnoredSources(
  ctx: PipelineContext,
  consumers: readonly IgnoredBy[] | undefined,
  freshness: Freshness | undefined,
): Promise<IgnoredReading | undefined> {
  if (!consumers?.length || !ctx.paths.workItemDir) return undefined;
  const before: Record<string, Fingerprint> = {};
  const unread = new Map<string, IgnoredBy["source"]>();
  for (const { source } of consumers) {
    const key = sourceKey(source.name);
    if (freshness && key in freshness.inputs) before[key] = freshness.inputs[key] ?? null;
    else unread.set(key, source);
  }
  Object.assign(before, (await readInputs(ctx, [...unread.values()])).fingerprints);
  return { consumers, before };
}

/** Persist a guard rejection with the same blocking/non-blocking semantics. An
 *  admission absorbed by `blocking: false` is not a pass: it never touches the lock. */
function rejectAdmission(
  input: AdmitStepInput,
  reason: string,
): Exclude<StepAdmission, { kind: "ready" } | { kind: "budget-exceeded" } | { kind: "cost-unaccounted" }> {
  return refuseStep(input.run, input.step, input.output, reason).failed ? { kind: "failed", reason } : { kind: "skip" };
}

/** A materialized orchestration freezes its admission decision in the snapshot.
 * Re-evaluating it on resume could make an active child disappear. */
function orchestrationAlreadyStarted(step: RunStepView): boolean {
  if (step.def.runner !== "pipeline" || !step.orchestration) return false;
  return step.orchestration.items !== undefined || step.orchestration.children.length > 0;
}

/** Once materialized, only admissions marked `frozenOnStart` disappear; other author
 * guards remain evaluated on every resume. */
function admissionsToEvaluate(step: RunStepView): readonly StepInputCondition[] {
  const conditions = step.def.inputs ?? [];
  if (!orchestrationAlreadyStarted(step)) return conditions;
  return conditions.filter((condition) => !condition.frozenOnStart);
}

/** The last pass of this run started and did not complete. Its stamp was cleared
 *  when it started, so admission runs it again; the operator's selection reads it
 *  to stop rather than leave it out. */
function passLeftUnfinished(step: RunStepView): boolean {
  return step.status !== "pending" && owesWork(step.status);
}

/** Who allowed replaying a step whose last attempt the runner died in, or
 *  `undefined` when nobody did. */
function interruptedReplayAuthorization(input: AdmitStepInput): string | undefined {
  const { step } = input;
  if (step.def.replay_interrupted) return "declared replayInterrupted";
  // Replayed on every resume by its author's choice: an interrupted pass is no
  // less safe than a completed one.
  if (step.def.rerun_on_resume) return "declared rerunOnResume";
  if (input.replayInterrupted) return "--replay-interrupted";
  return undefined;
}

async function anyPendingRejection(ctx: PipelineContext, subjects: readonly string[]): Promise<boolean> {
  for (const subject of subjects) if (await pendingRejection(ctx, subject)) return true;
  return false;
}

/**
 * Prepare a step and apply all guards that precede spawn. Status mutations stay here
 * so every admission result is persisted with the same semantics.
 */
export async function admitStep(input: AdmitStepInput): Promise<StepAdmission> {
  try {
    return await admit(input);
  } catch (e) {
    // A throwing admission is a rejected admission, not a dead run. User-supplied
    // code can fail while resolving a command or predicate; without this guard the
    // exception would bypass step failure state and on_failure policy. Treat it as
    // any other step failure.
    const reason = `admission: ${truncate(errorMessage(e), 500)}`;
    return rejectAdmission(input, reason);
  }
}

async function admit(input: AdmitStepInput): Promise<StepAdmission> {
  const { run, step, baseCtx } = input;
  const cumulativeCost = input.budget.cumulative;

  // The console line is transient and `outcome.reason` is a sentence; the stop
  // the gate records is the fact a post-mortem reads, and what tells the final
  // report the cost stop is the REASON the run ended.
  const stop = costGate(run, input.budget, step.id);
  if (stop) {
    // Leave the remaining steps `pending`. They are not skipped work, they are
    // unfunded work: marking them `skipped` would settle the run and force the
    // next invocation to replay — and repay — every step already completed. The
    // same treatment applies to both stops: an unaccountable run resumes where it
    // stopped once the operator decides how to continue.
    const remaining = run.steps.filter((other) => other.status === "pending").length;
    if (stop === "cost-unaccounted") {
      input.output.emit({
        type: "runner.message",
        level: "warn",
        // The ledger is a lower bound from here on, hence `≥`: the ceiling cannot
        // be enforced against a spend nobody priced, so the run stops rather than
        // spend on the strength of a number it knows to be incomplete.
        message:
          `\nSpending is unaccounted (≥ $${cumulativeCost.toFixed(2)} / $${run.max_cost_usd}) — ${remaining} step(s) left.` +
          `\n  ↳ An attempt spent tokens no pricing table could price, so the $${run.max_cost_usd} ceiling cannot be enforced.` +
          // `--budget` is deliberately not offered here: raising the amount does not
          // make a closed attempt priceable. The authorization is the one way out,
          // and it authorizes the UNKNOWN portion only — the priced lower bound
          // keeps answering to the ceiling, so an authorized run still stops when
          // what it could price reaches `max_cost_usd`.
          `\n  ↳ To authorize spend nobody can price and resume where it stopped, rerun with --allow-unmetered` +
          `\n  ↳ It authorizes the unknown spend only: the known ≥ $${cumulativeCost.toFixed(2)} still obeys the $${run.max_cost_usd} ceiling.` +
          `\n  ↳ Pending steps are left resumable.`,
      });
      return { kind: "cost-unaccounted" };
    }
    input.output.emit({
      type: "runner.message",
      level: "warn",
      message:
        `\nBudget exceeded ($${cumulativeCost.toFixed(2)} / $${run.max_cost_usd}) — ${remaining} step(s) left.` +
        // A ceiling stops the run instead of warning, because an unattended run
        // (--scan, cron) has nobody watching. Spending more is a human decision.
        `\n  ↳ To approve a higher ceiling and resume where it stopped, rerun with --budget <usd>`,
    });
    return { kind: "budget-exceeded" };
  }

  const admissions = admissionsToEvaluate(step);
  if (admissions.length > 0) {
    const decision = await checkInputs(step, baseCtx, admissions);
    if (decision.action !== "pass") {
      return applyInputDecision(run, step, input.output, decision.action, decision.reason, undefined, decision.stop);
    }
  }

  // A rejection is the reason a rework step runs, not one of its inputs: a
  // pending one overrides the stamp, and `when` above still outranks it. The
  // command is resolved below, before attempt erases the outputs, so the prompt
  // still sees the rejected artifact through `pendingRejection`.
  const reworks = step.def.rework_for ?? [];
  const rejected = reworks.length > 0 && (await anyPendingRejection(baseCtx, reworks));

  // The class rule: only the stamp of a stamped step decides whether it owes work.
  // A failed, aborted or interrupted pass left no stamp, so it runs. The step a
  // fork starts at is forced: it does not track the repository tree, which is
  // what an operator fixes before forking.
  // A run without a ticket has no lock: its steps always run.
  let freshness: Freshness | undefined;
  if (isStamped(step.def, input.workItemSourceStepId) && baseCtx.paths.workItemDir) {
    try {
      freshness = await stepFreshness(baseCtx, step.def, stampKey(step.id, baseCtx.lot));
    } catch (error) {
      // Not routed through `blocking: false`: a lock nobody can read decides
      // nothing, and an absorbed refusal would settle the step `done` on it.
      const reason = `freshness lock: ${truncate(errorMessage(error), 500)}`;
      failStep(run, step, input.output, reason);
      return { kind: "failed", reason };
    }
    const forced = forkPending(run) && run.startAt === step.id;
    const stopOnStale = freshness.value === "stale" && step.def.on_stale === "stop" && !rejected && !forced;
    reportUnavailableSources(input, freshness.unavailable, stopOnStale ? "stopping" : "running");
    if (freshness.value === "fresh" && !rejected && !forced) {
      return applyInputDecision(run, step, input.output, "skip", SKIP_UP_TO_DATE, freshness.value);
    }
    if (stopOnStale) {
      const detail = `inputs of ${step.id} changed since it succeeded: --start-at ${step.id} to run it again`;
      return applyInputDecision(run, step, input.output, "stop", detail, undefined, {
        kind: "needs-decision",
        detail,
      });
    }
  }

  // Checked last among the guards: a step that `when` or its stamp now skips
  // replays nothing, so there is nothing to authorize.
  if (lastPassInterrupted(step)) {
    const authorization = interruptedReplayAuthorization(input);
    if (authorization === undefined) {
      const detail =
        `the runner died during the last attempt of ${step.def.name}, which may already have had side effects; ` +
        `rerun with --replay-interrupted to replay it, or declare replayInterrupted: true on step "${step.id}" if replaying is safe`;
      return applyInputDecision(run, step, input.output, "stop", detail, undefined, { kind: "needs-decision", detail });
    }
    input.output.emit({
      type: "runner.message",
      level: "info",
      message: `↻ ${step.def.name} — replaying after an interrupted attempt (${authorization})`,
    });
  }

  const command = (await resolveTemplateAsync(step.def.command, baseCtx))!;

  // Environment guard runs before spawn at zero token cost. An unreachable app
  // fails here instead of paying an agent to discover infrastructure failure and
  // run fix passes that cannot repair it.
  if (step.def.preflight) {
    const preflightCmd = (await resolveTemplateAsync(step.def.preflight, baseCtx))!;
    // Bound it to 30s; a hanging environment guard is already an answer.
    const res = await runBashAsync(preflightCmd, { timeoutMs: 30_000 });
    if (!res.ok) {
      const reason = `preflight: ${truncate(res.output.trim(), 500) || preflightCmd}`;
      return rejectAdmission(input, reason);
    }
  }

  const ignored = await readIgnoredSources(baseCtx, input.ignoredBy, freshness);
  return {
    kind: "ready",
    command,
    stepLogDir: stepLogDir(run.run_dir, step.id),
    ...(freshness ? { freshness } : {}),
    ...(ignored ? { ignored } : {}),
  };
}
