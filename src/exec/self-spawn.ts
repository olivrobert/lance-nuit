// runner/exec/self-spawn.ts
//
// Relaunch the runner itself (sub-US, commit, finalize, scan). The child reuses the
// current interpreter, so it runs on the same runtime as its parent — Bun for an
// ordinary installation, which loads the TypeScript entry point without a loader.
// process.argv[1] remains the source of truth for the runner path (global and
// unaffected by moving this code).
//
// Lives in exec/ rather than dispatch/: this is not a strategy but an asynchronous
// spawn helper. The child remains in the parent's group (not `detached`), so the
// terminal can still pass Ctrl+C and supervision can stop it while the parent waits.

import { spawnSupervisedProcess } from "./process-runner.js";

/** Environment set on every child launched by a dispatch strategy to avoid recursion. */
export const DISPATCH_CHILD_ENV = {
  RUNNER_DISABLE_DISPATCH: "1",
} as const;

export interface SelfSpawnOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function selfSpawnRunner(
  args: string[],
  extraEnv: Record<string, string> = {},
  options: SelfSpawnOptions = {},
): Promise<number> {
  // The interpreter that reached this line can already load the entry point, so
  // reusing it needs no lookup and no loader flag.
  const cmd = process.execPath;
  const cmdArgs = [process.argv[1], ...args];
  const env = { ...process.env, ...extraEnv };
  delete env.RUNNER_LIVE_FEED;
  const supervised = spawnSupervisedProcess(cmd, cmdArgs, {
    stdio: "inherit",
    env,
    detached: false,
    // spawnSync had no timeout; null disables the supervision default while letting
    // the caller provide an explicit timeout.
    timeoutMs: options.timeoutMs ?? null,
    signal: options.signal,
  });

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = async (code: number | null): Promise<void> => {
      if (settled) return;
      settled = true;
      if (supervised.killed) await supervised.waitForKill();
      supervised.clear();
      resolve(supervised.killed ? 124 : (code ?? 1));
    };
    supervised.child.once("error", () => {
      void finish(null);
    });
    supervised.child.once("close", (code) => {
      void finish(code);
    });
  });
}
