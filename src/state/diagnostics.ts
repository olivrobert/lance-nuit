// runner/state/diagnostics.ts
//
// Human-facing inspection of persisted runs. These readers deliberately walk only the
// durable `runs/<pipeline>/<runId>` tree; they never consult the old run layout or
// the central history file as a substitute for a work-item snapshot.

import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { PipelineContext } from "../model/context.js";
import type { RunJournalCounts } from "../model/journal.js";
import type { PersistedRun } from "../model/persisted.js";
import { createRunRef, type RunLogStore, type RunStateSnapshot, type RunStateStore } from "../model/storage-ports.js";
import { errorMessage } from "../lib/errors.js";
import { readRunJournal, type RunJournalReport } from "./run-journal.js";
import { matchesStepSelector } from "./run-timeline.js";
import { FileRunLogStore } from "./stores/file-run-log-store.js";
import { FileRunStateStore } from "./stores/file-run-state-store.js";
import { isPathWithin } from "./stores/path-safety.js";

export interface DiagnosticsOptions {
  stateStore?: RunStateStore;
  logStore?: RunLogStore;
}

export interface RunRecord {
  dir: string;
  statePath: string;
  pipeline: string;
  runId: string;
  state: PersistedRun;
  isLatest?: boolean;
  modifiedAt?: number;
}

function stateStoreFor(
  context: PipelineContext,
  ticket: string | undefined,
  options?: DiagnosticsOptions,
): RunStateStore {
  return options?.stateStore ?? new FileRunStateStore({ context, ticket });
}

function logStoreFor(
  context: PipelineContext,
  ticket: string | undefined,
  options: DiagnosticsOptions | undefined,
  runDirs: Map<string, string>,
): RunLogStore {
  return options?.logStore ?? new FileRunLogStore({ context, ticket, runDirs });
}

/** Resolve the state store once per diagnostic command and reuse it for both
 * listing and latest-run selection. */
function recordsFor(
  context: PipelineContext,
  ticket: string | undefined,
  options?: DiagnosticsOptions,
): { stateStore: RunStateStore; records: RunRecord[] } {
  const stateStore = stateStoreFor(context, ticket, options);
  return {
    stateStore,
    records: listRunRecords(context, ticket, { ...options, stateStore }),
  };
}

function toRecord(snapshot: RunStateSnapshot): RunRecord {
  const state = snapshot.state;
  return {
    dir: snapshot.runDir ?? "",
    statePath: snapshot.statePath ?? "",
    pipeline: state.pipeline,
    runId: state.runId!,
    state,
    isLatest: snapshot.isLatest,
    modifiedAt: snapshot.modifiedAt,
  };
}

export function listRunRecords(context: PipelineContext, ticket?: string, options?: DiagnosticsOptions): RunRecord[] {
  const stateStore = stateStoreFor(context, ticket, options);
  const snapshots = stateStore.listSnapshots?.(ticket, context) ?? [];
  return [
    ...new Map(
      snapshots.map(toRecord).map((record) => [record.dir || `${record.pipeline}:${record.runId}`, record]),
    ).values(),
  ];
}

function recordDate(record: RunRecord): number {
  const value = Date.parse(record.state.updatedAt ?? record.state.createdAt ?? "");
  if (Number.isFinite(value)) return value;
  return record.modifiedAt ?? 0;
}

function sortNewest(records: RunRecord[]): RunRecord[] {
  return [...records].sort((a, b) => recordDate(b) - recordDate(a));
}

function latestPerPipeline(records: RunRecord[], stateStore: RunStateStore, ticket?: string): RunRecord[] {
  const byPipeline = new Map<string, RunRecord[]>();
  for (const record of records) {
    const values = byPipeline.get(record.pipeline) ?? [];
    values.push(record);
    byPipeline.set(record.pipeline, values);
  }
  const latest: RunRecord[] = [];
  for (const values of byPipeline.values()) {
    // `latest` is the authoritative selector for a pipeline. Timestamps are
    // only a defensive fallback for hand-built fixtures or a partially broken
    // link; they must not make an older run look current after a resume.
    let candidate = values.find((record) => record.isLatest === true);
    if (!candidate && values.every((record) => record.isLatest === undefined)) {
      const latestState = stateStore.loadLatest(values[0]!.pipeline, ticket);
      candidate = latestState?.runId ? values.find((record) => record.runId === latestState.runId) : undefined;
    }
    candidate ??= sortNewest(values)[0];
    if (candidate) latest.push(candidate);
  }
  return sortNewest(latest);
}

export function selectRunRecord(records: RunRecord[], runId?: string): RunRecord | undefined {
  if (runId) return records.find((record) => record.runId === runId || basename(record.dir) === runId);
  return sortNewest(records)[0];
}

function statusLabel(state: PersistedRun): string {
  return state.status ?? (state.aborted ? "ABORTED" : "UNKNOWN");
}

