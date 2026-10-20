// runner/run-record/run-read.ts
//
// How code outside the run record reads a run: the snapshot, its steps reconciled
// with the journal by the projection a resume applies (`projectRunState`), and
// the status a reader shows (`effectiveStatus`, asked with `isRunHeld`). Every
// reader — the dashboard, `--inspect`, `close`, the dispatch loop — takes the run
// from here, so a step the journal knows finished reads finished everywhere, and
// none of them recomposes the projection with its own choice of what to read.
//
// The whole journal is read only when it can say more than the snapshot. The
// snapshot is written right after each event, so it can be behind its journal
// only when the runner died in between: a run is projected when it is
// interrupted (no verdict, nobody holds it) and still has a step that owes work
// (`owesWork`: pending, running, failed or aborted). That is wider than the steps
// a journal event can move (pending or running), never narrower. A run a live
// runner holds is at most one write behind, and a verdict is written after every
// event of the pass that reached it. That keeps the dashboard's poll, the costs page and the
// dispatch loop from parsing the journal of every run they list.
//
// Attempts are not in the snapshot at all: `readRunHistory` projects them, with
// the contracted events, for the readers that open a step or the run's timeline.

import { dirname, join } from "node:path";
import type { PipelineContext } from "../model/context.js";
import type { RawJournalEvent, RunJournalEvent, RunJournalKnownEvent } from "../model/journal.js";
import type { PersistedAttempt, PersistedRun, PersistedStepState } from "../model/persisted.js";
import type { RunStateSnapshot } from "../model/storage-ports.js";
import { projectStepAttempts } from "./attempt-projection.js";
import { owesWork } from "./run-predicates.js";
import { readRunEvents } from "./run-journal.js";
import { projectRunState } from "./run-projection.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { type EffectiveRunStatus, effectiveStatus } from "./run-status.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { isRunHeld, latestRunFile, type RunsLocation, runsLocationOf, STATE_FILE } from "./stores/run-storage.js";

/** A run as every reader sees it. */
export interface RunRead {
  readonly runDir: string;
  /** The snapshot, its steps reconciled with the journal when the runner died
   *  before writing what the journal already holds. */
  readonly state: PersistedRun;
  readonly status: EffectiveRunStatus;
  /** No verdict and no live holder: the runner died. `status` is then `ABORTED`. */
  readonly interrupted: boolean;
}

/** The steps a resume would start from, read from the journal only when it can
 *  differ from the snapshot (see the header). An unreadable journal costs the
 *  reconciliation, not the read: the snapshot is still what the runner last
 *  persisted. */
function projectedSteps(runDir: string, snapshot: PersistedRun, interrupted: boolean): PersistedStepState[] {
  if (!interrupted || !snapshot.steps.some((step) => owesWork(step.status))) return snapshot.steps;
  let events: RunJournalEvent[];
  try {
    events = readRunEvents(runDir);
  } catch {
    return snapshot.steps;
  }
  const projected = projectRunState(snapshot, events);
  // Steps the journal alone knows are left out: a reader shows the pipeline the
  // snapshot describes.
  return snapshot.steps.map((step) => projected.steps.get(step.id)?.state ?? step);
}

/** `holder` is where the runs live, to ask who holds this one; `null` when no
 *  process can (a snapshot listed without its directory). */
function runReadOf(runDir: string, snapshot: PersistedRun, holder: RunsLocation | null): RunRead {
  const { status, interrupted } = effectiveStatus(
    snapshot,
    () => holder !== null && isRunHeld(runDir, snapshot, holder),
  );
  const steps = runDir === "" ? snapshot.steps : projectedSteps(runDir, snapshot, interrupted);
  return { runDir, state: steps === snapshot.steps ? snapshot : { ...snapshot, steps }, status, interrupted };
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
  const file = latestRunFile(pipeline, ticket, context);
  return file ? readRun(dirname(file), runsLocationOf(context)) : null;
}

/** A run a store listed (`RunStateStore.listSnapshots`), read like `readRun`. A
 *  snapshot listed without its directory has no journal and no lock to ask. */
export function readListedRun(listed: RunStateSnapshot, location: RunsLocation): RunRead {
  const runDir = listed.runDir ?? "";
  return runReadOf(runDir, listed.state, runDir === "" ? null : location);
}

/** What the journal alone records of a run. */
export interface RunHistory {
  /** Attempts of every step, numbered as a resume numbers them. */
  attempts: ReadonlyMap<string, PersistedAttempt[]>;
  /** Contracted events, in journal order. */
  events: readonly RunJournalEvent[];
}

/** Attempts and events of the run in `runDir`, from the whole journal. Throws
 *  when the journal cannot be read: an absent journal is empty, an unreadable
 *  one is not, and each caller decides what it costs. */
export function readRunHistory(runDir: string): RunHistory {
  const events = readRunEvents(runDir);
  return { attempts: projectStepAttempts(events), events };
}

/** The last line of the journal, contracted or not, read from a bounded tail:
 *  the journal is also the live feed, whose lines say what a live run is doing.
 *  `undefined` when the journal is absent, empty, or holds no parsable line. */
export function lastJournalEvent(runDir: string, maxBytes: number): RawJournalEvent | RunJournalKnownEvent | undefined {
  return new FileRunEventStore().readTailAt(runDir, { maxBytes }).entries.at(-1)?.event;
}
