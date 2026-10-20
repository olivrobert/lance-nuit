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
import { reconcilable, rerunsOnResume } from "../model/definition.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunOutput } from "../runtime/run-output.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { type AbortScope, createAbortScope } from "../runtime/abort.js";
import { emitRunnerEvent } from "../runtime/events.js";
import {
  hasUnfinishedWork,
  inheritChildBudgetStop,
  isSettledStatus,
  lastPassInterrupted,
  latestAttemptLog,
  ledgerStops,
  matchesStepSelector,
  openRunLedger,
  owesWork,
  recordAbsorbedInputs,
  type RunBudget,
  type RunOutcome,
  stopRun,
  updateStep,
} from "../run-record/index.js";
import { fingerprintInputs, pureInputsOf } from "../work-item-store/index.js";

import { runFixLoop } from "./fix-loop.js";
import { executePipelineOrchestration } from "./pipeline-orchestration.js";
import {
  admitStep,
  answersToOutputs,
  checkInputs,
  type StepAdmission,
  skipForOperatorSelection,
} from "./step-admission.js";
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
 *  it feeds (`run-record/run-transitions.ts`). */
export type { RunOutcome } from "../run-record/index.js";

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

export interface ExecuteRunStepsOptions {
  resuming: boolean;
  /** The abort scope this execution runs under. The entry point passes the
   *  process scope its signal handler requests on, and a composed child runs
   *  under its parent's. Absent, the execution gets a private scope: nothing but
   *  `run.aborted` can interrupt it. */
  abort?: AbortScope;
  /** `--replay-interrupted` of this invocation; composed children inherit it. */
  replayInterrupted?: boolean;
  /** `--start-at` of this invocation. It names a top-level step, so children do
   *  not inherit it. */
  startAt?: string;
  /** `--until` of this invocation: the step after which the loop stops. A
   *  top-level step like `startAt`, never inherited, never persisted. */
  until?: string;
  /** `--steps` of this invocation. In reconcile mode the loop applies it, and
   *  `--skip`, instead of boot persisting them as exclusions. Top-level steps
   *  only, like `startAt`. */
  stepFilter?: readonly string[];
  /** `--skip` of this invocation; see `stepFilter`. */
  skipFilter?: readonly string[];
}

/**
 * Whether this invocation's selectors leave `step` out, in reconcile mode. The
 * selection lasts one invocation, so this is the one place that applies it; boot
 * persists it only in legacy mode. `--steps` and `--skip` leave a step out
 * whatever its status: statuses no longer decide what runs, the operator's
 * selection does. `--start-at` keeps its scope: before the target, only work
 * still owed is left out, and a `done` step is re-admitted as usual.
 */
function leftOutBySelection(run: Run, step: RunStep, opts: ExecuteRunStepsOptions): boolean {
  if (opts.stepFilter && !opts.stepFilter.some((selector) => matchesStepSelector(step.id, selector))) return true;
  if (opts.skipFilter?.some((selector) => matchesStepSelector(step.id, selector))) return true;
  if (opts.startAt === undefined) return false;
  const target = run.steps.findIndex((candidate) => candidate.id === opts.startAt);
  return run.steps.indexOf(step) < target && owesWork(step.status);
}

/** The step `--until` names. Boot already refused an unknown id with the list of
 *  steps; reaching here without one is a caller bug, not an operator typo. */
function untilStepOf(run: Run, until: string | undefined): RunStep | undefined {
  if (until === undefined) return undefined;
  const step = run.steps.find((candidate) => candidate.id === until);
  if (!step) throw new Error(`--until: step "${until}" is not a step of pipeline "${run.name}"`);
  return step;
}

/**
 * Stop the run at its `--until` bound. The steps after it stay `pending` for
 * the same reason as at a budget stop (`step-admission.ts`): they are work this
 * invocation did not fund, not work anyone decided to skip, and only `pending`
 * keeps the run resumable.
 */
function stopAtBound(run: Run, bound: RunStep, output: RunOutput): void {
  const detail = `stop requested by --until after ${bound.def.name}: rerun to continue`;
  stopRun(run, bound, detail, { kind: "until", detail });
  output.emit({ type: "runner.message", level: "info", message: `⏹ ${bound.def.name} — ${detail}` });
}

/**
 * Stop a run whose selection left out a step an earlier pass did not finish.
 * The step owes the decision the next invocation's admission will ask for
 * (replay authorization, or a new pass), so the run stays resumable.
 */