function outcomeLine(state: PersistedRun): string {
  const outcome = state.outcome;
  if (!outcome) return "outcome: —";
  const reason = outcome.reason ? ` — ${outcome.reason}` : "";
  const log = outcome.logPath ? ` — log: ${outcome.logPath}` : "";
  return `outcome: ${outcome.phase ?? "run"}${reason}${log}${outcome.resumable ? " (resumable)" : ""}`;
}

/** Journal health, on one line of `--inspect`. `unknown` is expected to dominate
 *  — the file is also the live feed — so the line exists mainly to surface
 *  `invalid`, the only count that means a recorded fact was lost. */
function journalLine(record: RunRecord): string {
  const journal = diagnoseRunJournal(record);
  if (journal.readError !== undefined) return `journal: unreadable — ${journal.readError.split("\n", 1)[0]}`;
  if (journal.known + journal.unknown + journal.invalid + journal.skipped === 0) return "journal: —";
  const counts =
    `${journal.known} known, ${journal.unknown} unknown, ` + `${journal.invalid} invalid, ${journal.skipped} skipped`;
  if (journal.invalid === 0) return `journal: ${counts}`;
  const refused = Object.entries(journal.invalidByType)
    .map(([type, { count, reason }]) => `${type} ×${count} — ${reason.split("\n", 1)[0]}`)
    .join("; ");
  return `journal: ${counts}\n  refused: ${refused}`;
}

export function formatRunRecord(record: RunRecord): string {
  const state = record.state;
  const lines = [
    `Run ${record.runId}`,
    `pipeline: ${record.pipeline}`,
    `ticket: ${state.ticket ?? "—"}`,
    `status: ${statusLabel(state)}`,
    `created: ${state.createdAt ?? "—"}`,
    `updated: ${state.updatedAt ?? "—"}`,
    outcomeLine(state),
    journalLine(record),
    "steps:",
  ];
  for (const step of state.steps) {
    const error = step.errors ? ` — ${step.errors.split("\n", 1)[0]}` : "";
    lines.push(`  ${step.status.padEnd(8)} ${step.id}${error}`);
  }
  return lines.join("\n");
}

/** Child runs of `parent`, in execution order (oldest first). */
function childrenOf(parent: RunRecord, records: RunRecord[]): RunRecord[] {
  return sortNewest(records.filter((record) => record.state.parentRunId === parent.runId)).reverse();
}

function formatChildLine(record: RunRecord): string {
  const state = record.state;
  const lot = state.lot ? ` ${state.lot.title || state.lot.id}` : "";
  const failed = state.steps.find((step) => step.status === "failed" && step.errors);
  const error = failed ? ` — ${failed.id}: ${failed.errors!.split("\n", 1)[0]}` : "";
  return `${statusLabel(state).padEnd(9)} ${record.pipeline}${lot} (${record.runId})${error}`;
}

/** Render a run followed by its sub-run tree, one indented line per child. A
 * `forEachPipeline` run spawns one child per item; listing them here is the only
 * way to see the whole run without grepping `parentRunId` in the snapshots. */
function formatRunTree(record: RunRecord, records: RunRecord[]): string {
  const lines = [formatRunRecord(record)];
  const render = (parent: RunRecord, depth: number) => {
    const children = childrenOf(parent, records);
    if (depth === 1 && children.length > 0) lines.push("children:");
    for (const child of children) {
      lines.push(`${"  ".repeat(depth)}${formatChildLine(child)}`);
      render(child, depth + 1);
    }
  };
  render(record, 1);
  return lines.join("\n");
}

export function inspectTicket(
  context: PipelineContext,
  ticket: string,
  runId?: string,
  options?: DiagnosticsOptions,
): string {
  const { stateStore, records } = recordsFor(context, ticket, options);
  if (records.length === 0) return `No run found for ${ticket}.`;
  const selected = runId ? selectRunRecord(records, runId) : undefined;
  if (runId && !selected) return `Run ${runId} not found for ${ticket}.`;
  if (selected) return formatRunTree(selected, records);
  // A child run belongs to the tree of its parent; only orphans (parent snapshot
  // gone) compete for the "latest per pipeline" slots.
  const knownRunIds = new Set(records.map((record) => record.runId));
  const topLevel = records.filter((record) => !record.state.parentRunId || !knownRunIds.has(record.state.parentRunId));
  return latestPerPipeline(topLevel, stateStore, ticket)
    .map((record) => formatRunTree(record, records))
    .join("\n\n");
}

/** Check both the lexical path and the actual target of a local log. An
 * `output.log` can be a symlink created after snapshot persistence, so a lexical
 * check alone could make the file store follow a link outside the run. */
function isSafeLocalLog(record: RunRecord, path: string): boolean {
  if (!record.dir) return true;
  const root = resolve(record.dir);
  const candidate = resolve(path);
  if (!isPathWithin(root, candidate)) return false;
  try {
    const realRoot = realpathSync(root);
    try {
      return isPathWithin(realRoot, realpathSync(candidate));
    } catch {
      // A missing file or broken link cannot disclose content; let the store
      // keep the standard not-found diagnostic.
      return true;
    }
  } catch {
    // An unresolved run root cannot safely contain a local log path.
    return false;
  }
}

