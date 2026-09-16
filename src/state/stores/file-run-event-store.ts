import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isErrno } from "../../lib/errors.js";
import type { JournalEntry, RunJournalCounts, RunJournalEvent } from "../../model/journal.js";
import type { RunEventPage, RunEventStore } from "../../model/storage-ports.js";
import { parseJournalEntry } from "../journal-schema.js";

export type { RunEventPage } from "../../model/storage-ports.js";

export interface FileRunEventStoreOptions {
  runDir?: string;
  runDirs?: Map<string, string>;
}

/** Default read window: bounds memory use when an external reader scans a large journal. */
export const DEFAULT_EVENT_PAGE_BYTES = 512 * 1024;

export interface RunEventPageOptions {
  /** Maximum number of bytes read at once. */
  maxBytes?: number;
}

function emptyPage(offset: number, size = 0): RunEventPage {
  return { events: [], entries: [], nextOffset: offset, size, eof: true, skipped: 0, invalid: 0, unknown: 0 };
}

/** Journal lines classified by `parseJournalEntry`, with the counters. A line
 *  that is not an event at all is `skipped`, as it already was when only invalid
 *  JSON could be skipped. */
interface ClassifiedLines extends RunJournalCounts {
  events: RunJournalEvent[];
  entries: JournalEntry[];
}

function classify(text: string): ClassifiedLines {
  const events: RunJournalEvent[] = [];
  const entries: JournalEntry[] = [];
  let skipped = 0;
  let invalid = 0;
  let unknown = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // A crash mid-append leaves one truncated trailing line; the remainder of
      // the append-only log is still valid and must survive the resume — losing
      // it would restart attempt numbering and overwrite prior logs.
      skipped += 1;
      continue;
    }
    const entry = parseJournalEntry(raw);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    entries.push(entry);
    if (entry.kind === "known") events.push(entry.event);
    else if (entry.kind === "invalid") invalid += 1;
    else unknown += 1;
  }
  return { events, entries, skipped, invalid, unknown };
}

/** Split a buffer on COMPLETE lines. UTF-8 continuation bytes never contain `\n` (0x0A). */
function parseCompleteLines(buffer: Buffer): ClassifiedLines & { consumed: number } {
  const lastBreak = buffer.lastIndexOf(0x0a);
  if (lastBreak < 0) return { events: [], entries: [], consumed: 0, skipped: 0, invalid: 0, unknown: 0 };
  return { ...classify(buffer.subarray(0, lastBreak).toString("utf-8")), consumed: lastBreak + 1 };
}

export const EVENTS_FILE = "events.jsonl";
export function runEventsFilePath(runDir: string): string {
  return join(runDir, EVENTS_FILE);
}

export class FileRunEventStore implements RunEventStore {
  private readonly runDir?: string;

  private readonly runDirs?: Map<string, string>;

  private appendFailureReported = false;

  constructor({ runDir, runDirs }: FileRunEventStoreOptions = {}) {
    this.runDir = runDir;
    this.runDirs = runDirs;
  }

  append(runId: string, event: RunJournalEvent): void {
    const runDir = this.resolveRunDir(runId);
    if (runDir) this.appendAt(runDir, event);
  }

  read(runId: string): RunJournalEvent[] {
    const runDir = this.resolveRunDir(runId);
    return runDir ? this.readAt(runDir) : [];
  }

  appendAt(runDir: string, event: RunJournalEvent): void {
    try {
      mkdirSync(runDir, { recursive: true });
      appendFileSync(this.pathFor(runDir), `${JSON.stringify(event)}\n`, { encoding: "utf-8" });
    } catch (error) {
      // Best effort by design: an observability failure must not lose code progress.
      // But a persistently failing journal (disk full, permissions) silently breaks
      // attempt numbering on resume, so surface the first failure once.
      if (!this.appendFailureReported) {
        this.appendFailureReported = true;
        const message = errorMessage(error);
        console.error(
          `[pipeline] WARNING: run journal append failed (${message}); attempt numbering may be unreliable on resume.`,
        );
      }
    }
  }

  readAt(runDir: string): RunJournalEvent[] {
    return this.classifyAt(runDir).events;
  }

