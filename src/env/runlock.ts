// runner/env/runlock.ts
// Execution lock per project cwd: prevents concurrent runners from clobbering the
// same run JSON and, more importantly, from interfering on the shared git tree
// (scan checkout, fix/ branches, sub-US commits).
// Stale-safe via lock.ts (dead pid or corrupted lock → reclaim).
//
// Multi-US/scan children do NOT acquire the lock: RUNNER_LOCK_HELD is set by the
// parent that already owns the shared git tree.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../lib/errors.js";
import { log } from "../runtime/logging.js";
import { acquireLock, type LockAcquireResult, releaseLock } from "./lock.js";

export interface RunnerLockInfo {
  pid: number;
  ticket?: string;
  pipeline?: string;
  startedAt: string;
}

export function runnerLockPath(cwd: string): string {
  return join(cwd, ".lance-nuit", "run", "runner.lock");
}

export function acquireRunnerLock(
  cwd: string,
  info: RunnerLockInfo,
  isAlive?: (pid: number) => boolean,
): LockAcquireResult<RunnerLockInfo> {
  const lockFile = runnerLockPath(cwd);
  mkdirSync(dirname(lockFile), { recursive: true });
  return acquireLock(lockFile, info, isAlive);
}

/** Release only when the lock still belongs to `ownerPid` (see lock.ts).
 *
 * Best effort on purpose: this runs from an exit handler, after the run has been
 * reported. A lock path that turned unusable mid-run is worth a warning, never a
 * failed exit code on a successful run — and never a stack trace printed after
 * the summary. */
export function releaseRunnerLock(cwd: string, ownerPid: number = process.pid): void {
  try {
    releaseLock(runnerLockPath(cwd), ownerPid);
  } catch (error) {
    log.warn(`Could not release the project run lock: ${errorMessage(error)}`);
  }
}

/** Whether this process is a child runner: the lock is already held upstream. */
export function shouldSkipRunnerLock(env: Record<string, string | undefined>): boolean {
  return env.RUNNER_LOCK_HELD === "1";
}
