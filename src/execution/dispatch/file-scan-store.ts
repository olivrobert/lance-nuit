//
// Filesystem adapter for `ScanStore`.
//
// Location: `.lance-nuit/pipeline-history/scans/`, resolved exactly like
// `runs.jsonl` (`run/stats/run-stats-sink.ts`). `pipeline-history/` is already
// the cross-run telemetry directory a worktree links back to the main clone
// (`entry/env/worktree.ts`, `SHARED_KIT_DIRS`), and the dispatch parent runs in the
// main clone: a record written anywhere inside a worktree would die with it.
//
// One file per scan, rewritten in full on every transition. The record is small
// — a hundred tickets at most — and a partial update could not keep `pending`,
// `running`, and `done` apart on a record left behind by a crash.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScanStore, ScanRecord } from "../../run/index.js";
import { historyDir } from "../../shared/env/kit-layout.js";
import { writeFileAtomic } from "../../shared/lib/atomic-write.js";

const SCANS_DIR = "scans";

export interface FileScanStoreOptions {
  /** Project root holding `.lance-nuit/`. Defaults to the process cwd. */
  projRoot?: string;
}

/** Directory holding the scan records of a project. */
export function scansDir(projRoot: string = process.cwd()): string {
  return join(historyDir(projRoot), SCANS_DIR);
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
    writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  }
}
