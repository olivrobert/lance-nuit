// runner/step/step-loop.ts
//
// Run step orchestration. Business responsibilities are split into admission
// (pre-spawn guards), attempt execution, and verdict resolution. The loop keeps
// only global step order.

import { join } from "node:path";
import { backendSpecForStep } from "../contracts/backends.js";
import { extractErrors } from "../exec/report-extraction.js";
import { executeStep, type StepResult } from "../exec/runners.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunOutput } from "../runtime/run-output.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { type AbortScope, createAbortScope } from "../runtime/abort.js";
import { emitRunnerEvent } from "../runtime/events.js";
import { costDecision, type RunBudget } from "../state/budget.js";
import { controlForRun, runProvesUnpricedSpend } from "../state/cost-accounting.js";
import { inheritChildBudgetStop } from "../state/cost-stop-events.js";

import { latestAttemptLog } from "../state/run-timeline.js";
import { saveRun } from "../state/run-repository.js";
import { hasUnfinishedWork } from "../state/run-predicates.js";
import { type RunOutcome, updateStep } from "../state/run-transitions.js";
import { runFixLoop } from "./fix-loop.js";
import { executePipelineOrchestration } from "./pipeline-orchestration.js";
import { admitStep, checkInputs, type StepAdmission } from "./step-admission.js";
import { runAttempt, startFreshSession } from "./step-attempt.js";
import { resolveOutcome } from "./step-outcome.js";

export type { StepAdmission };
export { admitStep, checkInputs, resolveOutcome };

