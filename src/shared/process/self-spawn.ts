//
// Relaunch the runner itself (a dispatch child). The child reuses the current
// interpreter, so it runs on the same runtime as its parent — Bun for an ordinary
// installation, which loads the TypeScript entry point without a loader.
// process.argv[1] remains the source of truth for the runner path (global and
// unaffected by moving this code).
//
// The child remains in the parent's group (not `detached`), so the terminal can
// still pass Ctrl+C and supervision can stop it while the parent waits.

import { KILLED_BY_POLICY_STATUS, killedByPolicy, spawnSupervisedProcess } from "./process-runner.js";

export async function selfSpawnRunner(args: string[]): Promise<number> {
  // The interpreter that reached this line can already load the entry point, so
  // reusing it needs no lookup and no loader flag.
  const supervised = spawnSupervisedProcess(process.execPath, [process.argv[1]!, ...args], {
    stdio: "inherit",
    detached: false,
    // The child runs a whole pipeline; its own steps carry the deadlines.
    timeoutMs: null,
    // The only child that holds the parent's lock, worktree and feed.
    inheritRunnerState: true,
  });
  const end = await supervised.settle();
  return killedByPolicy(end.kill) ? KILLED_BY_POLICY_STATUS : (end.code ?? 1);
}
