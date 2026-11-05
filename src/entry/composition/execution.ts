// runner/entry/execution.ts
//
// The normal-run half of the entry point: resolve which snapshot to run, guard
// the tree, wire the outputs, execute the steps, report.
//
// Like `startup.ts`, these phases return outcomes instead of exiting, so the
// single `process.exit` stays in `runner.ts`.

import { dirname } from "node:path";
import { startLiveFeed } from "./feed.js";
import { enforceCleanTree } from "../boot/gitguard.js";
import { errorMessage } from "../../shared/lib/errors.js";
import type { PipelineContext } from "../../shared/language/context.js";
import {
  reconcilable,
  rerunsOnResume,
  agentBackendRegistryOf,
  buildPipelineContext,
  workItemRegistryOf,
} from "../../definition/index.js";
import type { RunStepView, RunView } from "../../run/index.js";
import { consoleReport } from "../output/console-reporter.js";
import { ConsoleRunOutput, LiveFeedOutput } from "../output/run-output.js";
import { CompositeRunOutput, type RunOutput, loadOrCreateRun, type RunOutcome } from "../../execution/index.js";
import { StatusLineOutput } from "../output/status-line.js";
import type { RunnerArgs } from "../cli-options.js";
import { UNTIL_STOP_EXIT_CODE } from "../../shared/language/run-stop.js";
import type { AbortScope } from "../../execution/index.js";
import { subscribe } from "../../shared/runtime/events.js";
import { log } from "../../shared/runtime/logging.js";
import {
  discardedResumeNotice,
  type ExplicitRunSelection,
  finalizeRun,
  recordDecision,
  runEnding,
  selectExplicitRun,
  wouldResumeLatest,
  emitRunStats,
} from "../../run/index.js";
import type { ReadyRun } from "./startup.js";

export type PreparedRun =
  | { kind: "exit"; code: number }
  | { kind: "ok"; run: RunView; context: PipelineContext; resuming: boolean };

/**
 * Resolve the run directory this invocation targets.
 *
 * An explicit `--run` targets one snapshot directly; otherwise surface a
 * still-usable snapshot discarded by resume policy (for example a manual stop).
 */
