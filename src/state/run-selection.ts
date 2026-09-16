// runner/state/run-selection.ts
//
// Select a resumed run when `latest` is not enough.
//
// By default resolveRunDir resumes `latest` only when resumeDecision allows it.
// Manually interrupted runs (SIGINT → ABORTED) now resume by default; only runs
// whose outcome opted out (`resumable: false`, including snapshots aborted before
// that policy) are discarded and silently start over.
//
// This module explains what was discarded and lets users select it with
// `--run <runId>`. It sits above run-storage because it validates run identity;
// moving it into run-storage would create a cycle with FileRunStateStore.

import { join } from "node:path";
import { errorMessage } from "../lib/errors.js";
import { createRunRef } from "../model/storage-ports.js";
import type { PipelineContext } from "../model/context.js";
import { pendingSteps, resumeDecision, settledButUnfinalized } from "./run-predicates.js";
import { describeRunSnapshotProblem, readRunSnapshotDiagnostic } from "./run-snapshot.js";
import {
  claimRunDir,
  pipelineRunsDir,
  pointLatestTo,
  releaseRunDir,
  resolveLatestRunSnapshot,
  runLockHolder,
  STATE_FILE,
} from "./stores/run-storage.js";

export interface ExplicitRunSelection {
  dir: string;
  strictSnapshot: {
    path: string;
    releaseRunLock: boolean;
    expectedIdentity: { runId: string; pipeline: string; ticket?: string };
  };
  /** Update `latest` only after boot has re-read the selected snapshot. */
  commit(): void;
  /** Used if boot stops before the selected run becomes live. */
  release(): void;
}

function explicitSnapshotError(
  diagnostic: Exclude<ReturnType<typeof readRunSnapshotDiagnostic>, { kind: "valid" }>,
): Error {
  return new Error(
    `--run: ${diagnostic.kind === "absent" ? "run not found; " : ""}selected snapshot ${diagnostic.path} ` +
      `${describeRunSnapshotProblem(diagnostic)}. ` +
      `Inspect or restore the run files, or use --fresh to start a new run.`,
  );
}

/**
 * Directory for the run selected by `--run`. Validation is strict: resuming the
 * wrong run costs more than failing immediately. The store validates identity via
 * `createRunRef` instead of sanitizing it.
 *
 * Naming a run is the decision, so this path does not consult `resumeDecision`:
 * a run whose outcome opted out of automatic resume is still accepted. It only
 * refuses a run with nothing left to do — no pending step and no missing
 * verdict. A settled-but-unfinalized run (crash between the last step and
 * `finalizeRun`) has no pending step yet still owes its verdict, and automatic
 * resume accepts it; refusing it here would leave it unreachable.
 */
export function selectExplicitRun(
  pipelineName: string,
  ticket: string | undefined,
  runId: string,
  context?: PipelineContext,
): ExplicitRunSelection {
  const pipelineDir = pipelineRunsDir(pipelineName, ticket, context);
  let ref: ReturnType<typeof createRunRef>;
  try {
    ref = createRunRef({ runId, pipeline: pipelineName, ticket });
  } catch (error) {
    // `../other-pipeline/xxx` stops here: createRunRef rejects non-logical run IDs,
    // whereas basename() would silently discard the traversal.
    throw new Error(`--run: invalid run identity "${runId}" — ${errorMessage(error)}`, { cause: error });
  }
  const runDir = join(pipelineDir, ref.runId);
  const diagnostic = readRunSnapshotDiagnostic(join(runDir, STATE_FILE));
  if (diagnostic.kind !== "valid") {
    throw explicitSnapshotError(diagnostic);
  }
  const snapshot = diagnostic.snapshot;
  const identity = [
    ["runId", snapshot.runId, runId],
    ["pipeline", snapshot.pipeline, pipelineName],
    ["ticket", snapshot.ticket, ticket],
  ] as const;
  const mismatches = identity
    .filter(([, actual, expected]) => actual !== expected)
    .map(([field, , expected]) => `${field} (expected ${String(expected)})`);
  if (mismatches.length > 0) {
    throw new Error(`--run: snapshot identity mismatch for "${runId}": ${mismatches.join(", ")}`);
  }
  if (pendingSteps(snapshot).length === 0 && !settledButUnfinalized(snapshot)) {
    throw new Error(`--run: run "${runId}" has no remaining step to execute — nothing to resume.`);
  }

  // An explicit resume is still a resume: it must take the same single-writer
  // lock as `latest` adoption, or two runners interleave snapshots and journal
  // entries in the same directory.
  const claim = claimRunDir(runDir);
  if (!claim.ok) {
    // An unusable lock path is not something to wait for: say what is wrong with
    // it instead of describing a writer that does not exist.
    if (claim.reason === "unusable") {
      throw new Error(`--run: the lock of run "${runId}" cannot be used. ${claim.detail}`);
    }
    const holder = runLockHolder(runDir);
    throw new Error(
      `--run: run "${runId}" is already held by another runner process${holder ? ` (pid ${holder})` : ""}.` +
        ` Wait for it to finish, or resume a different run.`,
    );
  }
  return {
    dir: runDir,
    strictSnapshot: {
      path: diagnostic.path,
      releaseRunLock: claim.acquired,
      expectedIdentity: { runId, pipeline: pipelineName, ticket },
    },
    // Without repointing, latest would still select the discarded run and the
    // next invocation without --run would start over. Commit after boot's final
    // read so a snapshot that disappears in that window cannot move `latest`.
    commit: () => pointLatestTo(pipelineDir, runDir),
    release: () => {
      if (claim.acquired) releaseRunDir(runDir);
    },
  };
}

/** Convenience wrapper for callers that need only the selected directory.
 * Entry boot uses `selectExplicitRun` so it can defer the `latest` update. */
export function resolveExplicitRunDir(
  pipelineName: string,
  ticket: string | undefined,
  runId: string,
  context?: PipelineContext,
): string {
  const selection = selectExplicitRun(pipelineName, ticket, runId, context);
  selection.commit();
  return selection.dir;
}

/**
 * Warn when latest has unfinished work but resume policy discards it. The verdict
 * comes from the same resumeDecision used by resolveRunDir, so the message cannot
 * contradict the actual decision.
 */
export function discardedResumeNotice(
  pipelineName: string,
  ticket: string | undefined,
  context?: PipelineContext,
): string | undefined {
  const latest = resolveLatestRunSnapshot(pipelineName, ticket, context);
  if (!latest) return undefined;
  const snapshot = latest.snapshot;
  const decision = resumeDecision(snapshot);
  if (decision.resume) return undefined;

  const remaining = pendingSteps(snapshot).length;
  // A discarded run with no pending step can still owe its verdict, and `--run`
  // accepts it: staying silent would leave the only way to reach it unadvertised.
  const owesVerdict = remaining === 0 && settledButUnfinalized(snapshot);
  if (remaining === 0 && !owesVerdict) return undefined;

  const runId = snapshot.runId;
  const cause =
    snapshot.aborted || snapshot.status === "ABORTED"
      ? "interrupted manually"
      : `status ${snapshot.status ?? "unknown"}`;
  const left = owesVerdict ? "its verdict was never stamped" : `${remaining} step(s) remained`;
  return (
    `Previous run ${runId} (${cause}) was skipped: this run starts from scratch although ${left}.` +
    ` To resume it where it stopped, rerun the same command with --run ${runId}`
  );
}
