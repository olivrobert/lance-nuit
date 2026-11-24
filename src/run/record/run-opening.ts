//
// Open the run an invocation executes: select its directory, read its snapshot,
// and either restore it — the snapshot merged with the definition, crashed
// attempts settled, the fields a resume rewrites — or create it. Every snapshot
// and journal write of the opening happens here, and the caller learns whether
// it resumed instead of deriving it again. The journal is never read: the
// snapshot is the whole execution record. A finished (`PASS` or `SUPERSEDED`)
// run is opened read-only and nothing here writes it.
//
// What the invocation asks for stays with its caller (`execution/step/load-or-create-run.ts`):
// the definition a snapshot runs against comes in as a policy, called at the one
// point of the opening where it applies.
//
// `--start-at` never reopens a run: `forkRun` writes a new one from the source,
// and closes the source `SUPERSEDED` when it was unfinished. The caller has
// already selected and checked the source (`selectForkSource`, `checkForkSource`).

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_SPEC_PATH } from "../../shared/env/tickets.js";
import type { PipelineContext, PipelineLot } from "../../shared/language/context.js";
import type { Pipeline } from "../../definition/index.js";
import type { PersistedRun, PipelineLineageEntry } from "../persisted.js";
import type { DeepReadonly, RunView } from "../run.js";
import type { Run, RunStep } from "./run.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "../storage-ports.js";
import { log } from "../../shared/runtime/logging.js";
import type { PersistedAttempt, PersistedStepState } from "../persisted.js";
import { closeAttempt, journalAttemptClosed } from "./attempt-closure.js";
import { costIsLowerBound, runProvesUnpricedSpend, runSpend } from "./cost-accounting.js";
import { appendRunEvent } from "./run-journal.js";
import { remainingWork } from "./run-predicates.js";
import { saveRun } from "./run-repository.js";
import { RUN_SNAPSHOT_VERSION } from "./schema.js";
import { describeRunSnapshotProblem, hasRunSnapshotEntry, readRunSnapshotDiagnostic } from "./run-snapshot.js";
import { makeRunStep } from "./run-step.js";
import { isFinishedStatus } from "./run-status.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { FileRunLogStore } from "./stores/file-run-log-store.js";
import { FileRunStateStore } from "./stores/file-run-state-store.js";
import {
  allocateRunId,
  claimRunDir,
  pipelineRunsDir,
  pointLatestTo,
  type RunDirResolution,
  releaseRunDir,
  runLockHolder,
  STATE_FILE,
} from "./stores/run-storage.js";

/** Where the invocation that opens the run reads artifacts and writes decisions. */
export interface RunLocation {
  worktree: boolean;
  cwd: string;
}

/** The composition a run belongs to and the budget it answers to, as the caller
 *  knows them. A resumed run keeps what its snapshot already says. */
export interface RunScope {
  /** Effective ceiling imposed by the parent, already bounded by the child pipeline. */
  maxCostUsd?: number;
  /** `--budget` given explicitly, or inherited from a parent that received it. On a
   *  resume it is the human decision that lets children outgrow their own caps. */
  budgetApproved?: boolean;
  /** `--allow-unmetered` given explicitly, or propagated by a parent that carries
   *  the authorization. It permits spend nobody can price; the known lower bound
   *  still obeys the ceiling. */
  allowUnmetered?: boolean;
  parentRunId?: string;
  parentNodeId?: string;
  rootRunId?: string;
  budgetScopeId?: string;
  lot?: PipelineLot;
  pipelineLineage?: PipelineLineageEntry[];
}

/** An explicit selection validated before boot. Re-read immediately before
 *  hydration so a deletion or corruption race cannot initialize a run. */
export interface StrictSnapshotRead {
  path: string;
  releaseRunLock: boolean;
  expectedIdentity?: { runId: string; pipeline: string; ticket?: string };
}

/** What the invocation decides, called at the point of the opening where it applies. */
export interface RunOpeningPolicy {
  /** The definition a snapshot about to be resumed runs against. */
  resumeDefinition(saved: DeepReadonly<PersistedRun>): Promise<Pipeline>;
}