function stopOnUnfinishedSelection(run: Run, step: RunStep, output: RunOutput): void {
  const replay = lastPassInterrupted(step)
    ? "; the runner died in its last attempt, so that rerun will ask for --replay-interrupted"
    : "";
  const detail =
    `${step.def.name} was left out by operator selection while its last pass is unfinished: ` +
    `rerun without the selection to resolve it${replay}`;
  stopRun(run, step, detail, { kind: "needs-decision", detail });
  output.emit({ type: "runner.message", level: "info", message: `⏹ ${step.def.name} — ${detail}` });
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
    // The mode as boot read it from the definition the steps come from.
    const reconcile = run.reconcile === true;
    const loopDeps = {
      executeStep: deps.executeStep,
      extractErrors: deps.extractErrors,
      runFixLoop: deps.runFixLoop,
      output: deps.output,
    };

    // One ledger, shared by every phase of this execution.
    const budget = openRunLedger(run);
    let failed = false;
    let stopped = false;
    let budgetExceeded = false;
    let costUnaccounted = false;
    let costUnaccountedStop = false;
    let boundReached = false;
    const setAside: string[] = [];
    let leftUnfinished: RunStep | undefined;
    const bound = untilStepOf(run, opts.until);
    const baseCtx = context ?? buildContext(ticket, baseBranch);
    const isAborted = () => abort.isRunAborted(run);

    for (const step of run.steps) {
      if (isAborted()) break;
      // The `--until` bound is reached once its step settled (`done` or
      // `skipped`), or once this invocation's selection left it out, even
      // unfinished: every exit below that leaves it unsettled breaks the loop
      // first, so the next step is where this invocation ends.
      if (
        bound &&
        run.steps.indexOf(step) > run.steps.indexOf(bound) &&
        (isSettledStatus(bound.status) || setAside.includes(bound.id))
      ) {
        boundReached = true;
        break;
      }
      if (reconcile && leftOutBySelection(run, step, opts)) {
        if (skipForOperatorSelection(run, step, loopDeps.output) === "unfinished") leftUnfinished ??= step;
        setAside.push(step.id);
        continue;
      }
      // Reconsider a settled step on resume when it asked for it, when it
      // declares `input` (its outputs may have been produced from bytes that have
      // since changed), or when it reworks an artifact a human may have rejected.
      // A re-admitted step with nothing to redo costs zero. Reconcile mode
      // re-admits every step that declares what it delivers, except
      // orchestration nodes (`runPipeline`, `forEachPipeline`), which keep the
      // authority of their status whatever they declare. A step declaring
      // neither output nor rerunOnResume can only be the runner's work-item
      // source step (the build refuses any other), and keeps its status too.
      const reconciled = reconcile && reconcilable(step.def);
      const reconsider =
        resuming &&
        (reconciled ||
          rerunsOnResume(step.def, reconcile) ||
          (step.def.sources?.length ?? 0) > 0 ||
          (step.def.rework_for?.length ?? 0) > 0);
      // A legacy operator exclusion (`--steps`, `--skip`, `--start-at`) is a
      // decision, not a freshness verdict: it survives the resume that re-admits
      // the rest. Reconcile mode persists none (above).
      if (step.status === "skipped" && !(reconsider && (reconciled || step.def.sources) && !step.excluded)) continue;
      // Skip a done step on resume unless it is reconsidered. This idempotently
      // restores Git state: create-branch moves HEAD to feature/fix, while skipping
      // would leave it on base/develop and attach commits to the wrong branch.
      if (step.status === "done" && !reconsider) continue;

      const admission: StepAdmission = await admitStep({
        run,
        step,
        baseCtx,
        budget,
        output: loopDeps.output,
        replayInterrupted: opts.replayInterrupted,
        startAt: opts.startAt,
        reconcile,
      });
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
          replayInterrupted: opts.replayInterrupted,
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
      // `updateStep(running)` cleared `errors` for this pass, so a `done` step
      // carrying one absorbed its failure. Fingerprinted here, after any fix that
      // rewrote the inputs and before a later step can: a resume then re-checks
      // the step only when something else changed them. In reconcile mode a step
      // without input answers to its missing outputs too, so it needs the same
      // record (an empty one) not to replay its failure on every invocation.
      if (answersToOutputs(step.def, reconcile) && step.status === "done" && step.errors !== undefined) {
        recordAbsorbedInputs(run, step, await fingerprintInputs(baseCtx, pureInputsOf(step.def)));
      }
      if (action === "failed") {
        failed = true;
        break;
      }
      if (action === "stopped") {
        stopped = true;
        break;
      }
    }

    // A live guard kill is a budget stop even though the step itself failed, and
    // the retry and fix loops break on the gate's decision without reporting it
    // upward: the ledger names the stops reached inside them, for unfinished work
    // only (`ledgerStops`). "Unfinished work" is not only a pending step: an
    // orchestration node whose fan-out stopped mid-list is done with none of its
    // items, and its own step may already read `done` from a previous generation.
    const unfinished = hasUnfinishedWork(run);
    // A bound with nothing owed after it changes nothing: the run completes.
    const untilStop = boundReached && bound !== undefined && unfinished;
    if (untilStop) stopAtBound(run, bound, loopDeps.output);
    // A loop that went to the end can still not pass: the selection left a step
    // whose last pass is unfinished in that state, and a PASS would start a new
    // run that loses the facts of that pass: an interruption to authorize, a
    // rerun owed. Nothing else ended the run, so this is its stop.
    const ranToEnd = !failed && !stopped && !budgetExceeded && !costUnaccounted && !untilStop && !isAborted();
    const selectionStop = ranToEnd ? leftUnfinished : undefined;
    if (selectionStop) stopOnUnfinishedSelection(run, selectionStop, loopDeps.output);
    const ledger = ledgerStops(run, budget, unfinished);
    return {
      failed,
      stopped: stopped || untilStop || selectionStop !== undefined,
      untilStop,
      budgetExceeded: budgetExceeded || ledger.budgetExceeded,
      costUnaccounted: costUnaccounted || ledger.costUnaccounted,
      // The retry and fix gates record their refusal on the shared ledger; the
      // admission gate and the orchestration gates report theirs directly.
      costUnaccountedStop: costUnaccountedStop || ledger.costUnaccountedStop,
      cumulativeCost: budget.cumulative,
      setAside,
    };
  } finally {
    unregisterActiveRun();
  }
}
