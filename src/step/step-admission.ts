// runner/step/step-admission.ts
//
// Step admission before any spawn: budget, inputs, and preflight. This module does
// not know sessions or on_failure strategies; it decides whether execution may run.

import { join } from "node:path";
import type { InputAction, InputDecision, StepInputCondition } from "../dsl/input.js";
import { stripStderrMarker } from "../exec/bash-runner.js";
import { runBashAsync } from "../exec/runners.js";
import { errorMessage } from "../lib/errors.js";
import { truncate } from "../lib/truncate.js";
import type { PipelineContext } from "../model/context.js";
import { resolveTemplateAsync } from "../model/definition.js";
import type { RunStopState } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunOutput } from "../runtime/run-output.js";
import { costDecision, type RunBudget } from "../state/budget.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import { adoptOutputs, stepFreshness } from "../state/provenance.js";
import { appendRunEvent } from "../state/run-journal.js";
import { stopRun, updateStep } from "../state/run-transitions.js";
import { absorbNonBlocking } from "./non-blocking.js";

/** Reason logged when declared inputs still match every produced output. */
const SKIP_UP_TO_DATE = "outputs up to date with declared inputs";

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
  | { kind: "ready"; command: string; stepLogDir: string };

/** Evaluate `when` admissions in declaration order. */
export async function checkInputs(
  step: RunStep,
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
  run: Run,
  step: RunStep,
  output: RunOutput,
  action: InputAction,
  reason: string,
  freshness?: string,
  stop?: RunStopState,
): Exclude<StepAdmission, { kind: "ready" } | { kind: "budget-exceeded" } | { kind: "cost-unaccounted" }> {
  if (action === "skip") {
    const alreadyRan = step.control != null;
    // The console line is transient; the journal is what a later diagnosis reads.
    appendRunEvent(run, "step.skipped", { stepId: step.id, reason, freshness });
    updateStep(run, step, alreadyRan ? "done" : "skipped");
    output.emit({
      type: "runner.message",
      level: "info",
      message: `⊘ ${step.def.name} — ${alreadyRan ? "already completed" : "skipped"}: ${reason}`,
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

export interface AdmitStepInput {
  run: Run;
  step: RunStep;
  baseCtx: PipelineContext;
  budget: RunBudget;
  output: RunOutput;
}

/** Persist a guard rejection with the same blocking/non-blocking semantics. */
function rejectAdmission(
  input: AdmitStepInput,
  reason: string,
): Exclude<StepAdmission, { kind: "ready" } | { kind: "budget-exceeded" } | { kind: "cost-unaccounted" }> {
  const { run, step } = input;
  if (step.def.blocking === false) {
    absorbNonBlocking(run, step, input.output, reason);
    return { kind: "skip" };
  }
  updateStep(run, step, "failed", reason);
  input.output.emit({ type: "step.failed", step, suffix: ` (${reason})` });
  return { kind: "failed", reason };
}

/** A materialized orchestration freezes its admission decision in the snapshot.
 * Re-evaluating it on resume could make an active child disappear. */
function orchestrationAlreadyStarted(step: RunStep): boolean {
  if (step.def.runner !== "pipeline" || !step.orchestration) return false;
  return step.orchestration.items !== undefined || step.orchestration.children.length > 0;
}

/** Once materialized, only admissions marked `frozenOnStart` disappear; other author
 * guards remain evaluated on every resume. */
function admissionsToEvaluate(step: RunStep): readonly StepInputCondition[] {
  const conditions = step.def.inputs ?? [];
  if (!orchestrationAlreadyStarted(step)) return conditions;
  return conditions.filter((condition) => !condition.frozenOnStart);
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

  const decision = costDecision(run.max_cost_usd, input.budget);
  if (decision !== "continue") {
    // Leave the remaining steps `pending`. They are not skipped work, they are
    // unfunded work: marking them `skipped` would settle the run and force the
    // next invocation to replay — and repay — every step already completed. The
    // same treatment applies to both stops: an unaccountable run resumes where it
    // stopped once the operator decides how to continue.
    const remaining = run.steps.filter((other) => other.status === "pending").length;
    if (decision === "unaccounted") {
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
      // The console line is transient and `outcome.reason` is a sentence; the
      // recorded stop is the fact a post-mortem reads, and what tells the final
      // report the accounting stop is the REASON the run ended.
      recordCostStop(run, input.budget, decision, { kind: "gate", stepId: step.id });
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
    recordCostStop(run, input.budget, decision, { kind: "gate", stepId: step.id });
    return { kind: "budget-exceeded" };
  }

  const declaresInput = (step.def.sources?.length ?? 0) > 0;
  const admissions = admissionsToEvaluate(step);
  if (admissions.length > 0) {
    const decision = await checkInputs(step, baseCtx, admissions);
    if (decision.action !== "pass") {
      // `when` decides first; freshness only annotates the outcome. A step whose
      // author guard refuses while its inputs moved is a fact worth reading in the
      // journal: the outputs on disk no longer match what they came from.
      const report = declaresInput ? await stepFreshness(baseCtx, step.def) : undefined;
      const reason = report?.stale ? `${decision.reason} (inputs changed, outputs kept)` : decision.reason;
      return applyInputDecision(run, step, input.output, decision.action, reason, report?.summary, decision.stop);
    }
  }

  if (declaresInput) {
    const report = await stepFreshness(baseCtx, step.def);
    if (!report.mustRun) {
      // Adopt before skipping: an output produced before this record existed keeps
      // its content and gains the fingerprints it is being trusted against.
      await adoptOutputs(baseCtx, step.id, report);
      return applyInputDecision(run, step, input.output, "skip", SKIP_UP_TO_DATE, report.summary);
    }
  }

  const command = (await resolveTemplateAsync(step.def.command, baseCtx))!;
  step.last_command = command;

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

  return { kind: "ready", command, stepLogDir: join(run.run_dir, "steps", step.id) };
}