/** The selectors of this invocation, journaled with the resume they apply to. The
 *  step loop applies them; nothing persists them. */
export interface InvocationSelection {
  steps?: readonly string[];
  skip?: readonly string[];
  until?: string;
}

export interface OpenRunRequest {
  /** The definition as first loaded: it names the run directory and builds a new run. */
  pipeline: Pipeline;
  pipelinePath: string;
  ticket?: string;
  /** The run directory the invocation names; absent, the latest resumable run or a new one. */
  runDir?: string;
  fresh?: boolean;
  context: PipelineContext;
  location: RunLocation;
  scope: RunScope;
  stateStore?: RunStateStore;
  eventStore?: RunEventStore;
  logStore?: RunLogStore;
  strictSnapshot?: StrictSnapshotRead;
  policy: RunOpeningPolicy;
  selection?: InvocationSelection;
}

export interface OpenedRun {
  run: RunView;
  /** An existing snapshot was restored, rather than a new run created. A run
   *  that already has its verdict and is reopened counts too: true does not mean
   *  the run had work left. A `PASS` run is opened read-only (`readOnly`). */
  resumed: boolean;
}

type SelectionResolvingStore = RunStateStore & {
  resolveRunDirSelection?: (
    pipeline: string,
    ticket?: string,
    explicitRunDir?: string,
    fresh?: boolean,
    context?: PipelineContext,
  ) => RunDirResolution;
};

function strictSnapshotError(
  diagnostic: Exclude<ReturnType<typeof readRunSnapshotDiagnostic>, { kind: "valid" }>,
): Error {
  return new Error(
    `Cannot resume selected snapshot ${diagnostic.path}: it ${describeRunSnapshotProblem(diagnostic)}. ` +
      `Inspect or restore the run files, or use --fresh to start a new run.`,
  );
}

/** Merge pipeline definition with persisted state to produce the in-memory Run.
 *  A finished run keeps its verdict whatever the definition now declares. */
