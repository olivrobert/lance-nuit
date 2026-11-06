// history-runs — which record each run of a project's history is read from.
//
// Two files describe a finished run: its snapshot (`state.json`), the record the
// runner resumes from, and its line in `pipeline-history/runs.jsonl`, a copy of a
// few of its figures written at finalization. `lancenuit stats` and the dashboard's
// statistics page both list the history through this module, so they cannot
// disagree on which runs it holds or on what each one cost.
//
// The snapshot wins whenever it still reads: it is the record, it already holds
// the spend of a run in flight or resumed since its line was written, and its
// amount is `runSpend`, the one every other reader prints. The line stands in for
// it once it is gone — its directory or its work item deleted, or written in a
// format this release no longer reads. The history outlives its runs that way,
// with the amount `runSpend` gave when the line was written. Nothing is priced
// here: a run neither file priced stays unpriced.

import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { kitPath } from "../../shared/env/kit-layout.js";
import {
  listWorkItemRuns,
  type RunRead,
  type RunSpend,
  type RunsLocation,
  readRun,
  runSpend,
} from "../record/index.js";
import type { PersistedRun } from "../persisted.js";
import {
  aggregateHistory,
  filterHistory,
  type HistoryAggregate,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryRun,
  readHistory,
} from "./history-reader.js";
import { RUN_STATS_STATUSES } from "./history-schema.js";

const HISTORY_STATUSES: ReadonlySet<string> = new Set(RUN_STATS_STATUSES);

/** A snapshot found under the project, with the work-item folder holding it. */
interface FoundSnapshot {
  read: RunRead;
  /** Top-level work-item folder; absent for a run started without a work item. */
  folder?: string;
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // A run directory that vanished mid-scan has nothing left to read.
    return null;
  }
}

/** Real directories of `dir`; a link is not followed, as the dashboard lists them. */
function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A project without work items has no folder to list.
    return [];
  }
}

/**
 * Every readable snapshot of the project, by `runId`, each read once by its real
 * path. Top-level work items only: a nested one keeps its runs under its parent's
 * folder. Runs started without a work item live under the kit's own `runs/`.
 */
function readSnapshots(location: RunsLocation): Map<string, FoundSnapshot> {
  const root = join(location.cwd, location.specPath);
  const places: Array<{ dir: string; folder?: string }> = [
    ...folders(root).map((folder) => ({ dir: join(root, folder), folder })),
    { dir: kitPath(location.cwd) },
  ];
  const seen = new Set<string>();
  const snapshots = new Map<string, FoundSnapshot>();
  for (const { dir, folder } of places) {
    for (const { runDirs } of listWorkItemRuns(dir)) {
      for (const listed of runDirs) {
        const runDir = realPath(listed);
        if (!runDir || seen.has(runDir)) continue;
        seen.add(runDir);
        const read = readRun(runDir, location);
        const runId = read?.state.runId;
        if (!read || !runId || snapshots.has(runId)) continue;
        snapshots.set(runId, { read, ...(folder ? { folder } : {}) });
      }
    }
  }
  return snapshots;
}

/**
 * The spend a line recorded: the `runSpend` of the run when it was written. The
 * projector stores the amount as `costUsd`, the floor as `costUnknown`, and an
 * amount a rate table produced as `costStatus: "partial"`.
 */
export function lineSpend(entry: HistoryEntry): RunSpend {
  return {
    ...(typeof entry.costUsd === "number" ? { usd: entry.costUsd } : {}),
    estimated: entry.costStatus === "partial",
    lowerBound: entry.costUnknown === true,
  };
}

/** A history status the snapshot can state; a run still in flight has none yet. */
function historyStatus(read: RunRead): HistoryEntry["status"] {
  return HISTORY_STATUSES.has(read.status) ? (read.status as HistoryEntry["status"]) : undefined;
}

/** The line of a run the runner has not projected yet — in flight, or its
 *  emission failed — from what its snapshot says. It carries no token counts. */
function snapshotEntry(runId: string, state: PersistedRun, read: RunRead): HistoryEntry {
  const status = historyStatus(read);
  return {
    runId,
    pipeline: state.pipeline,
    ticket: state.ticket ?? null,
    parentRunId: state.parentRunId ?? null,
    startedAt: state.createdAt ?? null,
    endedAt: status ? (state.updatedAt ?? null) : null,
    ...(status ? { status } : {}),
  };
}

/**
 * Every run of the project's history, child runs included, newest first: each
 * from its snapshot when it still reads, from its `runs.jsonl` line otherwise.
 */
export function readHistoryRuns(location: RunsLocation): HistoryRun[] {
  const snapshots = readSnapshots(location);
  const runs: HistoryRun[] = [];
  for (const entry of readHistory(location.cwd)) {
    const found = snapshots.get(entry.runId);
    snapshots.delete(entry.runId);
    runs.push(
      found
        ? {
            // The nesting is the record's: an old line may predate the field.
            entry: { ...entry, parentRunId: found.read.state.parentRunId ?? entry.parentRunId ?? null },
            spend: runSpend(found.read.state),
            ...found,
          }
        : { entry, spend: lineSpend(entry) },
    );
  }
  for (const [runId, found] of snapshots) {
    runs.push({
      entry: snapshotEntry(runId, found.read.state, found.read),
      spend: runSpend(found.read.state),
      ...found,
    });
  }
  return runs.sort((a, b) => startedMs(b.entry) - startedMs(a.entry));
}

function startedMs(entry: HistoryEntry): number {
  const parsed = entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read, filter, and aggregate in one call; the reader's normal entry point. */
export function summarizeHistory(
  location: RunsLocation,
  filter: HistoryFilter = {},
): { runs: HistoryRun[]; aggregate: HistoryAggregate } {
  const all = readHistoryRuns(location);
  const runs = filterHistory(all, filter);
  // Count the children the same filter would otherwise have kept, so the reported
  // number explains this summary rather than the whole history.
  const childrenSkipped = filter.includeChildren
    ? 0
    : filterHistory(all, { ...filter, includeChildren: true }).length - runs.length;
  return { runs, aggregate: aggregateHistory(runs, childrenSkipped) };
}
