//
// Retention of per-attempt logs: compress then remove them for runs past a
// cutoff. The only module of the diagnostics that writes; it finds runs through
// the read-only `diagnostics-readers.ts`.

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { PipelineContext } from "../../shared/language/context.js";
import { awaitsHuman } from "../../run/index.js";
import { parseAge } from "../../shared/lib/durations.js";
import { listRunRecords, recordDate } from "./diagnostics-readers.js";

function compressAndRemove(path: string): number {
  try {
    const compressed = `${path}.gz`;
    if (!existsSync(compressed)) writeFileSync(compressed, gzipSync(readFileSync(path)));
    unlinkSync(path);
    return 1;
  } catch {
    // Retention is best effort: one unreadable or changing log must not stop cleanup.
    return 0;
  }
}

function removeStepLogs(dir: string): number {
  let count = 0;
  for (const entry of (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      // A step directory removed concurrently contributes no files to this pass.
      return [];
    }
  })()) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += removeStepLogs(path);
    else if (entry.isFile() && (entry.name === "output.log" || entry.name.endsWith(".log"))) {
      count += compressAndRemove(path);
    }
  }
  return count;
}

export function cleanLogs(
  context: PipelineContext,
  ticket: string | undefined,
  olderThan: string | undefined,
  keepFailed: boolean,
): { runs: number; files: number } {
  const cutoff = Date.now() - parseAge(olderThan ?? "30d");
  let runs = 0;
  let files = 0;
  for (const record of listRunRecords(context, ticket)) {
    if (recordDate(record) > cutoff) continue;
    // Kept: what a person still has to look at, an interrupted run included.
    if (keepFailed && awaitsHuman(record.status)) continue;
    const stepsDir = join(record.dir, "steps");
    const removed = removeStepLogs(stepsDir);
    // `events.jsonl` is the append-only audit journal and also the live feed for
    // the dashboard. It is canonical, so retention never deletes or rewrites it; only the
    // bulky per-attempt logs are pruned.
    if (removed > 0) {
      runs++;
      files += removed;
    }
  }
  return { runs, files };
}