  readJournal(runId: string): RunJournalCounts & { entries: JournalEntry[] } {
    const runDir = this.resolveRunDir(runId);
    return runDir ? this.readJournalAt(runDir) : { entries: [], skipped: 0, invalid: 0, unknown: 0 };
  }

  /** Every classified line of the journal plus the counters: what tells a
   *  too-strict schema from a producer bug. */
  readJournalAt(runDir: string): RunJournalCounts & { entries: JournalEntry[] } {
    const { entries, skipped, invalid, unknown } = this.classifyAt(runDir);
    return { entries, skipped, invalid, unknown };
  }

  /** An absent journal is a run that has not written yet: empty. Any other
   *  failure (permissions, I/O, a directory in place of the file) propagates:
   *  the journal owns the attempts and the child-start facts, so a read that
   *  fails must not be told apart from an empty one by nobody. */
  private classifyAt(runDir: string): ClassifiedLines {
    try {
      return classify(readFileSync(this.pathFor(runDir), "utf-8"));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { events: [], entries: [], skipped: 0, invalid: 0, unknown: 0 };
      throw error;
    }
  }

  /** Read a page from a byte offset. Unlike `readAt`, this bounds memory use and
   *  lets external readers follow a live run by passing `nextOffset` back. */
  readFrom(runId: string, offset: number, options?: RunEventPageOptions): RunEventPage {
    const runDir = this.resolveRunDir(runId);
    return runDir ? this.readFromAt(runDir, offset, options) : emptyPage(offset);
  }

  readFromAt(runDir: string, offset: number, options: RunEventPageOptions = {}): RunEventPage {
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_EVENT_PAGE_BYTES);
    const start = Math.max(0, Math.trunc(offset) || 0);

    return this.withFile(runDir, start, (fd, size) => {
      if (start >= size) return { ...emptyPage(Math.min(start, size), size) };

      const buffer = Buffer.allocUnsafe(Math.min(maxBytes, size - start));
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const { consumed, ...lines } = parseCompleteLines(buffer.subarray(0, read));
      const nextOffset = start + consumed;
      // No complete line in the window: keep the cursor still, or a line longer
      // than `maxBytes` could be lost.
      return { ...lines, nextOffset, size, eof: nextOffset >= size };
    });
  }

  /** Read the tail of a completed journal. A partial leading line is discarded;
   *  `nextOffset` remains usable for subsequent reads. */
  readTailAt(runDir: string, options: RunEventPageOptions = {}): RunEventPage {
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_EVENT_PAGE_BYTES);

    return this.withFile(runDir, 0, (fd, size) => {
      if (size === 0) return emptyPage(0, 0);

      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.allocUnsafe(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const window = buffer.subarray(0, read);
      // The window truncated the leading line, not the producer, so discard it.
      const firstBreak = start === 0 ? -1 : window.indexOf(0x0a);
      const aligned = firstBreak < 0 ? window : window.subarray(firstBreak + 1);
      const { consumed: _consumed, ...lines } = parseCompleteLines(aligned);
      return { ...lines, nextOffset: size, size, eof: true };
    });
  }

  /** Current journal size without reading it; used for cache invalidation. */
  sizeAt(runDir: string): number {
    return this.withFile(runDir, 0, (_fd, size) => size, 0);
  }

  private withFile<T>(runDir: string, fallbackOffset: number, read: (fd: number, size: number) => T): T;
  private withFile<T>(runDir: string, fallbackOffset: number, read: (fd: number, size: number) => T, fallback: T): T;
  private withFile<T>(runDir: string, fallbackOffset: number, read: (fd: number, size: number) => T, fallback?: T): T {
    let fd: number | null = null;
    try {
      fd = openSync(this.pathFor(runDir), "r");
      return read(fd, fstatSync(fd).size);
    } catch {
      // Readers use the typed empty page fallback when the journal is unavailable.
      return (fallback ?? emptyPage(fallbackOffset)) as T;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Closing is best effort: an invalid descriptor must not mask the read result.
        }
      }
    }
  }

  private pathFor(runDir: string): string {
    return runEventsFilePath(runDir);
  }

  private resolveRunDir(runId: string): string | undefined {
    return this.runDirs?.get(runId) ?? this.runDir;
  }
}