function hydrate(pipeline: Pipeline, pipelinePath: string, persisted: PersistedRun, scope: RunScope): Run {
  const definitionIds = new Set(pipeline.steps.map((step) => step.id));
  const removedIds = persisted.steps.map((step) => step.id).filter((id) => !definitionIds.has(id));
  if (removedIds.length > 0) {
    throw new Error(
      `Cannot resume run ${persisted.runId ?? "unknown"}: pipeline definition removed or renamed persisted step(s): ${removedIds.join(
        ", ",
      )}. Restore those step IDs or start a fresh run.`,
    );
  }
  const stateById = new Map(persisted.steps.map((state) => [state.id, state]));
  const steps: RunStep[] = pipeline.steps.map((def) => makeRunStep(def, stateById.get(def.id)));
  const remaining = remainingWork({ status: persisted.status, outcome: persisted.outcome, steps });
  const finished = isFinishedStatus(persisted.status);
  // A settled snapshot that never received a verdict is not terminal, it is a
  // run that still owes a `finalizeRun`: RUNNING is a crash in that window, and
  // ABORTED with no step left in flight is a SIGINT in the same window. Loading
  // either as terminal strands it — the parent of a child run then fails on
  // every resume, and a top-level run replays from scratch in a new directory.
  const awaitingVerdict = remaining.settled && remaining.owed;
  const terminal = finished || (persisted.status !== undefined && remaining.settled && !awaitingVerdict);
  return {
    name: persisted.name,
    ticket: persisted.ticket,
    pipeline: persisted.pipeline,
    pipeline_path: pipelinePath,
    run_dir: "",
    schemaVersion: persisted.schemaVersion,
    runId: persisted.runId ?? basename("run"),
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    // For a live resume, `aborted`, ABORTED, and outcome describe the previous
    // run's death, not durable state. A terminal snapshot with no executable
    // steps is different: child orchestration must be able to observe STOPPED,
    // FAIL, or PASS without converting it into a fresh RUNNING run.
    status: terminal ? persisted.status : "RUNNING",
    outcome: terminal ? persisted.outcome : undefined,
    // The ceiling stays pinned to the run: editing `.maxCost()` must not retune a
    // run already in flight. `scope.maxCostUsd` is the one deliberate override —
    // an orchestration ceiling, or `--budget` approving an overrun.
    max_cost_usd:
      scope.maxCostUsd ?? persisted.max_cost_usd ?? pipeline.max_cost_usd ?? pipeline.max_cost_per_work_item_usd,
    parentRunId: persisted.parentRunId ?? scope.parentRunId,
    parentNodeId: persisted.parentNodeId ?? scope.parentNodeId,
    rootRunId: persisted.rootRunId ?? scope.rootRunId ?? persisted.runId,
    budgetScopeId: persisted.budgetScopeId ?? scope.budgetScopeId ?? persisted.rootRunId ?? persisted.runId,
    lot: persisted.lot ?? scope.lot,
    pipelineLineage: persisted.pipelineLineage ?? scope.pipelineLineage,
    // Where the PREVIOUS invocation ran. `restore` overwrites both with this
    // invocation's location, and compares them to decide whether the snapshot
    // must be rewritten.
    worktree: persisted.worktree,
    cwd: persisted.cwd,
    steps,
    // Every charge drops the totals before the snapshot that follows it, so the
    // persisted ones always match the step totals.
    total_control: persisted.total_control,
    total_usage: persisted.total_usage,
    aborted: terminal ? persisted.aborted : false,
    stopped_reason: terminal ? persisted.stopped_reason : undefined,
    // A guard stop is durable until a human approves more spend: `--budget` (or a
    // parent recomputing a child's ceiling) is the only thing that lifts it.
    budget_exceeded: scope.maxCostUsd !== undefined ? undefined : persisted.budget_exceeded,
    // Approval is durable: a later resume without `--budget` must not re-pin the
    // children to the caps the approval already lifted.
    budget_approved: scope.budgetApproved || persisted.budget_approved || undefined,
    // Latched, and deliberately NOT conditioned on `scope.maxCostUsd`: raising
    // the ceiling changes an amount, it cannot price an attempt that closed
    // unpriced. Restored whether or not the snapshot is terminal, because it
    // describes the spend, not the previous generation's verdict.
    cost_unaccounted: persisted.cost_unaccounted,
    // Restored as persisted; a new authorization is applied afterwards by
    // `applyUnmeteredAuthorization`, which owns the scope rule and the journal.
    allow_unmetered: persisted.allow_unmetered,
    specPath: persisted.specPath ?? DEFAULT_SPEC_PATH,
    ...(finished ? { readOnly: true as const } : {}),
  };
}

/**
 * Apply an incoming unmetered authorization to a resumed run, once.
 *
 * The authorization belongs to a budget scope, not to an invocation: the run that
 * owns its scope is the one an operator authorizes, and the orchestration then
 * propagates it to every child it launches (`allowUnmetered` in the child's
 * scope). A composed child resumed directly is therefore not allowed to grant
 * itself what its scope withheld — its ceiling was capped by an ancestor and,
 * once persisted, the child cannot tell that ceiling from one it declared itself.
 * A capped child refuses and names the run to authorize instead; an uncapped one
 * has no strict policy to weaken and takes the flag.
 */
function applyUnmeteredAuthorization(run: Run, persisted: PersistedRun, scope: RunScope): boolean {
  if (scope.allowUnmetered !== true || run.allow_unmetered === true) return false;
  const resumedDirectly = scope.parentRunId === undefined && persisted.parentRunId !== undefined;
  if (resumedDirectly && run.max_cost_usd !== undefined) {
    log.warn(
      `--allow-unmetered ignored for run ${run.runId}: it is a composed child of ${persisted.parentRunId} and ` +
        `answers to budget scope ${run.budgetScopeId ?? "unknown"}. Authorize the run that owns that scope; the ` +
        `authorization propagates to its children.`,
    );
    return false;
  }
  run.allow_unmetered = true;
  return true;
}

function journalUnmeteredAuthorization(run: Run): void {
  appendRunEvent(run, "run.unmetered.authorized", {
    budgetScopeId: run.budgetScopeId ?? null,
    maxCostUsd: run.max_cost_usd ?? null,
  });
}

