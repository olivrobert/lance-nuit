// runner/boot/lock.ts
//
// Boot step lock: only one top-level runner may use a Git tree at a time, avoiding
// run-state clobbering and cross-run checkouts/commits. Dispatch children use the
// parent's lock, and stale locks are handled safely.
//
// Position in BOOT[]: after worktree setup, because the lock is keyed by cwd.

import { acquireRunnerLock, releaseRunnerLock, runnerLockPath, shouldSkipRunnerLock } from "../env/runlock.js";
import { log } from "../runtime/logging.js";
import type { BootState, BootStep } from "./boot-state.js";

export const lockStep: BootStep = {
  id: "lock",
  desc: "Acquire the project run lock (one top-level runner per Git tree).",
  applies: () => !shouldSkipRunnerLock(process.env),
  run(s: BootState): Partial<BootState> {
    const lock = acquireRunnerLock(process.cwd(), {
      pid: process.pid,
      ticket: s.args.ticket,
      pipeline: s.pipelinePath,
      startedAt: new Date().toISOString(),
    });
    if (!lock.ok) {
      if (lock.reclaiming) {
        // Transient: another runner holds the reclamation marker and is about to
        // publish its own lock, so there is nothing to wait for here.
        log.error(`Another runner (pid ${lock.reclaiming.pid}) is reclaiming the project run lock.`);
        log("  Retry in a moment.");
        process.exit(1);
      }
      const h = lock.holder;
      // Every field but the pid is optional in practice: a lock written by an
      // older build, or by a caller with a thinner payload, has no ticket and no
      // timestamp, and "started undefined" is worse than saying nothing.
      const since = h.startedAt ? `, started ${h.startedAt}` : "";
      log.error(
        `A runner is already active for this project (pid ${h.pid}${h.ticket ? `, ticket ${h.ticket}` : ""}${since}).`,
      );
      // A dead, corrupt or invalid holder is reclaimed automatically, so a refusal
      // means that runner is alive: removing the lock file by hand would put two
      // runners on the same git tree.
      log(`  Stop that runner or wait for it to finish (lock: ${runnerLockPath(process.cwd())}).`);
      process.exit(1);
    }
    // Side effects not represented by Partial<BootState>:
    // - selfSpawnRunner inherits RUNNER_LOCK_HELD, so children do not re-lock;
    // - the lock is released on exit. installChildKillHandlers converts
    //   SIGINT/SIGTERM into process.exit, which triggers this handler.
    process.env.RUNNER_LOCK_HELD = "1";
    process.on("exit", () => releaseRunnerLock(process.cwd()));
    return {};
  },
};
