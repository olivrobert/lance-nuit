//
// Human-facing inspection of persisted runs. These readers deliberately walk only the
// durable `runs/<pipeline>/<runId>` tree; they never consult the old run layout or
// the central history file as a substitute for a work-item snapshot.

import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createArtifactRef } from "../../shared/language/artifact-ports.js";
import type { PipelineContext } from "../../shared/language/context.js";
import type { PersistedPipelineChildRef, PersistedRun, PersistedStepState, RunJournalCounts } from "../../run/index.js";
import {
  createRunRef,
  isClosureCurrent,
  readClosureAt,
  runSpend,
  type RunLogStore,
  type RunStateSnapshot,
  type RunStateStore,
  awaitsHuman,
  effectiveStepStatus,
  FileRunLogStore,
  FileRunStateStore,
  matchesStepSelector,
  type RunJournalReport,
  type RunRead,
  type RunsLocation,
  readListedRun,
  readRunJournal,
  runsLocationOf,
} from "../../run/index.js";
import { parseAge } from "../../shared/lib/durations.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { gateDecisionStatus, isValidSubjectToken, readLock, stampKey } from "../../work-items/index.js";
import { formatDuration } from "../output/format.js";
import { isPathWithin } from "../../shared/lib/path-safety.js";
import { isPipelineName } from "../../definition/index.js";

type WorkItemLock = ReturnType<typeof readLock>;

export interface DiagnosticsOptions {
  stateStore?: RunStateStore;
  logStore?: RunLogStore;
}

/** A listed run as the run record reads it (`readListedRun`): `state` carries
 *  the steps a resume would start from, and `status` the one the dashboard shows
 *  for the same run. */
