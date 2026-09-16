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
import { errorMessage } from "../lib/errors.js";
import type { PipelineContext } from "../model/context.js";
import type { Run } from "../model/run.js";
import { consoleReport } from "../output/console-reporter.js";
import { ConsoleRunOutput, LiveFeedOutput } from "../output/run-output.js";
import { CompositeRunOutput, type RunOutput } from "../runtime/run-output.js";
import { StatusLineOutput } from "../output/status-line.js";
import { agentBackendRegistryOf, buildPipelineContext, workItemRegistryOf } from "../pipeline/context.js";
import type { RunnerArgs } from "../model/cli-options.js";
import type { AbortScope } from "../runtime/abort.js";
import { subscribe } from "../runtime/events.js";
import { log } from "../runtime/logging.js";
import { finalizeRun } from "../state/run-transitions.js";
import { emitRunStats } from "../state/stats/run-stats.js";
import { appendRunEvent } from "../state/run-journal.js";
import { discardedResumeNotice, selectExplicitRun, type ExplicitRunSelection } from "../state/run-selection.js";
import { loadOrCreateRun } from "../boot/resume.js";
import { saveRun } from "../state/run-repository.js";
import { wouldResumeLatest } from "../state/stores/run-storage.js";
import type { RunOutcome } from "../step/step-loop.js";
import type { ReadyRun } from "./startup.js";

export type PreparedRun =
  | { kind: "exit"; code: number }
  | { kind: "ok"; run: Run; context: PipelineContext; resuming: boolean };

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
    const explicit = selectExplicitRun(pipelineDef.name, args.ticket, args.runId, context);
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
export async function prepareRun(ready: ReadyRun, onRunCreated: (run: Run) => void): Promise<PreparedRun> {
  const { args, pipelineDef, pipelinePath, stateStore, worktreeMode } = ready;
  let context = ready.context;

  const target = resolveTargetRunDir(ready);
  if ("error" in target) {
    log(target.error);
    return { kind: "exit", code: 1 };
  }

  // A fresh run requires a clean tree; a resumed run may legitimately sit on
  // a dirty tree because implementation may be in progress.
  //
  // A merely resumABLE snapshot is not enough to answer that: when its run lock
  // is held by another runner (a worktree sharing `runs/` with the main clone),
  // `resolveRunDir` creates a NEW run, and a new run on a dirty tree is exactly
  // what the guard exists to refuse. `wouldResumeLatest` answers what will
  // actually happen, lock included.
  const resuming = !!target.dir || wouldResumeLatest(pipelineDef.name, args.ticket, args.fresh, context);
  let run: Run;
  try {
    await enforceCleanTree({
      resuming,
      allowDirty: args.allowDirty,
      worktreeMode,
      pipelineAllowsDirty: !!pipelineDef.allow_dirty,
    });

    // Expose RUNNER_BIN / RUNNER_DIR for bash steps that invoke a sub-runner.
    process.env.RUNNER_BIN = process.argv[1];
    process.env.RUNNER_DIR = dirname(process.argv[1] ?? "");

    run = await loadOrCreateRun(
      pipelinePath,
      args.ticket,
      args.stepFilter,
      args.skipFilter,
      target.dir,
      args.fresh,
      args.startAt,
      context,
      {
        stateStore,
        maxCostUsd: args.budget,
        budgetApproved: args.budget !== undefined,
        allowUnmetered: args.allowUnmetered,
        worktree: worktreeMode,
        strictSnapshot: target.explicit?.strictSnapshot,
      },
    );
  } catch (error) {
    target.explicit?.release();
    throw error;
  }
  target.explicit?.commit();
  onRunCreated(run);
  if (ready.approvedSubject) {
    appendRunEvent(run, "decision.recorded", { subject: ready.approvedSubject, decision: "approved" });
    saveRun(run);
  }
  if (run.specPath !== context.config.specPath) {
    context = buildPipelineContext({
      cwd: context.cwd,
      ticket: args.ticket,
      baseBranch: args.baseBranch,
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
 * `RunnerEventOutput` is deliberately absent from the composite: the bus already
 * writes every event it receives to the configured feed, so adding it would write
 * each step.* line twice into the very file the watcher pane reads.
 */
export function wireRunOutputs(run: Run, args: RunnerArgs): WiredOutputs {
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

/** Header printed before the first step: what runs, and what a resume skipped. */
export function announceRun(run: Run, args: RunnerArgs): void {
  log(`\nPipeline: ${run.name}`);
  if (args.ticket) log(`Ticket: ${args.ticket}`);
  if (run.max_cost_usd) log(`Budget: $${run.max_cost_usd}`);

  const done = run.steps.filter((s) => s.status === "done");
  // Both families the resume loop re-admits (`step/step-loop.ts`) must stay out of
  // "already done", or the header promises a step that is about to run again. They
  // do not make the same promise, so they get one line each: `rerun_on_resume`
  // replays unconditionally, while a step declaring `input` is only re-examined and
  // costs nothing when its sources have not moved.
  const rerun = done.filter((s) => s.def.rerun_on_resume);
  const rechecked = done.filter((s) => !s.def.rerun_on_resume && s.def.sources?.length);
  const settled = done.filter((s) => !s.def.rerun_on_resume && !s.def.sources?.length);
  if (settled.length > 0) log(`Resumed — already done: ${settled.map((s) => s.def.name).join(", ")}`);
  if (rechecked.length > 0) log(`Re-checked on resume: ${rechecked.map((s) => s.def.name).join(", ")}`);
  if (rerun.length > 0) log(`Re-run on resume: ${rerun.map((s) => s.def.name).join(", ")}`);

  const skipped = run.steps.filter((s) => s.status === "skipped");
  if (skipped.length > 0) log(`Skipped: ${skipped.map((s) => s.def.name).join(", ")}`);
}

/** Finalize the snapshot, emit statistics, print the report, and return the
 *  process exit code. An abort outranks the outcome: it is why the run stopped,
 *  and the exit code names the signal that requested it (Ctrl+C by default). */
export function reportRun(
  run: Run,
  outcome: RunOutcome,
  context: PipelineContext,
  abort: Pick<AbortScope, "isAbortRequested" | "requestedSignal">,
): number {
  finalizeRun(run, outcome);
  const statsPath = emitRunStats(run, { context });
  consoleReport(run, outcome, { statsPath, registry: agentBackendRegistryOf(context) });
  if (abort.isAbortRequested() || run.aborted) return abort.requestedSignal() === "SIGTERM" ? 143 : 130;
  // An accounting stop is a non-zero exit like a budget stop: unattended callers
  // (--scan, cron, a parent dispatch) must not read unfinished work as success.
  return outcome.failed || outcome.budgetExceeded || outcome.costUnaccounted ? 1 : 0;
}
