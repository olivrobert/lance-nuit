//
// Run step orchestration. Business responsibilities are split into admission
// (pre-spawn guards), the pass of an admitted step (`step-pass.ts`: attempt
// execution and verdict resolution), and the group of steps that run together
// (`parallel-group.ts`). The loop keeps only global step order.

import { extractErrors } from "../report-extraction.js";
import { executeStep } from "../runners.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { readmittedOnResume, rerunsOnResume } from "../../definition/index.js";
import type { RunStepView, RunView } from "../../run/index.js";
import type { RunOutput } from "../run-output.js";
import { type AbortScope, createAbortScope } from "../abort.js";
import {
  forkPending,
  remainingWork,
  isSettledStatus,
  lastPassInterrupted,
  ledgerStops,
  matchesStepSelector,
  openRunLedger,
  type RunOutcome,
  stopRun,
} from "../../run/index.js";

import { runFixLoop } from "./fix-loop.js";
import { admitStep, type StepAdmission, skipForOperatorSelection } from "./step-admission.js";
import { type AdmittedStep, executionUnits, runParallelGroup } from "./parallel-group.js";
import { admissionStop, runStepPass, type StepLoopDeps, type StepLoopStop, type StepPassEnv } from "./step-pass.js";

export type { StepLoopDeps };

/** Build production dependencies while allowing callers to replace only the
 * output destination. Keeping the function boundaries required preserves the
 * existing injectable test contract. */
export function stepLoopDeps(output: RunOutput): StepLoopDeps {
  return { executeStep, extractErrors, runFixLoop, output };
}

/** Re-exported for the entry point: the shape is owned by the run finalization
 *  it feeds (`run/record/run-transitions.ts`). */
export type { RunOutcome } from "../../run/index.js";
export { checkForkSource, loadOrCreateRun } from "./load-or-create-run.js";

export interface ExecuteRunStepsOptions {
  resuming: boolean;
  /** The abort scope this execution runs under. The entry point passes the
   *  process scope its signal handler requests on, and a composed child runs
   *  under its parent's. Absent, the execution gets a private scope: nothing but
   *  `run.aborted` can interrupt it. */
  abort?: AbortScope;
  /** `--replay-interrupted` of this invocation; composed children inherit it. */
  replayInterrupted?: boolean;
  /** `--until` of this invocation: the step after which the loop stops. A
   *  top-level step, never inherited, never persisted. */
  until?: string;
  /** `--steps` of this invocation. It lasts this invocation only, so the loop
   *  applies it, and `--skip`. Top-level steps only, like `until`. */
  stepFilter?: readonly string[];
  /** `--skip` of this invocation; see `stepFilter`. */
  skipFilter?: readonly string[];
  /** The pipeline's `work_item_source.step_id`: that step keeps the authority of
   *  its status, whatever it declares. */
  workItemSourceStepId?: string;
}

/**
 * Whether this invocation's selectors leave `step` out. The selection lasts one
 * invocation, so this is the one place that applies it, and nothing persists
 * it. `--steps` and `--skip` leave a step out
 * whatever its status: statuses no longer decide what runs, the operator's
 * selection does.
 */
function leftOutBySelection(step: RunStepView, opts: ExecuteRunStepsOptions): boolean {
  if (opts.stepFilter && !opts.stepFilter.some((selector) => matchesStepSelector(step.id, selector))) return true;
  return opts.skipFilter?.some((selector) => matchesStepSelector(step.id, selector)) === true;
}

/** Before the step a pending fork starts at, the copied steps keep their status:
 *  only those that rerun on every resume are admitted, so that `branch` or
 *  `preflight` put the tree back before the forced step runs. */
function keptByPendingFork(run: RunView, step: RunStepView): boolean {
  if (!forkPending(run) || rerunsOnResume(step.def)) return false;
  return run.steps.indexOf(step) < run.steps.findIndex((candidate) => candidate.id === run.startAt);
}

/** The step `--until` names. Boot already refused an unknown id with the list of
 *  steps; reaching here without one is a caller bug, not an operator typo. */
