// Public compatibility facade for the run-stats projection and emission. Calculation
// lives in run-stats-projector.ts; writing lives in run-stats-sink.ts.

import { spawnSync } from "node:child_process";
import { basename, isAbsolute, relative } from "node:path";
import { resolveTicketDir } from "../../env/tickets.js";
import type { PipelineContext } from "../../model/context.js";
import type { Run } from "../../model/run.js";
import { runRefFromRun } from "../../model/storage-ports.js";
import { findStepLog, logicalAttemptLogPath } from "../run-timeline.js";
import { FileRunEventStore } from "../stores/file-run-event-store.js";
import { FileRunLogStore } from "../stores/file-run-log-store.js";
import { projectRunStatsEntry, type RunStatsEntry } from "./run-stats-projector.js";
import { FileRunStatsSink, type RunStatsSink } from "./run-stats-sink.js";

export type {
  PhaseStats,
  RunStatsEntry,
  RunStatsProjectionOptions,
  TokenCounts,
  UsageStatus,
} from "./run-stats-projector.js";
export { projectRunStatsEntry } from "./run-stats-projector.js";
export type { FileRunStatsSinkOptions, RunStatsSink } from "./run-stats-sink.js";
export { FileRunStatsSink } from "./run-stats-sink.js";

/**
 * Keep the call signature stable: file adapters are injected here when the caller has
 * not attached stores to Run. The projector remains pure.
 */
export function buildRunStatsEntry(run: Run, context?: PipelineContext): RunStatsEntry {
  const eventStore = run.eventStore ?? new FileRunEventStore({ runDir: run.run_dir });
  const logStore = run.logStore ?? new FileRunLogStore({ runDir: run.run_dir });
  const projectedRun =
    run.eventStore === eventStore && run.logStore === logStore ? run : { ...run, eventStore, logStore };
  const ticketDir = run.ticket
    ? resolveTicketDir(run.ticket, context?.config.specPath, context?.cwd ?? process.cwd())
    : null;

  const logPathForStep = (stepId: string): string | null => {
    if (!run.logStore) {
      try {
        return findStepLog(projectedRun, stepId);
      } catch {
        // A missing local log does not prevent projection of the run itself.
        return null;
      }
    }

    // A remote/in-memory store exposes a logical LogRef, not necessarily a
    // filesystem path. Prefer the persisted logical reference from the
    // snapshot, then ask the store for its latest identity if it supports it.
    const step = run.steps.find((candidate) => candidate.id === stepId);
    const recorded = step?.attempts?.at(-1)?.log_path;
    if (recorded) return recorded;
    try {
      const latest = run.logStore.findLatest?.(
        runRefFromRun({
          runId: run.runId ?? basename(run.run_dir),
          pipeline: run.pipeline,
          ticket: run.ticket,
        }),
        stepId,
      );
      if (!latest) return null;
      return latest.localPath ?? logicalAttemptLogPath(stepId, latest.attempt);
    } catch {
      // Optional latest-log lookup is diagnostic metadata, not run state.
      return null;
    }
  };

  return projectRunStatsEntry(projectedRun, {
    eventStore,
    logStore,
    ticketDir,
    logPathForStep,
  });
}

function gitValue(projRoot: string, args: string[]): string | null {
  try {
    // These probes remain synchronous because emitRunStats runs in a signal handler;
    // their duration is bounded and failures are ignored, so they cannot block
    // run persistence.
    const out = spawnSync("git", args, {
      cwd: projRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return out.status === 0 ? out.stdout.toString().trim() || null : null;
  } catch {
    // Git metadata is optional and must not block run-stat persistence.
    return null;
  }
}

function headCommit(projRoot: string): string | null {
  return gitValue(projRoot, ["rev-parse", "--short", "HEAD"]);
}

function headBranch(projRoot: string): string | null {
  return gitValue(projRoot, ["branch", "--show-current"]);
}

function relativeSource(projRoot: string, path: string): string {
  const value = isAbsolute(path) ? relative(projRoot, path) : path;
  return value.replaceAll("\\", "/");
}

export interface EmitRunStatsOptions {
  projRoot?: string;
  context?: PipelineContext;
  /** Custom sink; the file sink remains the default. */
  sink?: RunStatsSink;
}

/** Emit the projection into central history. The returned path is always the
 * central source path for the default file sink. */
export function emitRunStats(run: Run, opts: EmitRunStatsOptions = {}): string | null {
  const projRoot = opts.projRoot ?? opts.context?.cwd ?? process.cwd();
  try {
    const entry = buildRunStatsEntry(run, opts.context);
    entry.commit = headCommit(projRoot);
    entry.branch = headBranch(projRoot);
    entry.sourceRunDir = relativeSource(projRoot, run.run_dir);

    const sink = opts.sink ?? new FileRunStatsSink({ projRoot });
    return sink.write(entry);
  } catch {
    // Stats emission is best effort and cannot change the run's outcome.
    return null;
  }
}