const CRASHED_ATTEMPT_REASON = "runner died before the attempt reported its result (crash, OOM, or SIGKILL)";

/**
 * Close, in memory, every attempt the snapshot left `running`. Opening a run with
 * no live holder means the process that opened them died (SIGKILL, OOM, power
 * loss): only a signal handler closes an attempt from outside the loop, and it
 * writes a finish. Such an attempt spent tokens nobody measured; closing it
 * failed and unpriced (`closeAttempt` applies the `cost_unknown` rule) keeps the
 * ledger from reading it as free.
 */
function settleCrashedAttempts(run: Run): { step: RunStep; attempt: PersistedAttempt }[] {
  const settled: { step: RunStep; attempt: PersistedAttempt }[] = [];
  for (const step of run.steps) {
    for (const attempt of step.attempts) {
      const closed = closeAttempt(step, attempt, {
        status: "failed",
        control: attempt.control,
        reason: attempt.errors ?? CRASHED_ATTEMPT_REASON,
        interrupted: true,
      });
      if (closed) settled.push({ step, attempt });
    }
  }
  return settled;
}

/** Give the snapshot a pending entry for every definition step it never recorded.
 * A step added to the pipeline since the last invocation has no persisted state,
 * so the selection would never see it and hydration would default it to `pending`:
 * `--step a` would run the new step too. Seeded here, it goes through the
 * selection like any other step that still owes work. */
function seedNewDefinitionSteps(pipeline: Pipeline, saved: PersistedRun): void {
  const persistedIds = new Set(saved.steps.map((state) => state.id));
  for (const def of pipeline.steps) {
    if (persistedIds.has(def.id)) continue;
    saved.steps.push({ id: def.id, status: "pending", retries: 0 });
  }
}

interface SelectedDirectory {
  dir: string;
  stateStore: RunStateStore;
  eventStore: RunEventStore;
  logStore: RunLogStore;
  saved: PersistedRun | null;
  /** Release the run lock this opening took, when a refusal leaves the run unopened. */
  releaseLock(): void;
}

/** Select the run directory and read its snapshot, strictly when a selection
 *  already named an existing one. */
function selectDirectory(request: OpenRunRequest): SelectedDirectory {
  const { pipeline, ticket, runDir: explicitRunDir, fresh, context } = request;
  const fallbackStore = new FileRunStateStore({ context, ticket, pipeline: pipeline.name });
  const stateStore = request.stateStore ?? fallbackStore;

  // A strict explicit selection already has a concrete directory and snapshot
  // path. The ordinary explicit-dir resolver creates missing directories, which
  // would turn a post-selection deletion into a fresh run.
  const strictExplicitSelection = explicitRunDir !== undefined && request.strictSnapshot !== undefined;
  const resolution = strictExplicitSelection
    ? undefined
    : (stateStore as SelectionResolvingStore).resolveRunDirSelection?.(
        pipeline.name,
        ticket,
        explicitRunDir,
        fresh,
        context,
      );
  const dir =
    (strictExplicitSelection ? explicitRunDir : undefined) ??
    resolution?.dir ??
    stateStore.resolveRunDir?.(pipeline.name, ticket, explicitRunDir, fresh, context) ??
    // A required-only adapter owns the authoritative snapshot but has no local
    // selector. Its compatibility scratch directory must not inspect or adopt
    // the filesystem's unrelated `latest` link.
    fallbackStore.resolveRunDir(
      pipeline.name,
      ticket,
      explicitRunDir,
      stateStore === fallbackStore ? fresh : true,
      context,
    );
  const eventStore = request.eventStore ?? new FileRunEventStore({ runDir: dir });
  const logStore = request.logStore ?? new FileRunLogStore({ runDir: dir });
  const releaseLock = () => {
    if (resolution?.acquiredRunLock || request.strictSnapshot?.releaseRunLock) releaseRunDir(dir);
  };

  // Resume a valid snapshot; otherwise create a new run.
  const existingExplicitSnapshot = explicitRunDir !== undefined && hasRunSnapshotEntry(fallbackStore.pathFor(dir));
  const strictPath =
    request.strictSnapshot?.path ??
    (resolution?.selectedSnapshot || existingExplicitSnapshot ? fallbackStore.pathFor(dir) : undefined);
  const saved = strictPath
    ? (() => {
        const diagnostic = readRunSnapshotDiagnostic(strictPath);
        if (diagnostic.kind !== "valid") {
          releaseLock();
          throw strictSnapshotError(diagnostic);
        }
        const expected = request.strictSnapshot?.expectedIdentity;
        if (
          expected &&
          (diagnostic.snapshot.runId !== expected.runId ||
            diagnostic.snapshot.pipeline !== expected.pipeline ||
            diagnostic.snapshot.ticket !== expected.ticket)
        ) {
          releaseLock();
          throw new Error(
            `Cannot resume selected snapshot ${diagnostic.path}: snapshot identity changed after selection.`,
          );
        }
        return diagnostic.snapshot;
      })()
    : stateStore.readAt
      ? stateStore.readAt(dir)
      : // A store exposing its own run-directory resolver also owns the basename
        // lookup (an in-memory/file-compatible adapter contract). A
        // required-only injected store has no such locality, so resume through its
        // authoritative latest snapshot instead of the fallback filesystem dir.
        stateStore.resolveRunDir
        ? stateStore.load(basename(dir))
        : fresh
          ? null
          : stateStore.loadLatest(pipeline.name, ticket);
  return { dir, stateStore, eventStore, logStore, saved, releaseLock };
}