function emitPipelineStep(run: Run, step: RunStep, index: number, total: number): void {
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

export function buildContext(ticket: string | undefined, baseBranch: string | undefined): PipelineContext {
  return buildPipelineContext({ ticket, baseBranch });
}

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

/** Build production dependencies while allowing callers to replace only the
 * output destination. Keeping the function boundaries required preserves the
 * existing injectable test contract. */
export function stepLoopDeps(output: RunOutput): StepLoopDeps {
  return { executeStep, extractErrors, runFixLoop, output };
}

/** Re-exported for the entry point: the shape is owned by the run finalization
 *  it feeds (`state/run-transitions.ts`). */
export type { RunOutcome } from "../state/run-transitions.js";

/**
 * Initial step attempt: create a fresh session when the backend provides one, then
 * pass once through middleware. The backend owns context-window management,
 * including compaction; the runner does not kill or recreate a session for it.
 *
 * `budgetRemaining` is not set here; the chain calculates it at spawn time, as it
 * does for retries and fixes.
 */
async function runInitialAttempt(input: {
  run: Run;
  step: RunStep;
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
  const initialSession = startFreshSession(step, agentBackend);
  if (initialSession) {
    saveRun(run);
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
  saveRun(run);
  return { result, stepLog: latestAttemptLog(run, step) ?? join(stepLogDir, "attempt-001", "output.log") };
}

export interface ExecuteRunStepsOptions {
  resuming: boolean;
  /** The abort scope this execution runs under. The entry point passes the
   *  process scope its signal handler requests on, and a composed child runs
   *  under its parent's. Absent, the execution gets a private scope: nothing but
   *  `run.aborted` can interrupt it. */
  abort?: AbortScope;
}

export async function executeRunSteps(
  run: Run,
  ticket: string | undefined,
  baseBranch: string | undefined,
  opts: ExecuteRunStepsOptions,
  deps: StepLoopDeps,
  context?: PipelineContext,
): Promise<RunOutcome> {
  const abort = opts.abort ?? createAbortScope();
  const unregisterActiveRun = abort.registerActiveRun(run);
  try {
    const { resuming } = opts;
    const loopDeps = {
      executeStep: deps.executeStep,
      extractErrors: deps.extractErrors,
      runFixLoop: deps.runFixLoop,
      output: deps.output,
    };

    // One run budget is mutated by every phase. All persisted cost counts, including
    // failed/running previous attempts, or resume would undercount the budget.
    const restoredTotals = controlForRun(run);
    // RESTORATION, not a transition: the latches below are read back from the
    // snapshot. Their transitions during execution belong to
    // `state/cost-stop-events.ts` (stops) and `state/cost-accounting.ts` (proof
    // of unpriceable spend).
    const budget: RunBudget = {
      cumulative: restoredTotals.total_cost_usd ?? 0,
      // A guard stop persisted by a previous generation still holds: the ledger
      // alone can read the ceiling as affordable when the guard fired on an estimate.
      ...(run.budget_exceeded ? { exceeded: true } : {}),
      // Uncertainty is restored from the run latch, or re-derived from the
      // reconciled attempts that PROVE it (`runProvesUnpricedSpend`) — failed,
      // interrupted and composed ones included. It is a projection, not an
      // independent counter, so a resume cannot launder an unpriced attempt by
      // starting a fresh ledger over the same spend, and reading the attempts is
      // what makes an OLD snapshot — written before the latch existed — stop
      // exactly like a new one. A bare `total_control.cost_unknown` is NOT enough:
      // the aggregate cannot say whether an attempt consumed anything, and an
      // attempt that died before reporting a figure must not stop the run.
      ...(run.cost_unaccounted === true || runProvesUnpricedSpend(run) ? { costUnknown: true } : {}),
      // Strict unless a human said otherwise. The authorization is persisted on the
      // run (`--allow-unmetered`, or propagation from the budget scope's owner), so
      // a later resume needs no flag and no environment switch.
      ...(run.allow_unmetered ? { allowUnmetered: true } : {}),
    };
    // Upgrade an old snapshot in place: the uncertainty its attempts prove becomes
    // the durable latch, so nothing has to re-derive it from the attempt history.
    if (budget.costUnknown === true) run.cost_unaccounted = true;
    let failed = false;
    let stopped = false;
    let budgetExceeded = false;
    let costUnaccounted = false;
    let costUnaccountedStop = false;
    const baseCtx = context ?? buildContext(ticket, baseBranch);
    const isAborted = () => abort.isRunAborted(run);

    for (const step of run.steps) {
      if (isAborted()) break;
      // Reconsider a settled step on resume when it asked for it, or when it
      // declares `input`: its outputs may have been produced from bytes that have
      // since changed. A re-admitted step whose outputs are all fresh costs zero.
      const reconsider = resuming && (step.def.rerun_on_resume || (step.def.sources?.length ?? 0) > 0);
      // An operator exclusion (`--step`, `--skip`, `--start-at`) is a decision, not
      // a freshness verdict: it survives the resume that re-admits the rest.
      if (step.status === "skipped" && !(reconsider && step.def.sources && !step.excluded)) continue;
      // Skip a done step on resume unless it is reconsidered. This idempotently
      // restores Git state: create-branch moves HEAD to feature/fix, while skipping
      // would leave it on base/develop and attach commits to the wrong branch.
      if (step.status === "done" && !reconsider) continue;

      const admission: StepAdmission = await admitStep({ run, step, baseCtx, budget, output: loopDeps.output });
      if (isAborted()) break;
      if (admission.kind === "skip") continue;
      if (admission.kind === "budget-exceeded") {
        budgetExceeded = true;
        break;
      }
      // Not routed through the non-blocking absorber: an unaccountable spend is a
      // run-level fact, not this step's failure, so `blocking: false` cannot
      // swallow it and keep spending.
      if (admission.kind === "cost-unaccounted") {
        costUnaccounted = true;
        costUnaccountedStop = true;
        break;
      }
      if (admission.kind === "stopped") {
        stopped = true;
        break;
      }
      if (admission.kind === "failed") {
        failed = true;
        break;
      }

      const { command, stepLogDir } = admission;
      const stepIndex = run.steps.indexOf(step) + 1;
      loopDeps.output.emit({ type: "step.started", step, index: stepIndex, total: run.steps.length });
      updateStep(run, step, "running");
      emitPipelineStep(run, step, stepIndex, run.steps.length);

      if (step.def.runner === "pipeline") {
        const orchestration = await executePipelineOrchestration({
          run,
          step,
          baseCtx,
          baseBranch,
          budget,
          resuming,
          abort,
          output: loopDeps.output,
        });
        if (isAborted()) break;
        // A child stopped by its guard stops the parent the same durable way.
        if (orchestration.budgetExceeded) inheritChildBudgetStop(run, budget);
        if (orchestration.action === "failed") {
          failed = true;
          budgetExceeded ||= orchestration.budgetExceeded;
          costUnaccounted ||= orchestration.costUnaccounted === true;
          // A fan-out that refused to launch the next child, or a child that
          // stopped at its own gate, is an accounting stop the parent reports as
          // one: the failed node is the carrier of the stop, not a defect to fix.
          costUnaccountedStop ||= orchestration.costUnaccountedStop === true;
          break;
        }
        if (orchestration.action === "stopped") {
          stopped = true;
          budgetExceeded ||= orchestration.budgetExceeded;
          costUnaccounted ||= orchestration.costUnaccounted === true;
          costUnaccountedStop ||= orchestration.costUnaccountedStop === true;
          break;
        }
        continue;
      }

      const attempt = await runInitialAttempt({
        run,
        step,
        command,
        context: baseCtx,
        stepLogDir,
        budget,
        executeStep: loopDeps.executeStep,
        output: loopDeps.output,
      });
      if (isAborted()) break;

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
          executeStep: loopDeps.executeStep,
          extractErrors: loopDeps.extractErrors,
          runFixLoop: loopDeps.runFixLoop,
        },
        output: loopDeps.output,
      });
      if (isAborted()) break;
      if (action === "failed") {
        failed = true;
        break;
      }
      if (action === "stopped") {
        stopped = true;
        break;
      }
    }

    // A live guard kill is a budget stop even though the step itself failed: the
    // ledger carries the flag so the report names the ceiling instead of blaming
    // a technical error.
    // The retry and fix loops break on the same decision without reporting it
    // upward, so the final read of the ledger is what names an accounting stop
    // reached inside them. `exceeded` keeps its precedence here as in
    // `costDecision`: a reached ceiling is the harder fact of the two.
    //
    // Only unfinished work can be stopped: a run that completed every step under
    // an unenforceable ceiling has nothing left to withhold, and turning its
    // verdict into a stop after the fact would fail a pipeline that did its job.
    // The unpriced attempt is still reported — the warning fired at closure and
    // the totals stay marked as a lower bound.
    //
    // "Unfinished work" is not only a pending step: an orchestration node whose
    // fan-out stopped mid-list is done with none of its items, and its own step
    // may already read `done` from a previous generation.
    const finalDecision = hasUnfinishedWork(run) ? costDecision(run.max_cost_usd, budget) : "continue";
    return {
      failed,
      stopped,
      budgetExceeded: budgetExceeded || budget.exceeded === true,
      costUnaccounted: costUnaccounted || finalDecision === "unaccounted",
      // The retry and fix gates record their refusal on the shared ledger; the
      // admission gate and the orchestration gates report theirs directly.
      costUnaccountedStop: costUnaccountedStop || (budget.unaccountedStop === true && finalDecision === "unaccounted"),
      cumulativeCost: budget.cumulative,
    };
  } finally {
    unregisterActiveRun();
  }
}
