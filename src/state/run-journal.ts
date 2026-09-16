// runner/state/run-journal.ts
//
// Canonical append-only run journal. `state.json` provides fast resume; this file
// keeps execution facts and attempts. The snapshot no longer holds the attempts:
// a resume projects them from here, and the child-start facts live here only.
//
// Writing is strict: `appendRunEvent` accepts only the payload the event type
// declares in `model/journal.ts`. Reading is tolerant line by line: `readRunEvents`
// hands the typed readers the contracted events, `readRunJournal` hands a
// diagnostic the complete envelope with its counters, and no line is ever
// discarded. Reading is NOT tolerant of a failing store: an absent journal reads
// as empty, any other read failure throws, so a resume or a child launch never
// mistakes an unreadable journal for a run that has not written yet.

import { isAbsolute, relative } from "node:path";
import type {
  JournalEntry,
  RunJournalCounts,
  RunJournalEvent,
  RunJournalEventType,
  RunJournalKnownEvent,
} from "../model/journal.js";
import type { Run } from "../model/run.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";

export type { JournalEntry, RunJournalCounts, RunJournalEvent } from "../model/journal.js";

export function relativeRunPath(runDir: string, path: string | null | undefined): string | null {
  if (!path) return null;
  const value = (isAbsolute(path) ? relative(runDir, path) : path).replaceAll("\\", "/");
  return value || ".";
}

/** Append a fact. A failed append must not interrupt the run: the store reports
 * the first failure once, and the run keeps its code progress. What is lost is
 * not observability only — the attempts and child-start facts of that window
 * are gone for a later resume. */
export type RunEventTarget = Pick<Run, "run_dir" | "runId" | "eventStore">;

/** Payload of one event type: the type's own fields, minus the identity
 *  `appendRunEvent` stamps itself. */
export type JournalInput<T extends RunJournalEventType> = Omit<
  Extract<RunJournalKnownEvent, { type: T }>,
  "ts" | "runId" | "type"
>;

export function appendRunEvent<T extends RunJournalEventType>(
  run: RunEventTarget,
  type: T,
  data: JournalInput<T>,
): void {
  try {
    // The payload is `JournalInput<T>` by construction, but TypeScript cannot
    // relate a generic spread to the matching member of the union.
    const event = {
      ts: new Date().toISOString(),
      type,
      ...(run.runId ? { runId: run.runId } : {}),
      ...data,
    } as unknown as RunJournalEvent;
    if (run.eventStore && run.runId) run.eventStore.append(run.runId, event);
    else new FileRunEventStore({ runDir: run.run_dir }).appendAt(run.run_dir, event);
  } catch {
    // Best effort by design: a failed append must not lose code progress.
  }
}

/**
 * Contracted events, in order.
 *
 * `unknown` and `invalid` entries are absent here, exactly as the projections
 * already ignored them through their own defensive guards: `events.jsonl` is also
 * the live feed, so most of a real journal is made of lines this contract does
 * not describe.
 *
 * Throws when the store cannot be read. The callers are a resume (attempts) and
 * a child launch (`pipeline.child.started`): an empty list there would restart
 * the numbering or start a second child under the same identity.
 */
export function readRunEvents(runDir: string): RunJournalEvent[];
export function readRunEvents(run: RunEventTarget): RunJournalEvent[];
export function readRunEvents(source: string | RunEventTarget): RunJournalEvent[] {
  if (typeof source !== "string" && source.eventStore && source.runId) {
    return source.eventStore.read(source.runId);
  }
  const runDir = typeof source === "string" ? source : source.run_dir;
  return new FileRunEventStore({ runDir }).readAt(runDir);
}

/** Complete read: every classified line plus the counters. What a diagnostic
 *  needs to see whether the schema, and not the producer, is what refused a
 *  line. */
export interface RunJournalReport extends RunJournalCounts {
  entries: JournalEntry[];
}

/** Throws when the store cannot be read, like `readRunEvents`; a diagnostic
 *  that wants to keep listing the other runs catches it itself. */
export function readRunJournal(runDir: string): RunJournalReport;
export function readRunJournal(run: RunEventTarget): RunJournalReport;
export function readRunJournal(source: string | RunEventTarget): RunJournalReport {
  if (typeof source !== "string" && source.eventStore?.readJournal && source.runId) {
    return source.eventStore.readJournal(source.runId);
  }
  const runDir = typeof source === "string" ? source : source.run_dir;
  return new FileRunEventStore({ runDir }).readJournalAt(runDir);
}