function untilStepOf(run: RunView, until: string | undefined): RunStepView | undefined {
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
function stopAtBound(run: RunView, bound: RunStepView, output: RunOutput): void {
  const detail = `stop requested by --until after ${bound.def.name}: rerun to continue`;
  stopRun(run, bound, detail, { kind: "until", detail });
  output.emit({ type: "runner.message", level: "info", message: `⏹ ${bound.def.name} — ${detail}` });
}

/**
 * Stop a run whose selection left out a step an earlier pass did not finish.
 * The step owes the decision the next invocation's admission will ask for
 * (replay authorization, or a new pass), so the run stays resumable.
 */
function stopOnUnfinishedSelection(run: RunView, step: RunStepView, output: RunOutput): void {
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
  run: RunView,
  opts: ExecuteRunStepsOptions,
  deps: StepLoopDeps,
  baseCtx: PipelineContext,
): Promise<RunOutcome> {
  const abort = opts.abort ?? createAbortScope();
  const unregisterActiveRun = abort.registerActiveRun(run);
  try {
    const { resuming } = opts;

    // One ledger, shared by every phase of this execution.
    const budget = openRunLedger(run);
    let stop: StepLoopStop = {};
    let boundReached = false;
    const setAside: string[] = [];
    let leftUnfinished: RunStepView | undefined;
    const bound = untilStepOf(run, opts.until);
    const isAborted = () => abort.isRunAborted(run);
    const passEnv: StepPassEnv = {
      run,
      baseCtx,
      budget,
      abort,
      replayInterrupted: opts.replayInterrupted,
      deps,
    };

    // Every member is admitted, in order, before any of them spawns: a refusal stops
    // the run with nothing launched, which needs the outer label.
    units: for (const unit of executionUnits(run.steps)) {
      const admitted: AdmittedStep[] = [];
      for (const step of unit) {
        if (isAborted()) break units;
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
          break units;
        }
        if (keptByPendingFork(run, step)) continue;
        if (leftOutBySelection(step, opts)) {
          if (skipForOperatorSelection(run, step, deps.output) === "unfinished") leftUnfinished ??= step;
          setAside.push(step.id);
          continue;
        }
        // A resume re-admits every settled step that declares what it reads or
        // delivers, or asks to rerun, and a `done` step reworking an artifact a
        // human may have rejected. A re-admitted step with nothing to redo costs
        // zero. Orchestration nodes (`runPipeline`, `forEachPipeline`) keep the
        // authority of their status whatever they declare (D3), and so does the
        // runner's work-item source step.
        const readmitted = readmittedOnResume(step.def, opts.workItemSourceStepId);
        const reconsider = resuming && (readmitted || (step.def.rework_for?.length ?? 0) > 0);
        if (step.status === "skipped" && !(reconsider && readmitted)) continue;
        // Skip a done step on resume unless it is reconsidered. This idempotently
        // restores Git state: create-branch moves HEAD to feature/fix, while skipping
        // would leave it on base/develop and attach commits to the wrong branch.
        if (step.status === "done" && !reconsider) continue;

        const admission: StepAdmission = await admitStep({
          run,
          step,
          baseCtx,
          budget,
          output: deps.output,
          replayInterrupted: opts.replayInterrupted,
          workItemSourceStepId: opts.workItemSourceStepId,
        });
        if (isAborted()) break units;
        if (admission.kind === "skip") continue;
        if (admission.kind !== "ready") {
          stop = admissionStop(admission);
          break units;
        }
        admitted.push({ step, admission });
      }

      // A group reduced to one member, by a resume or a skip, is a lone step.
      const [first] = admitted;
      const passStop =
        admitted.length > 1
          ? await runParallelGroup(passEnv, admitted)
          : first && (await runStepPass(passEnv, first.step, first.admission));
      if (passStop) {
        stop = passStop;
        break;
      }
    }

    // A live guard kill is a budget stop even though the step itself failed, and
    // the retry and fix loops break on the gate's decision without reporting it
    // upward: the ledger names the stops reached inside them, for unfinished work
    // only (`ledgerStops`).
    const unfinished = remainingWork(run).steps.length > 0;
    // A bound with nothing owed after it changes nothing: the run completes.
    const untilStop = boundReached && bound !== undefined && unfinished;
    if (untilStop) stopAtBound(run, bound, deps.output);
    const failed = stop.failed === true;
    const stopped = stop.stopped === true;
    const budgetExceeded = stop.budgetExceeded === true;
    const costUnaccounted = stop.costUnaccounted === true;
    // A loop that went to the end can still not pass: the selection left a step
    // whose last pass is unfinished in that state, and a PASS would start a new
    // run that loses the facts of that pass: an interruption to authorize, a
    // rerun owed. Nothing else ended the run, so this is its stop.
    const ranToEnd = !failed && !stopped && !budgetExceeded && !costUnaccounted && !untilStop && !isAborted();
    const selectionStop = ranToEnd ? leftUnfinished : undefined;
    if (selectionStop) stopOnUnfinishedSelection(run, selectionStop, deps.output);
    const ledger = ledgerStops(run, budget, unfinished);
    return {
      failed,
      stopped: stopped || untilStop || selectionStop !== undefined,
      untilStop,
      budgetExceeded: budgetExceeded || ledger.budgetExceeded,
      costUnaccounted: costUnaccounted || ledger.costUnaccounted,
      // The retry and fix gates record their refusal on the shared ledger; the
      // admission gate and the orchestration gates report theirs directly.
      costUnaccountedStop: stop.costUnaccountedStop === true || ledger.costUnaccountedStop,
      setAside,
    };
  } finally {
    unregisterActiveRun();
  }
}
