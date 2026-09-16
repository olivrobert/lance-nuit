// runner/state/stores/run-storage.ts
//
// Run locations. Each work item has a diagnostic space separated by pipeline:
//
//   <ticket>/runs/<pipeline>/<runId>/state.json
//   <ticket>/runs/<pipeline>/latest -> <runId>

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { acquireLock, defaultIsAlive, heldByThisProcess, isLockPathError, releaseLock } from "../../env/lock.js";
import { DEFAULT_SPEC_PATH, resolveTicketDir } from "../../env/tickets.js";
import { errorMessage, isErrno } from "../../lib/errors.js";
import { isLogicalSegment } from "../../model/artifact-ports.js";
import type { PipelineContext } from "../../model/context.js";
import type { PersistedRun } from "../../model/persisted.js";
import { log } from "../../runtime/logging.js";
import { isPersistedRunComplete, isPersistedRunResumable } from "../run-predicates.js";
import {
  describeRunSnapshotProblem,
  readRunSnapshot,
  readRunSnapshotDiagnostic,
  type RunSnapshot,
  type RunSnapshotReader,
} from "../run-snapshot.js";

export { DEFAULT_SPEC_PATH } from "../../env/tickets.js";
export const RUNS_DIRECTORY = "runs";
export const STATE_FILE = "state.json";

function safePipelineName(name: string): string {
  if (!isLogicalSegment(name)) throw new Error(`Invalid pipeline name: ${name}`);
  return name;
}

/** Readable identity with explicit UTC, milliseconds, and collision-resistant suffix. */
export function createRunId(pipelineName: string, now = new Date(), uuid = randomUUID()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "");
  return `${stamp}-${safePipelineName(pipelineName)}-${uuid.replace(/-/g, "").slice(0, 6)}`;
}

export function baseRunsDir(ticket?: string, context?: PipelineContext): string {
  const specPath = context?.config.specPath ?? DEFAULT_SPEC_PATH;
  const root = context?.cwd ?? process.cwd();
  if (ticket) return join(root, specPath, resolveTicketDir(ticket, specPath, root), RUNS_DIRECTORY);
  return join(root, ".lance-nuit", RUNS_DIRECTORY);
}

export function pipelineRunsDir(pipelineName: string, ticket?: string, context?: PipelineContext): string {
  return join(baseRunsDir(ticket, context), safePipelineName(pipelineName));
}

/** Point `latest` at an existing run for explicit resume, so the next invocation
 * selects the resumed run rather than a discarded one. */
export function pointLatestTo(pipelineDir: string, runDir: string): void {
  updateLatestSymlink(pipelineDir, runDir);
}