/** Restore a snapshot: merge it with the definition, then record what this opening changed — its location, a new
 *  authorization, the crashed attempts it settled — in one save, and journal
 *  the resume before the facts it settled. */
async function restore(request: OpenRunRequest, selected: SelectedDirectory, saved: PersistedRun): Promise<Run> {
  const { dir, eventStore } = selected;
  const { policy, scope, location } = request;
  const pipeline = await policy.resumeDefinition(saved);
  seedNewDefinitionSteps(pipeline, saved);
  const run = hydrate(pipeline, request.pipelinePath, saved, scope);
  run.run_dir = dir;
  run.stateStore = selected.stateStore;
  run.eventStore = eventStore;
  run.logStore = selected.logStore;
  if (run.readOnly) return run;
  // A resume may run from another place than the invocation that created the
  // run (main clone instead of worktree, or the reverse): record where this one
  // runs, since that is where it will read and write from now on.
  const moved = run.worktree !== location.worktree || run.cwd !== location.cwd;
  run.worktree = location.worktree;
  run.cwd = location.cwd;
  const authorized = applyUnmeteredAuthorization(run, saved, scope);
  const settled = settleCrashedAttempts(run);
  const resumed = run.status === "RUNNING";
  if (resumed || moved || authorized || settled.length > 0) saveRun(run);
  if (resumed) {
    const { selection } = request;
    appendRunEvent(run, "run.resumed", {
      pipeline: run.pipeline,
      steps: selection?.steps ? [...selection.steps] : null,
      skip: selection?.skip ? [...selection.skip] : null,
      until: selection?.until ?? null,
    });
  }
  for (const { step, attempt } of settled) journalAttemptClosed(run, step, attempt);
  if (authorized) journalUnmeteredAuthorization(run);
  return run;
}

