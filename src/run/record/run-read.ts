//
// How code outside the run record reads a run: the snapshot, and the status a
// reader shows (`effectiveStatus`, asked with `isRunHeld`). Every reader — the
// dashboard, `--inspect`, `close`, the dispatch loop — takes the run from here.
// Statuses, attempts, sessions, spend and children come from `state.json` alone;
// the journal is read for display only (`readRunHistory.events`), and the
// activity of a live run from the tail of its feed (`lastFeedEvent`).

import { join } from "node:path";
import type { PipelineContext } from "../../shared/language/context.js";
import type { RawJournalEvent, RunJournalEvent, RunJournalKnownEvent } from "../journal.js";
import type { PersistedAttempt, PersistedRun } from "../persisted.js";
import type { RunStateSnapshot } from "../storage-ports.js";
import { readRunEvents } from "./run-journal.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { type EffectiveRunStatus, effectiveStatus } from "./run-status.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { isRunHeld, latestRunDir, type RunsLocation, runsLocationOf, STATE_FILE } from "./stores/run-storage.js";

/** A run as every reader sees it. */
export interface RunRead {
  readonly runDir: string;
  readonly state: PersistedRun;
  readonly status: EffectiveRunStatus;
  /** No verdict and no live holder: the runner died. `status` is then `ABORTED`. */
  readonly interrupted: boolean;
}

/** `holder` is where the runs live, to ask who holds this one; `null` when no
 *  process can (a snapshot listed without its directory). */
function runReadOf(runDir: string, snapshot: PersistedRun, holder: RunsLocation | null): RunRead {
  const { status, interrupted } = effectiveStatus(
    snapshot,
    () => holder !== null && isRunHeld(runDir, snapshot, holder),
  );
  return { runDir, state: snapshot, status, interrupted };
}

/** The run in `runDir`, or `null` when its snapshot is missing, corrupt or of
 *  another format. `location` is where the project keeps its runs: a composed
 *  child is held by the run that composed it, found from there. */
export function readRun(runDir: string, location: RunsLocation): RunRead | null {
  const snapshot = readRunSnapshot(join(runDir, STATE_FILE));
  return snapshot ? runReadOf(runDir, snapshot, location) : null;
}

/** The run `latest` points at for `pipeline` and `ticket`, or `null`. */
export function readLatestRun(pipeline: string, ticket?: string, context?: PipelineContext): RunRead | null {
  const runDir = latestRunDir(pipeline, ticket, context);
  return runDir ? readRun(runDir, runsLocationOf(context)) : null;
}

/** A run a store listed (`RunStateStore.listSnapshots`), read like `readRun`. A
 *  snapshot listed without its directory has no lock to ask. */
export function readListedRun(listed: RunStateSnapshot, location: RunsLocation): RunRead {
  const runDir = listed.runDir ?? "";
  return runReadOf(runDir, listed.state, runDir === "" ? null : location);
}

/** The attempts of a run, from its snapshot, and its journal for display. */
export interface RunHistory {
  /** Attempts of every step, from `state.json`. */
  attempts: ReadonlyMap<string, PersistedAttempt[]>;
  /** Contracted events, in journal order; empty when the journal is absent or
   *  unreadable. A timeline only. */
  events: readonly RunJournalEvent[];
}

/** Attempts of `state` and the journal events of the run in `runDir`. */
export function readRunHistory(runDir: string, state: PersistedRun): RunHistory {
  const attempts = new Map(state.steps.map((step) => [step.id, step.attempts ?? []]));
  return { attempts, events: readRunEvents(runDir) };
}

/** The last line of the run's feed (`feed.jsonl`), read from a bounded tail: its
 *  lines say what a live run is doing. `undefined` when the feed is absent,
 *  empty, or holds no parsable line. */
export function lastFeedEvent(runDir: string, maxBytes: number): RawJournalEvent | RunJournalKnownEvent | undefined {
  return new FileRunEventStore().readTailAt(runDir, { maxBytes, feed: true }).entries.at(-1)?.event;
}
