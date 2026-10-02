// runner/entry/stack-stop.ts
//
// Stop the worktree's project services when a run ends without PASS, through
// the optional `worktree-stop.sh` hook. Resume starts them again through the
// boot path (stack preflight, then `worktree-ready.sh`).
//
// Only the process that entered the worktree owns its stack: sub-runners
// inherit `RUNNER_IN_WORKTREE=1`, and a failing child pipeline must not stop
// the services its parent is still using.
//
// The hook gets its own process scope. The signal handler sweeps the default
// scope on the first Ctrl+C, which would kill a half-done `docker compose stop`;
// here only `skip()` (a further signal) kills it. The stop also waits for the
// run's children to be gone first, so services never stop under a live agent.

import { runStopHookAsync, type WorktreeSpec } from "../env/worktree.js";
import { ProcessScope, shutdownAllChildren } from "../exec/process-supervision.js";
import { errorMessage } from "../lib/errors.js";
import type { RunStatus } from "../model/persisted.js";
import { log } from "../runtime/logging.js";

export interface StackStop {
  /** Run the stop once per process. Never rejects; later calls share the first. */
  run(): Promise<void>;
  /** True from the first `run()` until it settles. */
  inProgress(): boolean;
  /** Force-kill a hook in flight. */
  skip(): void;
}

export const NO_STACK_STOP: StackStop = {
  run: () => Promise.resolve(),
  inProgress: () => false,
  skip: () => {},
};

export interface StackStopDeps {
  shutdown: () => Promise<void>;
  runHook: (spec: WorktreeSpec, scope: ProcessScope) => Promise<void>;
}

/** `spec` is the worktree this process entered; without one, nothing to stop. */
export function createStackStop(
  spec: WorktreeSpec | undefined,
  deps: StackStopDeps = { shutdown: shutdownAllChildren, runHook: runStopHookAsync },
): StackStop {
  if (!spec) return NO_STACK_STOP;
  const scope = new ProcessScope();
  let pending: Promise<void> | undefined;
  let running = false;

  return {
    run() {
      if (pending) return pending;
      running = true;
      pending = (async () => {
        try {
          await deps.shutdown();
          await deps.runHook(spec, scope);
        } catch (error) {
          log.warn(`${errorMessage(error)}\n  the run's outcome is unchanged`);
        } finally {
          running = false;
        }
      })();
      return pending;
    },
    inProgress: () => running,
    skip: () => scope.forceKillAll(),
  };
}

/** Every status but PASS stops the stack: a PASS work item may still get review fixes. */
export function stopsStack(status: RunStatus | undefined): boolean {
  return status !== "PASS";
}
