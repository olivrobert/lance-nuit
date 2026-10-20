// runner/run-record/run-opening.ts
//
// Open the run an invocation executes: select its directory, read its snapshot,
// and either restore it — the snapshot projected with its journal, merged with
// the definition, crashed attempts settled, the fields a resume rewrites — or
// create it. Every snapshot and journal write of the opening happens here, and
// the caller learns whether it resumed instead of deriving it again.
//
// What the invocation asks for stays with its caller (`boot/resume.ts`): the
// definition a snapshot runs against, and the selection (`--steps`, `--skip`,
// `--start-at`) to apply to the steps. They come in as a policy, called at the
// one point of the opening where each applies; the caller reads the steps and
// decides, and the opening writes them.

import { basename } from "node:path";
import { DEFAULT_SPEC_PATH } from "../env/tickets.js";
import type { PipelineContext, PipelineLot } from "../model/context.js";
import type { Pipeline, PipelineStep } from "../model/definition.js";
import type { PersistedRun, PersistedStepState, PipelineLineageEntry } from "../model/persisted.js";
import type { DeepReadonly, RunView } from "../model/run.js";
import type { Run, RunStep } from "./run.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "../model/storage-ports.js";
import { log } from "../runtime/logging.js";
import { restoreRunTotals } from "./cost-accounting.js";
import { appendRunEvent, readRunEvents } from "./run-journal.js";
import { allStepsSettled } from "./run-predicates.js";
import { type ProjectedRunState, projectRunState, settleCrashedAttempts } from "./run-projection.js";
import { saveRun } from "./run-repository.js";
import { describeRunSnapshotProblem, hasRunSnapshotEntry, readRunSnapshotDiagnostic } from "./run-snapshot.js";
import { makeRunStep, type StepStateInput } from "./run-step.js";
import { awaitsFinalization } from "./run-status.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { FileRunLogStore } from "./stores/file-run-log-store.js";
import { FileRunStateStore } from "./stores/file-run-state-store.js";
import { type RunDirResolution, releaseRunDir } from "./stores/run-storage.js";

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

/** What the invocation's selection does to the steps of a resumed run. The caller
 *  decides it on the journal-reconciled states; the opening applies it, in this
 *  order, before the states become the run's steps. */
export interface ResumedSelection {
  /** Steps this invocation leaves out of work they still owe: `skipped`, and
   *  recorded as an operator exclusion. */
  readonly exclude: readonly string[];
  /** Forget the exclusions an earlier invocation persisted (reconcile mode). */
  readonly dropExclusions: boolean;
  /** Steps requeued for replay, whatever their status: `pending`, marked
   *  `replay`, and no longer excluded. */
  readonly replay: readonly string[];
}

/** What the invocation decides, called at the point of the opening where it applies. */
export interface RunOpeningPolicy {
  /** The definition a snapshot about to be resumed runs against. */
  resumeDefinition(saved: DeepReadonly<PersistedRun>): Promise<Pipeline>;
  /** The selection for a resumed run's steps, each already reconciled with the
   *  journal. A throw refuses the resume, and the run lock this opening took is
   *  released. */
  selectResumed(states: readonly DeepReadonly<PersistedStepState>[], reconcile: boolean): ResumedSelection;
  /** The initial state of one step of a new run. */
  selectNew(def: PipelineStep, reconcile: boolean): StepStateInput;
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
}

