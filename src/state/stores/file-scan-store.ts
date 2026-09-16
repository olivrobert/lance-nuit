// state/stores/file-scan-store.ts
//
// Filesystem adapter for `ScanStore`.
//
// Location: `.lance-nuit/pipeline-history/scans/`, resolved exactly like
// `runs.jsonl` (`state/stats/run-stats-sink.ts`). `pipeline-history/` is already
// the cross-run telemetry directory a worktree links back to the main clone
// (`env/worktree.ts`, `SHARED_KIT_DIRS`), and the dispatch parent runs in the
// main clone: a record written anywhere inside a worktree would die with it.
//
// One file per scan, rewritten in full on every transition. The record is small
// — a hundred tickets at most — and a partial update could not keep `pending`,
// `running`, and `done` apart on a record left behind by a crash.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanReadResult, ScanStore } from "../../model/storage-ports.js";
import type { ScanRecord } from "../../model/scan-record.js";
import { parseScanRecord } from "../scan-schema.js";

const SCANS_DIR = "scans";

export interface FileScanStoreOptions {
  /** Project root holding `.lance-nuit/`. Defaults to the process cwd. */
  projRoot?: string;
}

/** Directory holding the scan records of a project. */
export function scansDir(projRoot: string = process.cwd()): string {
  return join(projRoot, ".lance-nuit", "pipeline-history", SCANS_DIR);
}

/** ISO instant without the separators a file name should not carry:
 *  `2026-09-07T10:11:12.345Z` becomes `20260907T101112345Z`, which sorts
 *  chronologically as a string. A value that is not an ISO instant is kept as a
 *  sanitized slug rather than rejected: the record still has to land somewhere. */
function compactInstant(value: string): string {
  return slug(value.replaceAll(/[-:.]/g, "")) || "unknown";
}

/** Reduce a value to one safe file-name segment. */
function slug(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `<startedAt>-<pipeline>-<shortid>.json`: sortable by time, readable, and
 *  unique even when two scans of one pipeline start in the same millisecond. */
export function scanRecordFileName(record: ScanRecord, shortId: string): string {
  return `${compactInstant(record.startedAt)}-${slug(record.pipeline) || "pipeline"}-${shortId}.json`;
}

export class FileScanStore implements ScanStore {
  private readonly projRoot: string;

  /** Fixed for the lifetime of the store, so every transition of one scan
   *  rewrites the same file instead of leaving a trail of partial records. */
  private readonly shortId = randomUUID().slice(0, 8);

  constructor(options: FileScanStoreOptions = {}) {
    this.projRoot = options.projRoot ?? process.cwd();
  }

  write(record: ScanRecord): void {
    const dir = scansDir(this.projRoot);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, scanRecordFileName(record, this.shortId));
    // Per-writer temp name: a shared `.tmp` would let concurrent writers publish
    // each other's half-written bytes via rename.
    const temporaryPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(temporaryPath, path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Temporary record cleanup is best effort; preserve the original write error.
      }
      throw error;
    }
  }

  /** Every readable record, newest scan first. A file that cannot be read or
   *  does not pass the schema is counted, not thrown: a single truncated write
   *  must not hide every other scan. */
  readAll(): ScanReadResult {
    let names: string[];
    try {
      names = readdirSync(scansDir(this.projRoot)).filter((name) => name.endsWith(".json"));
    } catch {
      // No scan has run yet in this project: an absent directory is not an error.
      return { records: [], skipped: 0 };
    }

    const records: ScanRecord[] = [];
    let skipped = 0;
    // File names start with the compact start instant, so a descending sort on
    // the name is a descending sort on time.
    for (const name of names.sort().reverse()) {
      const record = this.readOne(join(scansDir(this.projRoot), name));
      if (record) records.push(record);
      else skipped += 1;
    }
    return { records, skipped };
  }

  private readOne(path: string): ScanRecord | null {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // Unreadable file: counted as skipped by the caller.
      return null;
    }
    try {
      return parseScanRecord(JSON.parse(raw));
    } catch {
      // Not JSON — a write interrupted midway, or a foreign file.
      return null;
    }
  }
}