/** Create a run in the selected directory, persist it, then journal its start. */
function create(request: OpenRunRequest, selected: SelectedDirectory): Run {
  const { pipeline, scope, location, context } = request;
  const { dir } = selected;
  const runId = basename(dir);
  const run: Run = {
    schemaVersion: RUN_SNAPSHOT_VERSION,
    runId,
    name: pipeline.name,
    ticket: request.ticket,
    pipeline: pipeline.name,
    pipeline_path: request.pipelinePath,
    run_dir: dir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "RUNNING",
    max_cost_usd: scope.maxCostUsd ?? pipeline.max_cost_usd ?? pipeline.max_cost_per_work_item_usd,
    parentRunId: scope.parentRunId,
    // A fresh top-level run has no overrun to approve: `--budget` only sets its
    // ceiling. A fresh child inherits its parent's approval so its own children
    // are lifted the same way.
    budget_approved: scope.budgetApproved && scope.parentRunId !== undefined ? true : undefined,
    // A fresh run starts with no accounting history, so there is nothing to
    // inherit from the run it replaces: only this invocation's flag — or the
    // authorization its parent propagates — can authorize it.
    allow_unmetered: scope.allowUnmetered ? true : undefined,
    parentNodeId: scope.parentNodeId,
    rootRunId: scope.rootRunId ?? runId,
    budgetScopeId: scope.budgetScopeId ?? runId,
    lot: context.lot,
    pipelineLineage: scope.pipelineLineage,
    worktree: location.worktree,
    cwd: location.cwd,
    specPath: context.config.specPath,
    stateStore: selected.stateStore,
    eventStore: selected.eventStore,
    logStore: selected.logStore,
    steps: pipeline.steps.map((def) => makeRunStep(def)),
  };

  saveRun(run);
  appendRunEvent(run, "run.started", { pipeline: run.pipeline, ticket: run.ticket ?? null });
  if (run.allow_unmetered === true) journalUnmeteredAuthorization(run);
  return run;
}

/** Open the run this invocation executes: the snapshot it selects, restored, or
 *  a new run. */
export async function openRun(request: OpenRunRequest): Promise<OpenedRun> {
  const selected = selectDirectory(request);
  const { saved } = selected;
  try {
    if (saved?.schemaVersion === RUN_SNAPSHOT_VERSION && typeof saved.runId === "string") {
      return { run: await restore(request, selected, saved), resumed: true };
    }
    return { run: create(request, selected), resumed: false };
  } catch (error) {
    selected.releaseLock();
    throw error;
  }
}

export interface ForkRunRequest {
  pipeline: Pipeline;
  pipelinePath: string;
  ticket?: string;
  context: PipelineContext;
  location: RunLocation;
  /** This invocation's flags: a fork takes none of them from its source. */
  scope: Pick<RunScope, "maxCostUsd" | "budgetApproved" | "allowUnmetered">;
  /** The source run, selected and checked by the caller before any write. */
  sourceDir: string;
  startAt: string;
}

interface SettledSource {
  snapshot: PersistedRun;
  /** The source with its crashed attempts settled in memory, so the spend it
   *  hands down includes them. */
  run: Run;
  settled: { step: RunStep; attempt: PersistedAttempt }[];
}

function readSource(request: ForkRunRequest): SettledSource {
  const diagnostic = readRunSnapshotDiagnostic(join(request.sourceDir, STATE_FILE));
  if (diagnostic.kind !== "valid") {
    throw new Error(`--start-at: the source run ${describeRunSnapshotProblem(diagnostic)} (${diagnostic.path}).`);
  }
  const snapshot = diagnostic.snapshot;
  const run = hydrate(request.pipeline, request.pipelinePath, structuredClone(snapshot), {});
  run.run_dir = request.sourceDir;
  return { snapshot, run, settled: settleCrashedAttempts(run) };
}

function heldSourceError(sourceDir: string): Error {
  const holder = runLockHolder(sourceDir);
  return new Error(
    `--start-at: run ${basename(sourceDir)} is held by another runner process${holder ? ` (pid ${holder})` : ""}.` +
      ` Wait for it to finish, then fork it.`,
  );
}

function forkSteps(pipeline: Pipeline, source: Run, startAt: string): RunStep[] {
  const cut = pipeline.steps.findIndex((def) => def.id === startAt);
  if (cut < 0) throw new Error(`--start-at: step "${startAt}" not found in pipeline "${pipeline.name}".`);
  const sourceById = new Map(source.steps.map((step) => [step.id, step]));
  return pipeline.steps.map((def, index) => {
    const kept = index < cut ? sourceById.get(def.id) : undefined;
    if (!kept) return makeRunStep(def);
    return makeRunStep(def, {
      status: kept.status,
      session: kept.session,
      profile: kept.profile,
      orchestration: kept.orchestration,
    });
  });
}

interface ChildSpend {
  usd: number;
  /** Some of it could not be priced, or could not be read: the figure is a floor. */
  unknown: boolean;
}

