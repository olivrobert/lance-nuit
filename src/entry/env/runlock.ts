// Execution lock per project cwd: prevents concurrent runners from clobbering the
// same run JSON and, more importantly, from interfering on the shared git tree
// (scan checkout, fix/ branches, sub-US commits).
// Stale-safe via lock.ts (dead pid or corrupted lock → reclaim).
//
// Scan children do NOT acquire the lock: `RUNNER_STATE_ENV.lockHeld` is set by the
// parent that already owns the shared git tree.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runnerLockPath } from "../../shared/env/kit-layout.js";
import { RUNNER_STATE_ENV } from "../../shared/env/runner-env.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { log } from "../../shared/runtime/logging.js";
import { acquireLock, type LivenessProbe, type LockAcquireResult, releaseLock } from "../../shared/env/lock.js";

export interface RunnerLockInfo {
  pid: number;
  ticket?: string;
  pipeline?: string;
  startedAt: string;
}

export function acquireRunnerLock(
  cwd: string,
  info: RunnerLockInfo,
  isAlive?: LivenessProbe,
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
  return env[RUNNER_STATE_ENV.lockHeld] === "1";
}
