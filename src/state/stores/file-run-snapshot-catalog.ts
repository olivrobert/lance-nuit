import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PipelineContext } from "../../model/context.js";
import type { RunStateSnapshot } from "../../model/storage-ports.js";
import { readRunSnapshot } from "../run-snapshot.js";
import { baseRunsDir, DEFAULT_SPEC_PATH, STATE_FILE } from "./run-storage.js";

/** Filesystem inventory of snapshots, independent from store CRUD operations. */
export class FileRunSnapshotCatalog {
  constructor(private readonly context?: PipelineContext) {}

  list(ticket?: string, context?: PipelineContext): RunStateSnapshot[] {
    const effectiveContext = context ?? this.context;
    const roots = ticket
      ? [pipelineRunsRoot(ticket, effectiveContext)]
      : [pipelineRunsRoot(undefined, effectiveContext), ...findRunsRoots(workItemsRoot(effectiveContext))];
    const snapshots = roots.flatMap((root) => collectSnapshots(root));
    return [...new Map(snapshots.map((snapshot) => [snapshot.runDir ?? snapshot.statePath, snapshot])).values()];
  }
}

function workItemsRoot(context?: PipelineContext): string {
  return join(context?.cwd ?? process.cwd(), context?.config.specPath ?? DEFAULT_SPEC_PATH);
}

function pipelineRunsRoot(ticket: string | undefined, context?: PipelineContext): string {
  return baseRunsDir(ticket, context);
}

function directories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));
  } catch {
    // Snapshot discovery is opportunistic: an absent or unreadable directory is empty.
    return [];
  }
}

function findRunsRoots(root: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(root)) return [];
  const found: string[] = [];
  for (const path of directories(root)) {
    if (basename(path) === "runs") {
      found.push(path);
      continue;
    }
    found.push(...findRunsRoots(path, depth + 1));
  }
  return found;
}

function collectSnapshots(runsRoot: string): RunStateSnapshot[] {
  const snapshots: RunStateSnapshot[] = [];
  for (const pipelineDir of directories(runsRoot)) {
    for (const runDir of directories(pipelineDir)) {
      const statePath = join(runDir, STATE_FILE);
      const state = readRunSnapshot(statePath);
      if (!state) continue;
      let isLatest: boolean | undefined;
      try {
        isLatest = realpathSync(join(pipelineDir, "latest")) === realpathSync(runDir);
      } catch {
        // A missing or broken latest link simply means this snapshot is not latest.
        isLatest = false;
      }
      let modifiedAt: number | undefined;
      try {
        modifiedAt = statSync(statePath).mtimeMs;
      } catch {
        // A run removed during discovery has no modification time to expose.
      }
      snapshots.push({ state, runDir, statePath, isLatest, modifiedAt });
    }
  }
  return snapshots;
}