function updateLatestSymlink(pipelineDir: string, target: string): void {
  const link = join(pipelineDir, "latest");
  // Atomic replacement: symlink to a temp name, then rename over `latest`.
  // An unlink+symlink pair would leave a window where concurrent readers see
  // no latest link and silently start a fresh run instead of resuming.
  const temporaryLink = join(pipelineDir, `.latest.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  symlinkSync(basename(target), temporaryLink);
  try {
    renameSync(temporaryLink, link);
  } catch (error) {
    try {
      unlinkSync(temporaryLink);
    } catch {
      // Temp link cleanup is best effort; preserve the original rename error.
    }
    throw error;
  }
}

/** Defensive parse: an unreadable snapshot is neither resumable nor complete. */
export function readRunFile(runFile: string): PersistedRun | null {
  return readRunSnapshot(runFile);
}

export function isResumable(runFile: string): boolean {
  return isPersistedRunResumable(readRunFile(runFile));
}

function statePath(dir: string): string {
  return join(dir, STATE_FILE);
}

const RUN_LOCK_FILE = "runner.lock";

// One policy for the three readers of `runner.lock` below, because they have to
// agree: a run directory is a candidate, not an obligation. An unreadable or
// unusable lock — corrupt payload, a directory or a socket at that path, denied
// permissions — never fails the invocation here. It only means "not adoptable":
// `readRunLock` and `runLockHolder` report no holder, `claimRunDir` refuses with
// a warning, and the caller starts a fresh run (`resolveRunDir`) or reports the
// run as held (`--run`). `acquireLock` stays strict for its own callers: on the
// project lock, where there is no fresh alternative, an unusable path is an error.

/** Payload of the run lock. `acquireLock` requires an object carrying `pid`. */
interface RunLockInfo {
  pid: number;
}

/** Lock payload, or `null` when nothing readable claims the directory. Accepts
 *  the bare-pid form written before this lock moved to the shared protocol, so a
 *  runner started by an older build stays visible instead of being reclaimed
 *  under its feet. */
function readRunLock(dir: string): RunLockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, RUN_LOCK_FILE), "utf-8"));
  } catch {
    // No lock file, an unreadable one, or a corrupt payload: treated as absent,
    // which is what the stale-lock protocol reclaims.
    return null;
  }
  const pid = typeof parsed === "number" ? parsed : (parsed as { pid?: unknown } | null)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/** pid of a LIVE foreign process holding the run lock, `null` otherwise (no
 *  lock, a stale lock, or our own). Read-only: it never claims. */
export function runLockHolder(dir: string): number | null {
  const holder = readRunLock(dir);
  if (!holder || holder.pid === process.pid) return null;
  return defaultIsAlive(holder.pid) ? holder.pid : null;
}

/** Single-writer guard for a run directory. Without it two runner processes can
 *  both resume the same run and interleave snapshot/journal writes. The lock is
 *  a pid marker: a dead holder is reclaimed, so no explicit release is needed.
 *
 *  Reclaiming a stale lock is the delicate part — a read, a liveness probe and a
 *  write are three syscalls, and two runners observing the same dead pid in that
 *  window would otherwise both win. `acquireLock` serializes the reclaim behind
 *  its own marker, and is the only pid lock in this file.
 *
 *  Exported because `--run` selects a run directory outside `resolveRunDir` and
 *  must take the same lock; an unlocked explicit resume is exactly the two-writer
 *  case this guard exists to prevent. */
export function tryClaimRunDir(dir: string): boolean {
  return claimRunDir(dir).ok;
}

/** Claim result. `acquired` records whether this invocation created the lock, so
 * a failed selection releases only the lock it took rather than a re-entrant one.
 * A refusal says why, because the two reasons call for different words: a live
 * writer is worth waiting for, an unusable lock path is not. */
export type RunDirClaim =
  | { ok: true; acquired: boolean }
  | { ok: false; acquired: false; reason: "held" }
  | { ok: false; acquired: false; reason: "unusable"; detail: string };

export function claimRunDir(dir: string): RunDirClaim {
  try {
    return claimRunDirStrict(dir);
  } catch (error) {
    // Policy above: an unusable run lock makes the directory unclaimable, not the
    // invocation fatal. The caller falls through to a fresh run, or reports that
    // this run cannot be resumed. Only environment failures are absorbed — a
    // programming error must still surface.
    if (!isLockPathError(error)) throw error;
    // The message already names the lock path, so the directory is not repeated.
    const detail = errorMessage(error);
    log.warn(`Not adopting run ${basename(dir)}: ${detail}`);
    return { ok: false, acquired: false, reason: "unusable", detail };
  }
}

function claimRunDirStrict(dir: string): RunDirClaim {
  const lockFile = join(dir, RUN_LOCK_FILE);
  // Re-entrance: `acquireLock` reads our own live pid as a foreign holder and
  // refuses, whereas re-claiming a directory we already own must succeed. The
  // test is pid *and* nonce (see lock.ts): a lock carrying our pid that we never
  // published belongs to a dead process whose pid we recycled, and treating it as
  // ours would leave the directory unclaimed for another runner to reclaim.
  if (heldByThisProcess(lockFile)) return { ok: true, acquired: false };
  const holder = readRunLock(dir);
  // A bare-pid lock is not a valid payload for `acquireLock`, which would reclaim
  // it even while its owner runs. Refusing here is a fast path only: a directory
  // that looks free still goes through the atomic claim below. Our own pid on a
  // lock that is not ours is stale by construction, so it is not probed.
  if (holder && holder.pid !== process.pid && defaultIsAlive(holder.pid)) {
    return { ok: false, acquired: false, reason: "held" };
  }
  if (!acquireLock<RunLockInfo>(lockFile, { pid: process.pid }).ok) {
    return { ok: false, acquired: false, reason: "held" };
  }
  return { ok: true, acquired: true };
}

/** Release a run lock only when this process still owns it. Best effort: this is
 * called while unwinding a failed selection, and a release that throws would
 * replace the real diagnosis with a filesystem error. */
export function releaseRunDir(dir: string): void {
  try {
    releaseLock(join(dir, RUN_LOCK_FILE));
  } catch (error) {
    log.warn(`Could not release the lock of run ${basename(dir)}: ${errorMessage(error)}`);
  }
}

export interface LatestRunSnapshot {
  link: string;
  runDir: string;
  snapshotPath: string;
  snapshot: RunSnapshot;
}

function selectedSnapshotError(
  diagnostic: Exclude<ReturnType<typeof readRunSnapshotDiagnostic>, { kind: "valid" }>,
): Error {
  return new Error(
    `Cannot resume selected snapshot ${diagnostic.path}: it ${describeRunSnapshotProblem(diagnostic)}. ` +
      `Inspect or restore the run files, or use --fresh to start a new run.`,
  );
}

/** Resolve the authoritative `latest` selector strictly. A missing link means
 * no run has been selected; a dangling link or damaged target is an error. */
export function resolveLatestRunSnapshot(
  pipelineName: string,
  ticket?: string,
  context?: PipelineContext,
  reader?: RunSnapshotReader,
): LatestRunSnapshot | null {
  const link = join(pipelineRunsDir(pipelineName, ticket, context), "latest");
  try {
    lstatSync(link);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw new Error(
      `Cannot inspect latest selector ${link}. Inspect the run files or use --fresh to start a new run.`,
      { cause: error },
    );
  }
  let runDir: string;
  try {
    runDir = realpathSync(link);
  } catch {
    throw new Error(
      `Latest selector ${link} is dangling. Inspect or restore the run files, or use --fresh to start a new run.`,
    );
  }
  const diagnostic = readRunSnapshotDiagnostic(statePath(runDir), reader);
  if (diagnostic.kind !== "valid") {
    throw selectedSnapshotError(diagnostic);
  }
  return { link, runDir, snapshotPath: diagnostic.path, snapshot: diagnostic.snapshot };
}

export interface RunDirResolution {
  dir: string;
  /** The returned directory was a selected existing snapshot and needs a final strict read. */
  selectedSnapshot: boolean;
  /** This selection created a lock that must be released if that final read fails. */
  acquiredRunLock: boolean;
}

/**
 * Would this invocation resume `latest` rather than create a new run?
 *
 * Read-only on purpose: the clean-tree guard needs the answer BEFORE any run
 * directory exists, and it must account for the run lock — a held lock makes
 * `resolveRunDir` start a fresh run, which is precisely the case where the guard
 * must apply.
 */
export function wouldResumeLatest(
  pipelineName: string,
  ticket?: string,
  fresh?: boolean,
  context?: PipelineContext,
): boolean {
  if (fresh) return false;
  const latest = resolveLatestRunSnapshot(pipelineName, ticket, context);
  return !!latest && isPersistedRunResumable(latest.snapshot) && runLockHolder(latest.runDir) === null;
}

export function resolveRunDir(
  pipelineName: string,
  ticket?: string,
  explicitRunDir?: string,
  fresh?: boolean,
  context?: PipelineContext,
): string {
  return resolveRunDirSelection(pipelineName, ticket, explicitRunDir, fresh, context).dir;
}

/** Select a directory and retain enough ownership information for boot to
 * reject a disappearing snapshot without leaking a newly-acquired lock. */
export function resolveRunDirSelection(
  pipelineName: string,
  ticket?: string,
  explicitRunDir?: string,
  fresh?: boolean,
  context?: PipelineContext,
): RunDirResolution {
  if (explicitRunDir) {
    mkdirSync(explicitRunDir, { recursive: true });
    return { dir: explicitRunDir, selectedSnapshot: false, acquiredRunLock: false };
  }

  const pipelineDir = pipelineRunsDir(pipelineName, ticket, context);
  mkdirSync(pipelineDir, { recursive: true });
  if (!fresh) {
    const latest = resolveLatestRunSnapshot(pipelineName, ticket, context);
    if (latest) {
      // Only adopt a resumable run if no live process already owns it;
      // otherwise fall through and create a fresh run directory.
      if (isPersistedRunResumable(latest.snapshot)) {
        const claim = claimRunDir(latest.runDir);
        if (claim.ok) return { dir: latest.runDir, selectedSnapshot: true, acquiredRunLock: claim.acquired };
        // Silently starting over here looks like a lost run: the work is intact
        // in the held directory, and this invocation is simply not the writer. An
        // unusable lock path has already been reported by `claimRunDir`.
        if (claim.reason === "held") {
          const holder = runLockHolder(latest.runDir);
          log.warn(
            `Run ${basename(latest.runDir)} is held by another runner process${holder ? ` (pid ${holder})` : ""}:` +
              ` starting a new run instead of resuming it.`,
          );
        } else {
          log.warn(`Starting a new run instead of resuming ${basename(latest.runDir)}.`);
        }
      }
    }
  }

  const rootRunId = createRunId(pipelineName);
  let runId = rootRunId;
  let collision = 1;
  while (existsSync(join(pipelineDir, runId))) {
    runId = `${rootRunId}-${collision++}`;
  }
  const dir = join(pipelineDir, runId);
  mkdirSync(dir, { recursive: true });
  claimRunDir(dir);
  updateLatestSymlink(pipelineDir, dir);
  return { dir, selectedSnapshot: false, acquiredRunLock: false };
}

/** Run snapshot, always `state.json` regardless of pipeline name. */
export function runPath(_pipelineName: string, dir: string): string {
  return statePath(dir);
}

/** Snapshot path for the latest run of this pipeline and ticket. */
export function latestRunFile(pipelineName: string, ticket?: string, context?: PipelineContext): string | null {
  const latestLink = join(pipelineRunsDir(pipelineName, ticket, context), "latest");
  if (!existsSync(latestLink)) return null;
  try {
    return statePath(realpathSync(latestLink));
  } catch {
    // A missing or broken latest link has no usable snapshot to report.
    return null;
  }
}

/** PASS runs are complete; interrupted, failed, and running runs are not. */
export function isRunComplete(runFile: string | null): boolean {
  return runFile ? isPersistedRunComplete(readRunFile(runFile)) : false;
}
