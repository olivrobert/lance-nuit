// runtime/abort.ts
//
// Abort scope: the interruption state one execution tree shares. The
// SIGINT/SIGTERM handler sets `run.aborted` on the runs it can reach at that
// instant; a child pipeline run executed in-process that is still booting, or
// one whose abort could not be persisted, never sees it, and its fix/rerun loops
// could spawn fresh agents during the shutdown grace period. Every loop
// therefore consults the scope in addition to its own run's `aborted`.
//
// The scope is an explicit object, not module state: `entry/` creates one per
// process, the signal handler requests the abort on it, the step loop registers
// the runs it executes on it, and a composed child executes under its parent's
// scope. Two scopes never observe each other, which is what lets a test drive
// an interruption in-process without poisoning the next test (Bun shares module
// state across test files).

import type { Run } from "../model/run.js";

/** Named apart from the platform `AbortSignal`, which is unrelated. */
export type AbortRequestSignal = "SIGINT" | "SIGTERM";

export interface AbortScope {
  /** Record that the process received an abort signal. The first signal wins. */
  requestAbort(signal?: AbortRequestSignal): void;
  isAbortRequested(): boolean;
  /** The signal that requested the abort, if any. */
  requestedSignal(): AbortRequestSignal | undefined;
  /** A run is aborted if its own flag is set (root run) or the scope received an
   *  abort request (covers in-process child pipeline runs). */
  isRunAborted(run: { aborted?: boolean }): boolean;
  /** Register a run executing steps in this scope; returns its unregister. */
  registerActiveRun(run: Run): () => void;
  /** Runs currently executing steps, innermost first: nested pipelines are
   *  registered last and must be persisted first on shutdown. */
  activeRuns(): Run[];
}

/** A fresh scope: nothing requested, no active run. */
export function createAbortScope(): AbortScope {
  let requested = false;
  let signal: AbortRequestSignal | undefined;
  const runs = new Set<Run>();
  return {
    requestAbort(received) {
      requested = true;
      signal ??= received;
    },
    isAbortRequested: () => requested,
    requestedSignal: () => signal,
    isRunAborted: (run) => !!run.aborted || requested,
    registerActiveRun(run) {
      runs.add(run);
      return () => runs.delete(run);
    },
    activeRuns: () => [...runs].reverse(),
  };
}
