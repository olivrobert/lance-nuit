// runner/model/storage-ports.ts
//
// Storage contracts use business identities. Adapters may keep local locations,
// but location is not part of run, artifact, or log identity.

import { isLocalPath, isLogicalSegment, isRecord, isSafeRelativeName, optional, required } from "./artifact-ports.js";
import type { PipelineContext } from "./context.js";
import type { JournalEntry, RunJournalCounts, RunJournalEvent } from "./journal.js";
import type { PersistedRun } from "./persisted.js";
import type { ScanRecord } from "./scan-record.js";

export interface RunRef {
  runId: string;
  pipeline: string;
  ticket?: string;
}

export interface LogRef {
  run: RunRef;
  stepId: string;
  attempt: number;
  /** Location supplied only by an adapter that needs it. */
  localPath?: string;
}

export interface RunRefInput {
  runId: string;
  pipeline: string;
  ticket?: string;
}

/** Snapshot with only metadata readers need. Filesystem adapters may provide local
 * paths; remote or memory stores may provide only `state`. */
export interface RunStateSnapshot {
  state: PersistedRun;
  runDir?: string;
  statePath?: string;
  /** True when the adapter knows this snapshot is the `latest` target. */
  isLatest?: boolean;
  /** Sort fallback when the snapshot has no usable date. */
  modifiedAt?: number;
}

export interface LogRefInput {
  run: RunRef;
  stepId: string;
  attempt: number;
  localPath?: string;
}

export interface RunStateStore {
  load(runId: string): PersistedRun | null;
  loadLatest(pipeline: string, ticket?: string): PersistedRun | null;
  save(run: PersistedRun): void;
  /** Read extension for multi-pipeline diagnostics. */
  listSnapshots?(ticket?: string, context?: PipelineContext): RunStateSnapshot[];
  readAt?(runDir: string): PersistedRun | null;
  saveAt?(run: PersistedRun, runDir: string): void;
  /** Allocate or resolve a run's technical location. */
  resolveRunDir?(
    pipeline: string,
    ticket?: string,
    explicitRunDir?: string,
    fresh?: boolean,
    context?: PipelineContext,
  ): string;
}

/** Journal page returned by paginated reading. */
export interface RunEventPage extends RunJournalCounts {
  /** Contracted events of the window, in order. */
  events: RunJournalEvent[];
  /** Every classified line of the window, in order: the journal doubles as the
   *  live feed, so a reader following the file needs the unknown ones too. */
  entries: JournalEntry[];
  nextOffset: number;
  size: number;
  eof: boolean;
}

export interface RunEventStore {
  append(runId: string, event: RunJournalEvent): void;
  /** Contracted events only. Unknown and invalid lines are kept on disk and
   * counted, but a typed reader never sees them. */
  read(runId: string): RunJournalEvent[];
  /** Bounded read extension; `read` loads the entire journal, which external
   * readers cannot afford for a long run. */
  readFrom?(runId: string, offset: number, options?: { maxBytes?: number }): RunEventPage;
  /** Diagnostic read extension: the complete envelope with its counters. */
  readJournal?(runId: string): RunJournalCounts & { entries: JournalEntry[] };
}

/** Result of reading the durable scan records.
 *
 * `skipped` counts files that exist but cannot be used (unreadable, not JSON,
 * off schema). Reading is tolerant on purpose: one truncated record must not
 * hide every other scan, and the count is what makes a surprising total
 * explainable instead of invisible. */
export interface ScanReadResult {
  records: ScanRecord[];
  skipped: number;
}

/** Durable record of a `--scan` dispatch, one record per scan.
 *
 * `write` is called at every transition and always publishes the whole record:
 * the file is small (a hundred tickets at most), and a partial update could not
 * keep `pending`, `running`, and `done` distinct after a crash. */
export interface ScanStore {
  write(record: ScanRecord): void;
  readAll(): ScanReadResult;
}

export interface RunLogStore {
  allocate(run: RunRef, stepId: string, attempt: number): LogRef;
  append(log: LogRef, text: string): void;
  read(log: LogRef): string | null;
  /** Read extension for the latest log present for a step. */
  findLatest?(run: RunRef, stepId: string): LogRef | null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Verify that a value carries the minimum logical identity of a run. */
export function isRunRef(value: unknown): value is RunRef {
  if (!isRecord(value) || !isLogicalSegment(value.runId) || !isLogicalSegment(value.pipeline)) return false;
  return value.ticket === undefined || isSafeRelativeName(value.ticket);
}

/** Verify log identity and attempt. `localPath` remains optional. */
export function isLogRef(value: unknown): value is LogRef {
  return (
    isRecord(value) &&
    isRunRef(value.run) &&
    isLogicalSegment(value.stepId) &&
    isPositiveInteger(value.attempt) &&
    (value.localPath === undefined || isLocalPath(value.localPath))
  );
}

export function createRunRef(input: RunRefInput): RunRef {
  if (!isRecord(input)) throw new TypeError("Invalid RunRef");
  const runId = required(input.runId, "runId", isLogicalSegment);
  const pipeline = required(input.pipeline, "pipeline", isLogicalSegment);
  const ticket = optional(input.ticket, "ticket", isSafeRelativeName);
  return { runId, pipeline, ...(ticket !== undefined ? { ticket } : {}) };
}

/** Loose shape that both a persisted snapshot and an in-memory run satisfy:
 *  `runId` and `ticket` are optional there. Validation happens below. */
export interface RunRefSource {
  runId?: string;
  pipeline: string;
  ticket?: string;
}

/** Derive a reference without ever reading `run_dir` or another local path.
 *  Typed on `RunRefSource` rather than on `Run`: a run is assignable to it, and
 *  the reference grammar stays free of the in-memory run shape. */
export function runRefFromRun(run: RunRefSource): RunRef {
  if (!isRecord(run)) throw new TypeError("Invalid run");
  return createRunRef({
    runId: required(run.runId, "run.runId", isLogicalSegment),
    pipeline: required(run.pipeline, "run.pipeline", isLogicalSegment),
    ...(run.ticket !== undefined ? { ticket: required(run.ticket, "run.ticket", isSafeRelativeName) } : {}),
  });
}

export function createLogRef(input: LogRefInput): LogRef;
export function createLogRef(run: RunRef, stepId: string, attempt: number, localPath?: string): LogRef;
export function createLogRef(
  inputOrRun: LogRefInput | RunRef,
  stepId?: string,
  attempt?: number,
  localPath?: string,
): LogRef {
  const input =
    stepId === undefined && isRecord(inputOrRun) && "run" in inputOrRun
      ? inputOrRun
      : { run: inputOrRun, stepId, attempt, localPath };
  if (!isRecord(input) || !isRunRef(input.run)) throw new TypeError("Invalid LogRef.run");
  const normalizedRun = createRunRef(input.run);
  const normalizedStepId = required(input.stepId, "log.stepId", isLogicalSegment);
  if (!isPositiveInteger(input.attempt)) throw new TypeError("log.attempt must be a positive integer");
  const normalizedLocalPath =
    input.localPath === undefined ? undefined : required(input.localPath, "log.localPath", isLocalPath);
  return {
    run: normalizedRun,
    stepId: normalizedStepId,
    attempt: input.attempt,
    ...(normalizedLocalPath !== undefined ? { localPath: normalizedLocalPath } : {}),
  };
}
