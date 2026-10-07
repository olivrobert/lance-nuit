// runner/entry/signals.ts
//
// Signal handling for the entry point. Extracted from `runner.ts` so the
// orchestration in `main()` reads as a sequence of phases rather than as
// bookkeeping interleaved with a 70-line handler.

import { forceKillAllChildren, killAllChildren, shutdownAllChildren } from "../exec/process-supervision.js";
import { errorMessage } from "../lib/errors.js";
import type { Run } from "../model/run.js";
import type { AbortScope } from "../runtime/abort.js";
import { liveAttemptCost, liveAttemptModel } from "../runtime/live-cost.js";
import { log } from "../runtime/logging.js";
import { emitRunStats } from "../state/stats/run-stats.js";
import { abortRun } from "../state/run-transitions.js";
import { NO_STACK_STOP, type StackStop } from "./stack-stop.js";

/**
 * Install child-tree killing for Ctrl+C / SIGTERM / exit.
 *
 * This is unconditional and outside the lock: sub-runners skip the lock but also
 * spawn `claude`. Without this handler, SIGTERM could orphan a detached agent
 * that keeps writing to the repository with bypassPermissions after the runner
 * dies, consuming budget.
 *
 * `abort` is the scope every loop of this process executes under: the request
 * recorded here is what stops in-process child runs, which never receive
 * `run.aborted` themselves. `getActiveRun` covers the root run before its step
 * loop registered it on the scope (admission, preflight).
 *
 * `getStackStop` is read on every signal because the stop only exists once
 * startup returns a run. An interruption during the steps waits for it before
 * exiting. A signal while it already runs neither kills the hook nor exits: the
 * run is reported by then, and the entry point exits with its own code. Only a
 * second signal skips the hook.
 */
export function installChildKillHandlers(
  abort: AbortScope,
  getActiveRun: () => Run | undefined,
  getStackStop: () => StackStop = () => NO_STACK_STOP,
): void {
  // `exit` cannot await a promise; this synchronous fallback immediately kills
  // groups that are still visible.
  process.on("exit", () => killAllChildren("SIGKILL"));
  let shutdownPromise: Promise<void> | undefined;
  let abortPersisted = false;
  // A stop started after the report never sets `shutdownPromise`, so its
  // signals need their own count.
  let signalsDuringStop = 0;

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      const stackStop = getStackStop();
      if (stackStop.inProgress()) {
        signalsDuringStop += 1;
        // After an interruption the user already pressed Ctrl+C once: this one
        // is the second, so it skips at once.
        if (signalsDuringStop > 1 || shutdownPromise) stackStop.skip();
        else log.warn("stopping project services — press Ctrl+C again to skip");
        return;
      }

      // The handler is synchronous from the orchestrator's perspective: any loop
      // or rerun that resumes after child termination sees this flag before a new
      // spawn or failure persistence.
      const exitCode = sig === "SIGINT" ? 130 : 143;
      abort.requestAbort(sig);
      process.exitCode = exitCode;
      if (!abortPersisted) {
        abortPersisted = true;
        const run = getActiveRun();
        // Admission and preflight run before a step transitions to `running`.
        // Persist the interruption for every unfinished active run, otherwise a
        // signal during those awaits leaves a misleading RUNNING/pending snapshot.
        const candidates = [...abort.activeRuns(), ...(run ? [run] : [])];
        const uniqueRuns = [...new Set(candidates)];
        if (uniqueRuns.length > 0) {
          // Persist run bookkeeping before stopping children. A second signal must
          // not write a second abort event or duplicate statistics.
          try {
            for (const active of uniqueRuns) {
              if (active.status === "PASS" || active.status === "STOPPED" || active.status === "ABORTED") continue;
              // Only the leaf with an active attempt receives the process-wide
              // live estimate. Parent orchestration nodes have no attempt of
              // their own and must not duplicate their child's spend.
              abortRun(active, sig, { estimatedCostUsd: liveAttemptCost(), model: liveAttemptModel() });
              if (active === run) emitRunStats(active, { projRoot: process.cwd() });
            }
          } catch (error) {
            log.warn(`Unable to persist abort: ${errorMessage(error)}`);
          }
        }
      }

      // A second signal during the grace period escalates immediately without
      // creating another promise or competing exit.
      if (shutdownPromise) {
        forceKillAllChildren();
        // The stop hook lives in its own scope, out of reach of the line above.
        stackStop.skip();
        return;
      }

      shutdownPromise = shutdownAllChildren().then(() => stackStop.run());
      void shutdownPromise.then(
        () => process.exit(exitCode),
        () => process.exit(exitCode),
      );
    });
  }
}