/**
 * What the runs these steps composed spent beyond what their nodes already hold.
 * A child still out when the source's runner died never reported to its node,
 * and the fork closes it without a reconciliation: charged by difference here,
 * like `chargeChildReconciliation`, or the fork would neither count it against
 * its ceiling nor show it anywhere (a composed child is never summed on its own).
 */
function unreconciledChildSpend(
  steps: readonly DeepReadonly<Pick<PersistedStepState, "orchestration">>[],
  context: PipelineContext,
  visited: Set<string>,
): ChildSpend {
  const outstanding: ChildSpend = { usd: 0, unknown: false };
  for (const step of steps) {
    for (const ref of step.orchestration?.children ?? []) {
      if (ref.runId === undefined) continue;
      const dir = join(pipelineRunsDir(ref.pipeline, ref.ticket, context), ref.runId);
      if (visited.has(dir)) continue;
      visited.add(dir);
      const diagnostic = readRunSnapshotDiagnostic(join(dir, STATE_FILE));
      if (diagnostic.kind !== "valid") {
        if (ref.startedAt !== undefined) outstanding.unknown = true;
        continue;
      }
      const child = diagnostic.snapshot;
      const nested = unreconciledChildSpend(child.steps, context, visited);
      const total = (runSpend(child).usd ?? 0) + nested.usd;
      outstanding.usd += Math.max(0, total - (ref.accountedCostUsd ?? 0));
      const crashed = child.steps.some((state) => state.attempts?.some((attempt) => attempt.status === "running"));
      if (nested.unknown || crashed || costIsLowerBound(child)) outstanding.unknown = true;
    }
  }
  return outstanding;
}

function newFork(request: ForkRunRequest, source: Run, dir: string, children: ChildSpend): Run {
  const { pipeline, scope, location, context } = request;
  const runId = basename(dir);
  const now = new Date().toISOString();
  return {
    schemaVersion: RUN_SNAPSHOT_VERSION,
    runId,
    name: pipeline.name,
    ticket: request.ticket,
    pipeline: pipeline.name,
    pipeline_path: request.pipelinePath,
    run_dir: dir,
    createdAt: now,
    updatedAt: now,
    status: "RUNNING",
    max_cost_usd:
      scope.maxCostUsd ?? source.max_cost_usd ?? pipeline.max_cost_usd ?? pipeline.max_cost_per_work_item_usd,
    budget_approved: scope.budgetApproved ? true : undefined,
    allow_unmetered: scope.allowUnmetered ? true : undefined,
    // The fork has no attempt left to prove it: the latch is carried over.
    cost_unaccounted:
      source.cost_unaccounted === true || runProvesUnpricedSpend(source) || children.unknown ? true : undefined,
    rootRunId: runId,
    budgetScopeId: runId,
    lot: source.lot ?? context.lot,
    worktree: location.worktree,
    cwd: location.cwd,
    specPath: source.specPath ?? context.config.specPath,
    forkedFrom: source.runId,
    startAt: request.startAt,
    inheritedSpendUsd: (source.inheritedSpendUsd ?? 0) + (runSpend(source).usd ?? 0) + children.usd,
    steps: forkSteps(pipeline, source, request.startAt),
  };
}

/** Write `status: SUPERSEDED` into a snapshot as it was read, every other field
 *  unchanged. */
function writeSuperseded(dir: string, snapshot: PersistedRun, supersededBy: string, context: PipelineContext): void {
  const store = new FileRunStateStore({ context, ticket: snapshot.ticket, pipeline: snapshot.pipeline });
  store.saveAt({ ...snapshot, status: "SUPERSEDED", supersededBy }, dir);
}

/** The snapshot with the attempts the fork settled in memory. */
function withSettledAttempts({ snapshot, run }: SettledSource): PersistedRun {
  const steps = new Map(run.steps.map((step) => [step.id, step]));
  return {
    ...snapshot,
    steps: snapshot.steps.map((state) => {
      const step = steps.get(state.id);
      return step ? { ...state, attempts: step.attempts, control: step.control, usage: step.usage } : state;
    }),
  };
}