function resolveTargetRunDir(ready: ReadyRun): { dir?: string; explicit?: ExplicitRunSelection } | { error: string } {
  const { args, pipelineDef, context } = ready;
  if (!args.runId) {
    if (!args.fresh) {
      const notice = discardedResumeNotice(pipelineDef.name, args.ticket, context);
      if (notice) log.warn(notice);
    }
    return {};
  }
  try {
    const explicit = selectExplicitRun(pipelineDef.name, args.ticket, args.runId, context, {
      replay: args.startAt !== undefined,
    });
    log(`→ Explicitly resuming run ${args.runId}`);
    return { dir: explicit.dir, explicit };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * Everything between the dispatch decision and the first step: snapshot
 * selection, the clean-tree guard, the sub-runner environment, and the run
 * itself.
 *
 * `onRunCreated` fires as soon as the run exists, before any further bookkeeping:
 * the signal handler must be able to persist an abort for it from that moment on.
 */
export async function prepareRun(ready: ReadyRun, onRunCreated: (run: RunView) => void): Promise<PreparedRun> {
  const { args, pipelineDef, pipelinePath, stateStore, worktreeMode } = ready;
  let context = ready.context;

  const target = resolveTargetRunDir(ready);
  if ("error" in target) {
    log(target.error);
    return { kind: "exit", code: 1 };
  }

  // A fresh run requires a clean tree; a resumed run may legitimately sit on
  // a dirty tree because implementation may be in progress. The guard runs
  // before any run directory exists, so it can only predict the resume.
  //
  // A resumable `latest` held by another runner (a worktree sharing `runs/` with
  // the main clone) does not create a new run: `resolveRunDir` fails with the
  // holder and the options. It still counts as resuming here, so the guard does
  // not replace that diagnosis with a dirty-tree refusal.
  const resumesExisting = !!target.dir || wouldResumeLatest(pipelineDef.name, args.ticket, args.fresh, context);
  let run: RunView;
  let resuming: boolean;
  try {
    await enforceCleanTree({
      resuming: resumesExisting,
      allowDirty: args.allowDirty,
      worktreeMode,
      pipelineAllowsDirty: !!pipelineDef.allow_dirty,
    });

    // Expose RUNNER_BIN / RUNNER_DIR for bash steps that invoke a sub-runner.
    process.env.RUNNER_BIN = process.argv[1];
    process.env.RUNNER_DIR = dirname(process.argv[1] ?? "");

    // The loop is told what the opening did, not what the guard predicted.
    ({ run, resumed: resuming } = await loadOrCreateRun({
      pipelinePath,
      ticket: args.ticket,
      stepFilter: args.stepFilter,
      skipFilter: args.skipFilter,
      runDir: target.dir,
      fresh: args.fresh,
      startAt: args.startAt,
      context,
      stateStore,
      maxCostUsd: args.budget,
      budgetApproved: args.budget !== undefined,
      allowUnmetered: args.allowUnmetered,
      worktree: worktreeMode,
      strictSnapshot: target.explicit?.strictSnapshot,
    }));
  } catch (error) {
    target.explicit?.release();
    throw error;
  }
  target.explicit?.commit();
  onRunCreated(run);
  if (ready.recordedDecision) recordDecision(run, ready.recordedDecision);
  if (run.specPath !== context.config.specPath) {
    context = buildPipelineContext({
      cwd: context.cwd,
      ticket: args.ticket,
      baseBranch: args.baseBranch,
      worktree: context.worktree,
      runnerBin: context.runnerBin,
      runnerDir: context.runnerDir,
      config: { ...context.config, specPath: run.specPath ?? context.config.specPath },
      workItemRegistry: workItemRegistryOf(context),
      agentBackendRegistry: agentBackendRegistryOf(context),
    });
  }

  return { kind: "ok", run, context, resuming };
}

/** Output fan-out owned by one run, plus the teardown that releases stderr. */
export interface WiredOutputs {
  output: RunOutput;
  /** Release stderr. It must be called before the final report so the report
   *  lands on a clean line. */
  release(): void;
}

/**
 * Each run owns its output fan-out. Backends that still publish telemetry to the
 * global runtime bus continue to use the configured feed; step progress goes
 * through these explicit destinations.
 *
 * The status line comes first so it clears itself before the console prints a
 * step header, and it also listens to the bus: backend telemetry (context
 * occupancy, tool calls) is published there, not through the step fan-out.
 *
 * Step events are not bus events (`RunOutputEvent`): the bus writes what it receives
 * to the configured feed, so carrying them too would write each step.* line twice
 * into the very file the watcher pane reads.
 */
export function wireRunOutputs(run: RunView, args: RunnerArgs): WiredOutputs {
  const liveFeed = startLiveFeed(run.run_dir, args.watch, { autoClose: args.watchAutoClose });
  const statusLine = new StatusLineOutput();
  const releaseStatusLine = statusLine.attach();
  const unsubscribeStatusLine = subscribe((event) => statusLine.emit(event));
  return {
    output: new CompositeRunOutput([statusLine, new ConsoleRunOutput(), new LiveFeedOutput(liveFeed)]),
    release: () => {
      unsubscribeStatusLine();
      releaseStatusLine();
    },
  };
}

/** Header printed before the first step: what runs, and what a resume skipped.
 *  `reconcile` is the pipeline's mode, which widens what the loop re-admits. */
export function announceRun(run: RunView, args: RunnerArgs, reconcile = false): void {
  log(`\nPipeline: ${run.name}`);
  if (args.ticket) log(`Ticket: ${args.ticket}`);
  if (run.max_cost_usd) log(`Budget: $${run.max_cost_usd}`);

  const done = run.steps.filter((s) => s.status === "done");
  // Both families the resume loop re-admits (`execution/step/step-loop.ts`) must stay out of
  // "already done", or the header promises a step that is about to run again. They
  // do not make the same promise, so they get one line each: `rerun_on_resume`
  // replays unconditionally, while a step declaring `input` or reworking a gated
  // artifact is only re-examined and costs nothing when its sources have not moved
  // and no rejection is pending.
  const reexamined = (s: RunStepView) =>
    (s.def.sources?.length ?? 0) > 0 || (s.def.rework_for?.length ?? 0) > 0 || (reconcile && reconcilable(s.def));
  const reruns = (s: RunStepView) => rerunsOnResume(s.def, reconcile);
  const rerun = done.filter(reruns);
  const rechecked = done.filter((s) => !reruns(s) && reexamined(s));
  const settled = done.filter((s) => !reruns(s) && !reexamined(s));
  if (settled.length > 0) log(`Resumed — already done: ${settled.map((s) => s.def.name).join(", ")}`);
  if (rechecked.length > 0) log(`Re-checked on resume: ${rechecked.map((s) => s.def.name).join(", ")}`);
  if (rerun.length > 0) log(`Re-run on resume: ${rerun.map((s) => s.def.name).join(", ")}`);

  const skipped = run.steps.filter((s) => s.status === "skipped");
  if (skipped.length > 0) log(`Skipped: ${skipped.map((s) => s.def.name).join(", ")}`);
}

/** Finalize the snapshot, emit statistics, print the report, and return the
 *  process exit code. The code follows the precedence the status and the report
 *  read (`runEnding`): an abort outranks the outcome, and its code names the
 *  signal that requested it (Ctrl+C by default). */
export function reportRun(
  run: RunView,
  outcome: RunOutcome,
  context: PipelineContext,
  abort: Pick<AbortScope, "isAbortRequested" | "requestedSignal">,
): number {
  finalizeRun(run, outcome);
  const statsPath = emitRunStats(run, { context });
  consoleReport(run, outcome, { statsPath, registry: agentBackendRegistryOf(context) });
  const { exit } = runEnding({
    // A signal this process received counts even when no run recorded it yet.
    aborted: abort.isAbortRequested() || run.aborted,
    stopped: outcome.stopped,
    failed: outcome.failed,
    budgetExceeded: outcome.budgetExceeded,
    costUnaccounted: outcome.costUnaccounted,
    costUnaccountedStop: outcome.costUnaccountedStop,
    untilStop: outcome.untilStop,
  });
  switch (exit) {
    case "interrupted":
      return abort.requestedSignal() === "SIGTERM" ? 143 : 130;
    case "failure":
      return 1;
    case "until":
      return UNTIL_STOP_EXIT_CODE;
    case "success":
      return 0;
  }
}