export interface OpenedRun {
  run: RunView;
  /** An existing snapshot was restored, rather than a new run created. */
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

/** Merge pipeline definition with projected persisted state to produce the in-memory Run. */
function hydrate(
  pipeline: Pipeline,
  pipelinePath: string,
  persisted: PersistedRun,
  scope: RunScope,
  projected: ProjectedRunState,
  selectionTookWork: boolean,
): Run {
  const definitionIds = new Set(pipeline.steps.map((step) => step.id));
  const removedIds = persisted.steps.map((step) => step.id).filter((id) => !definitionIds.has(id));
  if (removedIds.length > 0) {
    throw new Error(
      `Cannot resume run ${persisted.runId ?? "unknown"}: pipeline definition removed or renamed persisted step(s): ${removedIds.join(
        ", ",
      )}. Restore those step IDs or start a fresh run.`,
    );
  }
  const steps: RunStep[] = pipeline.steps.map((def) => {
    const state = projected.steps.get(def.id);
    return makeRunStep(def, {
      ...state?.state,
      // The journal owns the attempts; resume projects them from it.
      attempts: state?.attempts,
    });
  });
  const allSettled = allStepsSettled(steps);
  // A settled snapshot that never received a verdict is not terminal, it is a
  // run that still owes a `finalizeRun`: RUNNING is a crash in that window, and
  // ABORTED with no step left in flight is a SIGINT in the same window. Loading
  // either as terminal strands it — the parent of a child run then fails on
  // every resume, and a top-level run replays from scratch in a new directory.
  // A selection that took out the work a STOPPED or FAIL run still owed settles
  // it now: the verdict on disk judged that work, so it cannot stand for the run
  // the selection leaves. Loaded as terminal, `--skip` of the step it ended on
  // would change nothing and leave a run no later invocation resumes.
  const awaitingVerdict = allSettled && (selectionTookWork || awaitsFinalization(persisted));
  const terminal = persisted.status !== undefined && allSettled && !awaitingVerdict;
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
    // Materialized totals belong to the previous finalized generation: trusted on
    // a terminal snapshot, derived from the steps on a live resume. Cost
    // accounting owns the rule; this is where the `terminal` fact is known.
    ...restoreRunTotals(persisted, terminal),
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
function applyUnmeteredAuthorization(run: Run, persisted: PersistedRun, scope: RunScope): void {
  if (scope.allowUnmetered !== true || run.allow_unmetered === true) return;
  const resumedDirectly = scope.parentRunId === undefined && persisted.parentRunId !== undefined;
  if (resumedDirectly && run.max_cost_usd !== undefined) {
    log.warn(
      `--allow-unmetered ignored for run ${run.runId}: it is a composed child of ${persisted.parentRunId} and ` +
        `answers to budget scope ${run.budgetScopeId ?? "unknown"}. Authorize the run that owns that scope; the ` +
        `authorization propagates to its children.`,
    );
    return;
  }
  run.allow_unmetered = true;
  appendRunEvent(run, "run.unmetered.authorized", {
    budgetScopeId: run.budgetScopeId ?? null,
    maxCostUsd: run.max_cost_usd ?? null,
  });
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

/** Apply the invocation's selection to the reconciled states; returns whether it
 *  took out work the run still owed. */
function applySelection(states: readonly PersistedStepState[], selection: ResumedSelection): boolean {
  const exclude = new Set(selection.exclude);
  const replay = new Set(selection.replay);
  let tookWork = false;
  for (const state of states) {
    if (!exclude.has(state.id)) continue;
    state.status = "skipped";
    state.excluded = true;
    tookWork = true;
  }
  if (selection.dropExclusions) for (const state of states) delete state.excluded;
  for (const state of states) {
    if (!replay.has(state.id)) continue;
    state.status = "pending";
    state.replay = true;
    delete state.excluded;
  }
  return tookWork;
}

/** Restore a snapshot: project it with its journal, apply the invocation's
 *  selection, merge it with the definition, then record what this opening
 *  changed — a new authorization, the crashed attempts it settled, its location
 *  — and, for a run that goes on, the resume. */
async function restore(request: OpenRunRequest, selected: SelectedDirectory, saved: PersistedRun): Promise<Run> {
  const { dir, eventStore } = selected;
  const { policy, scope, location } = request;
  const pipeline = await policy.resumeDefinition(saved);
  seedNewDefinitionSteps(pipeline, saved);
  const projected = projectRunState(saved, readRunEvents({ run_dir: dir, runId: saved.runId, eventStore }));
  const states = [...projected.steps.values()].flatMap((step) => (step.state ? [step.state] : []));
  const reconcile = pipeline.reconcile === true;
  let selection: ResumedSelection;
  try {
    selection = policy.selectResumed(states, reconcile);
  } catch (error) {
    selected.releaseLock();
    throw error;
  }
  const selectionTookWork = applySelection(states, selection);
  const run = hydrate(pipeline, request.pipelinePath, saved, scope, projected, selectionTookWork);
  run.reconcile = reconcile;
  run.run_dir = dir;
  run.stateStore = selected.stateStore;
  run.eventStore = eventStore;
  run.logStore = selected.logStore;
  if (saved.schemaVersion === 1) run.runId ??= basename(dir);
  // A resume may run from another place than the invocation that created the
  // run (main clone instead of worktree, or the reverse): record where this one
  // runs, since that is where it will read and write from now on.
  const moved = run.worktree !== location.worktree || run.cwd !== location.cwd;
  run.worktree = location.worktree;
  run.cwd = location.cwd;
  const authorizedNow = run.allow_unmetered !== true && scope.allowUnmetered === true;
  applyUnmeteredAuthorization(run, saved, scope);
  if (settleCrashedAttempts(run) || moved || (authorizedNow && run.allow_unmetered === true)) saveRun(run);
  if (run.status === "RUNNING") {
    appendRunEvent(run, "run.resumed", { pipeline: run.pipeline });
    saveRun(run);
  }
  return run;
}

/** Create a run in the selected directory, persist it, then journal its start. */
function create(request: OpenRunRequest, selected: SelectedDirectory): Run {
  const { pipeline, scope, location, context } = request;
  const { dir } = selected;
  const runId = basename(dir);
  const reconcile = pipeline.reconcile === true;
  const run: Run = {
    schemaVersion: 1,
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
    reconcile,
    stateStore: selected.stateStore,
    eventStore: selected.eventStore,
    logStore: selected.logStore,
    steps: pipeline.steps.map((def) => makeRunStep(def, request.policy.selectNew(def, reconcile))),
  };

  saveRun(run);
  appendRunEvent(run, "run.started", { pipeline: run.pipeline, ticket: run.ticket ?? null });
  if (run.allow_unmetered === true) {
    appendRunEvent(run, "run.unmetered.authorized", {
      budgetScopeId: run.budgetScopeId ?? null,
      maxCostUsd: run.max_cost_usd ?? null,
    });
  }
  return run;
}

/** Open the run this invocation executes: the snapshot it selects, restored, or
 *  a new run. */
export async function openRun(request: OpenRunRequest): Promise<OpenedRun> {
  const selected = selectDirectory(request);
  const { saved } = selected;
  if (saved?.schemaVersion === 1 && typeof saved.runId === "string" && Array.isArray(saved.steps)) {
    return { run: await restore(request, selected, saved), resumed: true };
  }
  return { run: create(request, selected), resumed: false };
}
