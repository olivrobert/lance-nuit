//
// Append-only run journal: a trace of the contract events, written after the
// snapshot each transition saves. No execution decision reads it — resume,
// numbering, spend and child identity come from `state.json` alone.
//
// Writing is strict: `appendRunEvent` accepts only the payload the event type
// declares in `run/journal.ts`. Reading is tolerant: `readRunEvents` hands the
// display readers the contracted events, `readRunJournal` hands a diagnostic the
// complete envelope with its counters, and an absent or unreadable journal reads
// as empty.

import { isAbsolute, relative } from "node:path";
import type {
  JournalEntry,
  RunJournalCounts,
  RunJournalEvent,
  RunJournalEventType,
  RunJournalKnownEvent,
} from "../journal.js";
import type { Run } from "./run.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";

export type { JournalEntry, RunJournalCounts, RunJournalEvent } from "../journal.js";

export function relativeRunPath(runDir: string, path: string | null | undefined): string | null {
  if (!path) return null;
  const value = (isAbsolute(path) ? relative(runDir, path) : path).replaceAll("\\", "/");
  return value || ".";
}

/** Append a fact. A failed append must not interrupt the run: the store reports
 * the first failure once, and the snapshot already holds the transition. */
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

/** Contracted events, in order; `unknown` and `invalid` entries are left out. */
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

export function readRunJournal(runDir: string): RunJournalReport;
export function readRunJournal(run: RunEventTarget): RunJournalReport;
export function readRunJournal(source: string | RunEventTarget): RunJournalReport {
  if (typeof source !== "string" && source.eventStore?.readJournal && source.runId) {
    return source.eventStore.readJournal(source.runId);
  }
  const runDir = typeof source === "string" ? source : source.run_dir;
  return new FileRunEventStore({ runDir }).readJournalAt(runDir);
}