function recordRunRef(record: RunRecord) {
  return createRunRef({ runId: record.runId, pipeline: record.pipeline, ticket: record.state.ticket });
}

function latestLog(record: RunRecord, logStore: RunLogStore, stepId: string): string | undefined {
  const run = recordRunRef(record);
  try {
    // The store may refuse a log it deems unsafe (symlink traversal); diagnostics
    // report such a refusal as no log for this step.
    const log = logStore.findLatest?.(run, stepId);
    if (!log) return undefined;
    if (log.localPath && !isSafeLocalLog(record, log.localPath)) return undefined;
    const text = logStore.read(log);
    return text === null ? undefined : text;
  } catch {
    return undefined;
  }
}

export function logsForTicket(
  context: PipelineContext,
  ticket: string,
  step?: string,
  runId?: string,
  options?: DiagnosticsOptions,
): string {
  const { stateStore, records } = recordsFor(context, ticket, options);
  const runDirs = new Map(records.filter((record) => record.dir).map((record) => [record.runId, record.dir] as const));
  const logStore = logStoreFor(context, ticket, options, runDirs);
  // Without an explicit run, inspect only the current run of each pipeline. A
  // global newest-run lookup would make `--step quality.tests` miss quality as
  // soon as a more recent feature run exists for the same ticket.
  const candidates = runId
    ? records
    : latestPerPipeline(records, stateStore, ticket).filter(
        (record) => !step || record.state.steps.some((stateStep) => matchesStepSelector(stateStep.id, step)),
      );
  const record = selectRunRecord(candidates, runId);
  if (!record) return runId ? `Run ${runId} not found for ${ticket}.` : `No run found for ${ticket}.`;
  const chunks: string[] = [];
  for (const stateStep of record.state.steps.filter((candidate) => !step || matchesStepSelector(candidate.id, step))) {
    const log = latestLog(record, logStore, stateStep.id);
    if (log !== undefined) chunks.push(`===== ${stateStep.id} =====\n${log}`);
  }
  return chunks.length > 0 ? chunks.join("\n") : `No logs found for ${step ?? "this run"}.`;
}

export function parseAge(value = "30d"): number {
  const match = value.trim().match(/^(\d+)([smhdw])$/i);
  if (!match) throw new Error(`Invalid duration: ${value} (expected: 30d, 12h, 45m...)`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
  return amount * factor;
}

function isFailure(state: PersistedRun): boolean {
  return ["FAIL", "ABORTED", "STOPPED"].includes(statusLabel(state));
}

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
    if (keepFailed && isFailure(record.state)) continue;
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

/**
 * Journal health of one run.
 *
 * `events.jsonl` is also the live feed, so `unknown` is the normal case and
 * dominates a real journal: the live-feed lines and the raw backend stream are
 * outside the journal contract by design. `invalid` is the number that matters —
 * a contracted type whose payload the schema refused. On a `step.attempt.*` it
 * means an attempt is missing from the projection, which restarts the numbering
 * on resume and overwrites the logs of the previous attempts. Any non-zero value
 * is either a producer bug or a schema too strict for the journal on disk;
 * neither is fixed by loosening the schema blindly.
 */
export interface RunJournalDiagnostic extends RunJournalCounts {
  pipeline: string;
  runId: string;
  runDir: string;
  /** Contracted events the typed readers receive. */
  known: number;
  /** Refused payloads per event type, with the first reason recorded. */
  invalidByType: Record<string, { count: number; reason: string }>;
  /** Why the journal could not be read at all. The counters are then zero and
   *  mean nothing: an unreadable journal is not an empty one. */
  readError?: string;
}

const UNREADABLE_REPORT: RunJournalReport = { entries: [], skipped: 0, invalid: 0, unknown: 0 };

export function diagnoseRunJournal(record: RunRecord): RunJournalDiagnostic {
  let report: RunJournalReport;
  let readError: string | undefined;
  try {
    report = readRunJournal(record.dir);
  } catch (error) {
    // One unreadable journal must not hide the other runs of the work item.
    report = UNREADABLE_REPORT;
    readError = errorMessage(error);
  }
  const invalidByType: Record<string, { count: number; reason: string }> = {};
  let known = 0;
  for (const entry of report.entries) {
    if (entry.kind === "known") known += 1;
    else if (entry.kind === "invalid") {
      const seen = invalidByType[entry.event.type];
      if (seen) seen.count += 1;
      else invalidByType[entry.event.type] = { count: 1, reason: entry.reason };
    }
  }
  return {
    pipeline: record.pipeline,
    runId: record.runId,
    runDir: record.dir,
    known,
    skipped: report.skipped,
    invalid: report.invalid,
    unknown: report.unknown,
    invalidByType,
    ...(readError !== undefined ? { readError } : {}),
  };
}

/** Journal health of every run of a work item, newest run first. */
export function diagnoseRunJournals(
  context: PipelineContext,
  ticket?: string,
  options?: DiagnosticsOptions,
): RunJournalDiagnostic[] {
  return listRunRecords(context, ticket, options).map(diagnoseRunJournal);
}
