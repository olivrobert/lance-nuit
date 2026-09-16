// Persistence for the run-stats projection.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatsEntry } from "./run-stats-projector.js";

export interface RunStatsSink {
  /** Return the canonical written location, or null on best-effort failure. */
  write(entry: RunStatsEntry): string | null;
}

export interface FileRunStatsSinkOptions {
  projRoot?: string;
}

function atomicWrite(path: string, content: string): void {
  // Per-writer temp name: a shared `.tmp` would let concurrent writers publish
  // each other's half-written bytes via rename.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/** Cross-process mutual exclusion around the read-modify-write of the shared
 *  history file: without it a concurrent writer's line is silently dropped by
 *  the whole-file rewrite. `mkdir` is atomic on every platform; a lock older
 *  than LOCK_STALE_MS is treated as abandoned by a crashed process. */
function withHistoryLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        // Lock vanished between the failed mkdir and the stat; retry immediately.
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring history lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // Releasing an already-removed (stale-reclaimed) lock is fine.
    }
  }
}

/** Central `.lance-nuit/pipeline-history/runs.jsonl`, the sole source of truth for
 *  run statistics. Nothing is mirrored per work item: a second copy would
 *  duplicate entries without a runner reader. */
export class FileRunStatsSink implements RunStatsSink {
  private readonly options: Required<FileRunStatsSinkOptions>;

  constructor(options: FileRunStatsSinkOptions = {}) {
    this.options = {
      projRoot: options.projRoot ?? process.cwd(),
    };
  }

  write(entry: RunStatsEntry): string | null {
    if (entry.schemaVersion !== 1) return null;
    const historyDir = join(this.options.projRoot, ".lance-nuit", "pipeline-history");
    const centralPath = join(historyDir, "runs.jsonl");
    try {
      mkdirSync(historyDir, { recursive: true });
      withHistoryLock(centralPath, () => this.upsertHistory(centralPath, entry));
      return centralPath;
    } catch {
      // Run statistics are observability data; failure must not affect run completion.
      return null;
    }
  }

  /** One logical line per run: new id = append, resume = atomic replacement. */
  private upsertHistory(path: string, entry: RunStatsEntry): void {
    let lines: string[] = [];
    try {
      lines = readFileSync(path, "utf-8")
        .split("\n")
        .filter((line) => line.trim());
    } catch {
      // A missing history file is the normal first-write case.
    }
    const serialized = JSON.stringify(entry);
    let replaced = false;
    const next = lines.filter((line) => {
      let sameRun = false;
      try {
        sameRun = (JSON.parse(line) as { runId?: string }).runId === entry.runId;
      } catch {
        // Preserve malformed existing lines; only valid matching runs are replaced.
      }
      if (!sameRun) return true;
      if (!replaced) {
        replaced = true;
        return true;
      }
      return false;
    });
    if (!replaced) {
      appendFileSync(path, `${serialized}\n`, { encoding: "utf-8" });
      return;
    }
    const index = next.findIndex((line) => {
      try {
        return (JSON.parse(line) as { runId?: string }).runId === entry.runId;
      } catch {
        // Malformed existing lines cannot identify the run being replaced.
        return false;
      }
    });
    next[index] = serialized;
    atomicWrite(path, `${next.join("\n")}\n`);
  }
}