/** Supersede the unfinished runs `snapshot` composed, and theirs. Their crashed
 *  attempts stay as they are: no definition is loaded for them. A child held by
 *  a live process is left alone. */
function supersedeChildren(
  snapshot: PersistedRun,
  supersededBy: string,
  context: PipelineContext,
  visited: Set<string>,
): void {
  for (const step of snapshot.steps) {
    for (const ref of step.orchestration?.children ?? []) {
      if (ref.runId === undefined) continue;
      const dir = join(pipelineRunsDir(ref.pipeline, ref.ticket, context), ref.runId);
      if (visited.has(dir)) continue;
      visited.add(dir);
      const diagnostic = readRunSnapshotDiagnostic(join(dir, STATE_FILE));
      if (diagnostic.kind !== "valid" || isFinishedStatus(diagnostic.snapshot.status)) continue;
      const claim = claimRunDir(dir);
      if (!claim.ok) {
        log.warn(`Composed run ${ref.runId} is held by another runner process: it is not superseded.`);
        continue;
      }
      try {
        writeSuperseded(dir, diagnostic.snapshot, supersededBy, context);
        appendRunEvent({ run_dir: dir, runId: ref.runId }, "run.superseded", { supersededBy });
        supersedeChildren(diagnostic.snapshot, supersededBy, context, visited);
      } finally {
        if (claim.acquired) releaseRunDir(dir);
      }
    }
  }
}

/** Close an unfinished source `SUPERSEDED` by the fork, with the attempts the
 *  fork settled, then the unfinished runs it composed. */
function supersedeRun(request: ForkRunRequest, source: SettledSource, supersededBy: string): void {
  writeSuperseded(request.sourceDir, withSettledAttempts(source), supersededBy, request.context);
  for (const { step, attempt } of source.settled) journalAttemptClosed(source.run, step, attempt);
  appendRunEvent(source.run, "run.superseded", { supersededBy });
  supersedeChildren(source.snapshot, supersededBy, request.context, new Set([request.sourceDir]));
}

/**
 * Fork the source run at `startAt` (`--start-at`): a new run keeps the status,
 * session and orchestration of every step before `startAt`, and starts that step
 * and every later one blank. It inherits what the source spent, crashed attempts
 * included, and becomes `latest`; an unfinished source is then closed
 * `SUPERSEDED`. A crash before `latest` moves leaves an orphan directory, one
 * after it a source still resumable with `--run`: neither loses spend.
 */
export function forkRun(request: ForkRunRequest): OpenedRun {
  const { sourceDir, pipeline, ticket, context } = request;
  const claim = claimRunDir(sourceDir);
  if (!claim.ok) throw heldSourceError(sourceDir);
  try {
    const source = readSource(request);
    const pipelineDir = pipelineRunsDir(pipeline.name, ticket, context);
    const dir = join(pipelineDir, allocateRunId(pipelineDir, pipeline.name));
    mkdirSync(dir, { recursive: true });
    const forkClaim = claimRunDir(dir);
    const children = unreconciledChildSpend(source.run.steps, context, new Set([sourceDir]));
    const fork = newFork(request, source.run, dir, children);
    fork.stateStore = new FileRunStateStore({ context, ticket, pipeline: pipeline.name });
    fork.eventStore = new FileRunEventStore({ runDir: dir });
    fork.logStore = new FileRunLogStore({ runDir: dir });
    try {
      saveRun(fork);
      pointLatestTo(pipelineDir, dir);
    } catch (error) {
      if (forkClaim.ok && forkClaim.acquired) releaseRunDir(dir);
      throw error;
    }
    if (!isFinishedStatus(source.snapshot.status)) supersedeRun(request, source, fork.runId as string);
    appendRunEvent(fork, "run.forked", {
      forkedFrom: fork.forkedFrom as string,
      startAt: request.startAt,
      inheritedSpendUsd: fork.inheritedSpendUsd ?? 0,
    });
    if (fork.allow_unmetered === true) journalUnmeteredAuthorization(fork);
    return { run: fork, resumed: true };
  } finally {
    if (claim.acquired) releaseRunDir(sourceDir);
  }
}