export interface RunRecord {
  dir: string;
  statePath: string;
  pipeline: string;
  runId: string;
  state: PersistedRun;
  status: RunRead["status"];
  /** No verdict and no live holder: the runner died. `status` is then `ABORTED`. */
  interrupted: boolean;
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

function toRecord(snapshot: RunStateSnapshot, location: RunsLocation): RunRecord {
  const { state, status, interrupted } = readListedRun(snapshot, location);
  return {
    dir: snapshot.runDir ?? "",
    statePath: snapshot.statePath ?? "",
    pipeline: state.pipeline,
    runId: state.runId!,
    state,
    status,
    interrupted,
    isLatest: snapshot.isLatest,
    modifiedAt: snapshot.modifiedAt,
  };
}

function listRunRecords(context: PipelineContext, ticket?: string, options?: DiagnosticsOptions): RunRecord[] {
  const stateStore = stateStoreFor(context, ticket, options);
  const snapshots = stateStore.listSnapshots?.(ticket, context) ?? [];
  const location = runsLocationOf(context);
  return [
    ...new Map(
      snapshots
        .map((snapshot) => toRecord(snapshot, location))
        .map((record) => [record.dir || `${record.pipeline}:${record.runId}`, record]),
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

function selectRunRecord(records: RunRecord[], runId?: string): RunRecord | undefined {
  if (runId) return records.find((record) => record.runId === runId || basename(record.dir) === runId);
  return sortNewest(records)[0];
}

function outcomeLine(state: PersistedRun): string {
  const outcome = state.outcome;
  if (!outcome) return "outcome: —";
  const reason = outcome.reason ? ` — ${outcome.reason}` : "";
  const log = outcome.logPath ? ` — log: ${outcome.logPath}` : "";
  return `outcome: ${outcome.phase ?? "run"}${reason}${log}${outcome.resumable ? " (resumable)" : ""}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Journal counts, on one line of `--inspect`. The journal is a trace, never the
 *  run's record: these counts judge nothing about the run, which `state.json`
 *  alone describes. Uncontracted lines (the `unknown` count) are reported as
 *  ignored; `invalid` and `skipped` only appear when non-zero. */
function journalLine(record: RunRecord): string {
  const journal = diagnoseRunJournal(record);
  if (journal.readError !== undefined) return `journal: unreadable — ${journal.readError.split("\n", 1)[0]}`;
  if (journal.known + journal.unknown + journal.invalid + journal.skipped === 0) return "journal: —";
  const parts = [plural(journal.known, "event")];
  if (journal.invalid > 0) parts.push(`${journal.invalid} invalid`);
  if (journal.skipped > 0) parts.push(`${journal.skipped} skipped`);
  const ignored = journal.unknown > 0 ? ` (${plural(journal.unknown, "uncontracted line")} ignored)` : "";
  const counts = `${parts.join(", ")}${ignored}`;
  if (journal.invalid === 0) return `journal: ${counts}`;
  const refused = Object.entries(journal.invalidByType)
    .map(([type, { count, reason }]) => `${type} ×${count} — ${reason.split("\n", 1)[0]}`)
    .join("; ");
  return `journal: ${counts}\n  refused: ${refused}`;
}

/**
 * The approval a stopped run waits on, judged as its gate will judge it on resume
 * (`gateDecisionStatus`, the reading the dashboard shows too).
 *
 * An approval granted elsewhere (the dashboard, another terminal) does not change
 * the run's status: only this line tells whoever reads `--inspect` that the gate
 * is already lifted and the run only needs resuming. A rejection is told apart
 * by whether the rework has answered it yet.
 */
async function approvalLine(context: PipelineContext, record: RunRecord): Promise<string | undefined> {
  const subject = record.status === "STOPPED" ? record.state.outcome?.stop?.subject : undefined;
  const { ticket, paths } = context;
  if (!subject || !isValidSubjectToken(subject) || !ticket || !paths.workItemDir) return undefined;
  const status = await gateDecisionStatus(paths.workItemDir, subject, (name) =>
    context.artifacts.readText(createArtifactRef(ticket, name)),
  );
  if (status.state === "absent") return `approval: ${subject} — none recorded`;
  const { decision } = status;
  const by = `${decision.decidedBy} on ${decision.decidedAt}`;
  switch (status.state) {
    case "fresh":
      return `approval: ${subject} — current, by ${by}; resume the run without --approve`;
    case "stale":
      return `approval: ${subject} — stale, the artifact changed since ${by} approved it`;
    case "rejected":
      return `approval: ${subject} — rejected in round ${decision.round} by ${by}: ${decision.reason}; resume the run to rework it`;
    case "reworked":
      return `approval: ${subject} — reworked after rejection round ${decision.round}; approve it or reject it again`;
  }
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Own spend, what a fork inherited, and the ceiling both count against. */
function spendLine(state: PersistedRun): string {
  const spend = runSpend(state);
  const own = spend.usd === undefined ? "—" : `${usd(spend.usd)}${spend.lowerBound ? " at least" : ""}`;
  const estimated = spend.estimated ? " (estimated)" : "";
  const inherited = state.inheritedSpendUsd ? `, inherited ${usd(state.inheritedSpendUsd)}` : "";
  const budget = state.max_cost_usd === undefined ? "none" : usd(state.max_cost_usd);
  return `spend: ${own}${estimated} own${inherited}; budget ${budget}`;
}

function lineageLines(state: PersistedRun): string[] {
  return [
    ...(state.forkedFrom ? [`forked from: ${state.forkedFrom} at ${state.startAt ?? "—"}`] : []),
    ...(state.supersededBy ? [`superseded by: ${state.supersededBy}`] : []),
  ];
}

function closedLine(record: RunRecord): string {
  const closure = record.dir ? readClosureAt(record.dir) : undefined;
  if (!closure) return "closed: no";
  if (!isClosureCurrent(closure, record.state)) return "closed: no (a closure predates the last write)";
  return `closed: by ${closure.closedBy} on ${closure.closedAt}`;
}

/** The lock of the work item the run belongs to; `undefined` when it cannot
 *  be read, which `lockLine` reports instead of the stamps. */
function readWorkItemLock(context: PipelineContext): { lock?: WorkItemLock; error?: string } {
  const dir = context.paths.workItemDir;
  if (!dir) return {};
  try {
    return { lock: readLock(dir) };
  } catch (error) {
    return { error: errorMessage(error).split("\n", 1)[0] };
  }
}

function stepLine(
  step: PersistedStepState,
  state: PersistedRun,
  interrupted: boolean,
  lock: WorkItemLock | undefined,
): string {
  const attempts = step.attempts ?? [];
  const last = attempts.at(-1);
  const tried = last ? ` (${plural(attempts.length, "attempt")}, last ${last.kind} ${last.status})` : "";
  const stamp = lock?.steps[stampKey(step.id, state.lot)];
  const absorbed = stamp?.absorbed && stamp.runId === state.runId ? " [absorbed]" : "";
  const error = step.errors ? ` — ${step.errors.split("\n", 1)[0]}` : "";
  return `  ${effectiveStepStatus(step.status, interrupted).padEnd(8)} ${step.id}${tried}${absorbed}${error}`;
}

function formatRunRecord(
  record: RunRecord,
  workItem: { lock?: WorkItemLock; error?: string },
  approval?: string,
): string {
  const { state, status, interrupted } = record;
  const duration = formatDuration(runSpend(state).durationMs);
  const lines = [
    `Run ${record.runId}`,
    `pipeline: ${record.pipeline}`,
    `ticket: ${state.ticket ?? "—"}`,
    `status: ${status}${interrupted ? " (interrupted: the runner died without a verdict)" : ""}`,
    ...lineageLines(state),
    closedLine(record),
    `created: ${state.createdAt ?? "—"}`,
    `updated: ${state.updatedAt ?? "—"}`,
    `duration: ${duration ? `${duration} of attempts` : "—"}`,
    spendLine(state),
    `cwd: ${state.cwd ?? "—"}${state.worktree ? " (worktree)" : ""}`,
    outcomeLine(state),
    ...(approval ? [approval] : []),
    journalLine(record),
    ...(workItem.error ? [`lock: unreadable — ${workItem.error}`] : []),
    "steps:",
  ];
  for (const step of state.steps) lines.push(stepLine(step, state, interrupted, workItem.lock));
  return lines.join("\n");
}

/** Child runs of `parent` listed with it, in execution order (oldest first). */
function childrenOf(parent: RunRecord, records: RunRecord[]): RunRecord[] {
  return sortNewest(records.filter((record) => record.state.parentRunId === parent.runId)).reverse();
}

/** Children the parent launched on another work item (`forEachWorkItem`): their
 *  snapshots live under that work item, so only the parent's ref describes them. */
function foreignChildRefs(parent: RunRecord, listed: ReadonlySet<string>): PersistedPipelineChildRef[] {
  return parent.state.steps
    .flatMap((step) => step.orchestration?.children ?? [])
    .filter((ref) => ref.runId !== undefined && !listed.has(ref.runId));
}

/** The child's own snapshot, read as a listed run, so a child whose runner died
 *  reads as interrupted like a top-level run; the parent's ref otherwise. */
function formatChildRefLine(ref: PersistedPipelineChildRef, child: RunRecord | undefined): string {
  const ticket = ref.ticket ? ` ${ref.ticket}` : "";
  return `${(child?.status ?? ref.status).padEnd(9)} ${ref.pipeline}${ticket} (${ref.runId})`;
}

function foreignChildFinder(context: PipelineContext, stateStore: RunStateStore) {
  const byTicket = new Map<string | undefined, RunStateSnapshot[]>();
  const location = runsLocationOf(context);
  return (ref: PersistedPipelineChildRef): RunRecord | undefined => {
    if (!byTicket.has(ref.ticket)) byTicket.set(ref.ticket, stateStore.listSnapshots?.(ref.ticket, context) ?? []);
    const snapshot = byTicket
      .get(ref.ticket)!
      .find((entry) => entry.state.runId === ref.runId && entry.state.ticket === ref.ticket);
    return snapshot ? toRecord(snapshot, location) : undefined;
  };
}

function formatChildLine(record: RunRecord): string {
  const state = record.state;
  const lot = state.lot ? ` ${state.lot.title || state.lot.id}` : "";
  const failed = state.steps.find((step) => step.status === "failed" && step.errors);
  const error = failed ? ` — ${failed.id}: ${failed.errors!.split("\n", 1)[0]}` : "";
  return `${record.status.padEnd(9)} ${record.pipeline}${lot} (${record.runId})${error}`;
}

/** Render a run followed by its sub-run tree, one indented line per child. A
 * `forEachPipeline` run spawns one child per item; listing them here is the only
 * way to see the whole run without grepping `parentRunId` in the snapshots. */
async function formatRunTree(
  context: PipelineContext,
  stateStore: RunStateStore,
  record: RunRecord,
  records: RunRecord[],
): Promise<string> {
  const lines = [formatRunRecord(record, readWorkItemLock(context), await approvalLine(context, record))];
  const listed = new Set(records.map((entry) => entry.runId));
  const foreignChild = foreignChildFinder(context, stateStore);
  const render = (parent: RunRecord, depth: number) => {
    const children = childrenOf(parent, records);
    const foreign = foreignChildRefs(parent, listed);
    if (depth === 1 && children.length + foreign.length > 0) lines.push("children:");
    for (const child of children) {
      lines.push(`${"  ".repeat(depth)}${formatChildLine(child)}`);
      render(child, depth + 1);
    }
    for (const ref of foreign) lines.push(`${"  ".repeat(depth)}${formatChildRefLine(ref, foreignChild(ref))}`);
  };
  render(record, 1);
  return lines.join("\n");
}

export interface InspectSelection {
  runId?: string;
  /** Only the runs of this pipeline: a name, or the path of its file as `-p` takes it. */
  pipeline?: string;
}

/** A path names the runs started from that file. A snapshot records it relative
 *  to the cwd of its run, a worktree maybe, so the pipeline named after the file
 *  matches too. */
function pipelineMatcher(context: PipelineContext, pipeline: string | undefined): (record: RunRecord) => boolean {
  if (pipeline === undefined) return () => true;
  if (isPipelineName(pipeline)) return (record) => record.pipeline === pipeline;
  const file = resolve(context.cwd, pipeline);
  const stem = basename(pipeline, extname(pipeline));
  return (record) =>
    record.pipeline === stem ||
    (record.state.pipeline_path !== undefined && resolve(context.cwd, record.state.pipeline_path) === file);
}

/** The pipelines of `ticket` that `pipeline`, a name or a file path, designates.
 *  A name is returned as is, whether it has runs or not. */
export function pipelineNamesOf(
  context: PipelineContext,
  ticket: string,
  pipeline: string,
  options?: DiagnosticsOptions,
): string[] {
  if (isPipelineName(pipeline)) return [pipeline];
  const ofPipeline = pipelineMatcher(context, pipeline);
  const records = listRunRecords(context, ticket, options).filter(ofPipeline);
  return [...new Set(records.map((record) => record.pipeline))].sort();
}

export async function inspectTicket(
  context: PipelineContext,
  ticket: string,
  selection: InspectSelection = {},
  options?: DiagnosticsOptions,
): Promise<string> {
  const { runId, pipeline } = selection;
  const { stateStore, records } = recordsFor(context, ticket, options);
  const ofPipeline = pipelineMatcher(context, pipeline);
  const among = pipeline === undefined ? "" : ` of pipeline ${pipeline}`;
  if (!records.some(ofPipeline)) return `No run${among} found for ${ticket}.`;
  const selected = runId ? selectRunRecord(records.filter(ofPipeline), runId) : undefined;
  if (runId && !selected) return `Run ${runId}${among} not found for ${ticket}.`;
  if (selected) return formatRunTree(context, stateStore, selected, records);
  // A child run belongs to the tree of its parent; only orphans (parent snapshot
  // gone) compete for the "latest per pipeline" slots, and, under `--pipeline`,
  // the children whose parent runs another pipeline.
  const byRunId = new Map(records.map((record) => [record.runId, record] as const));
  const topLevel = records.filter((record) => {
    const parent = record.state.parentRunId ? byRunId.get(record.state.parentRunId) : undefined;
    return ofPipeline(record) && (!parent || (pipeline !== undefined && !ofPipeline(parent)));
  });
  const trees = await Promise.all(
    latestPerPipeline(topLevel, stateStore, ticket).map((record) =>
      formatRunTree(context, stateStore, record, records),
    ),
  );
  return trees.join("\n\n");
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
