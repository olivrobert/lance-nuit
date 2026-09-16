// runner/boot/resume.ts
//
// Build or resume a run: load the definition, apply filters, merge it with the
// state `state/run-projection.ts` read from storage, and create the initial
// snapshot. Resume is a boot concern: `state/` only reads, projects and
// reconciles, it does not know how to turn a definition into a run.

import { basename } from "node:path";
import {
  agentBackendRegistryOf,
  type PipelineContext,
  type PipelineLot,
  workItemRegistryOf,
} from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import type { PersistedRun, PersistedStepState, PipelineLineageEntry } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "../model/storage-ports.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { log } from "../runtime/logging.js";
import { restoreRunTotals } from "../state/cost-accounting.js";
import { appendRunEvent, readRunEvents } from "../state/run-journal.js";
import { allStepsSettled } from "../state/run-predicates.js";
import { type ProjectedRunState, projectRunState, settleCrashedAttempts } from "../state/run-projection.js";
import { saveRun } from "../state/run-repository.js";
import { matchesStepSelector } from "../state/run-timeline.js";
import { FileRunEventStore } from "../state/stores/file-run-event-store.js";
import { FileRunLogStore } from "../state/stores/file-run-log-store.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import { DEFAULT_SPEC_PATH, releaseRunDir, type RunDirResolution } from "../state/stores/run-storage.js";
import { describeRunSnapshotProblem, hasRunSnapshotEntry, readRunSnapshotDiagnostic } from "../state/run-snapshot.js";
import { makeRunStep } from "../state/run-step.js";

export interface LoadOrCreateRunOptions {
  stateStore?: RunStateStore;
  eventStore?: RunEventStore;
  logStore?: RunLogStore;
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
  /** Whether this invocation runs inside a worktree. Defaults to the environment
   *  flag the worktree boot step sets after its `chdir`. */
  worktree?: boolean;
  /** An explicit selector was validated before boot. Re-read it immediately
   * before hydration so a deletion or corruption race cannot initialize a run. */
  strictSnapshot?: {
    path: string;
    releaseRunLock: boolean;
    expectedIdentity?: { runId: string; pipeline: string; ticket?: string };
  };
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
  options: LoadOrCreateRunOptions,
  projected: ProjectedRunState,
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
  const awaitingVerdict =
    allSettled &&
    (persisted.status === "RUNNING" || (persisted.status === "ABORTED" && persisted.outcome?.resumable !== false));
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
    // run already in flight. `options.maxCostUsd` is the one deliberate override —
    // an orchestration ceiling, or `--budget` approving an overrun.
    max_cost_usd:
      options.maxCostUsd ?? persisted.max_cost_usd ?? pipeline.max_cost_usd ?? pipeline.max_cost_per_work_item_usd,
    parentRunId: persisted.parentRunId ?? options.parentRunId,
    parentNodeId: persisted.parentNodeId ?? options.parentNodeId,
    rootRunId: persisted.rootRunId ?? options.rootRunId ?? persisted.runId,
    budgetScopeId: persisted.budgetScopeId ?? options.budgetScopeId ?? persisted.rootRunId ?? persisted.runId,
    lot: persisted.lot ?? options.lot,
    pipelineLineage: persisted.pipelineLineage ?? options.pipelineLineage,
    // Where the PREVIOUS invocation ran. The caller overwrites both with its own
    // location, and compares them to decide whether the snapshot must be rewritten.
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
    budget_exceeded: options.maxCostUsd !== undefined ? undefined : persisted.budget_exceeded,
    // Approval is durable: a later resume without `--budget` must not re-pin the
    // children to the caps the approval already lifted.
    budget_approved: options.budgetApproved || persisted.budget_approved || undefined,
    // Latched, and deliberately NOT conditioned on `options.maxCostUsd`: raising
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
 * propagates it to every child it launches (`allowUnmetered` in the child's boot
 * options). A composed child resumed directly is therefore not allowed to grant
 * itself what its scope withheld — its ceiling was capped by an ancestor and,
 * once persisted, the child cannot tell that ceiling from one it declared itself.
 * A capped child refuses and names the run to authorize instead; an uncapped one
 * has no strict policy to weaken and takes the flag.
 */
function applyUnmeteredAuthorization(run: Run, persisted: PersistedRun, options: LoadOrCreateRunOptions): void {
  if (options.allowUnmetered !== true || run.allow_unmetered === true) return;
  const resumedDirectly = options.parentRunId === undefined && persisted.parentRunId !== undefined;
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

/** Apply resume selectors in one pass; both selectors operate only on steps that
 * still have executable work, preserving terminal history on a resumed run. */
function applyStepFilters(
  steps: PersistedStepState[],
  stepFilter: string[] | undefined,
  skipFilter: string[] | undefined,
): void {
  // `aborted` belongs here with `running`: an interrupted step is replayed on
  // resume, so it still has executable work and a selector must be able to take
  // it out of the selection. Leaving it out let `--step c` run the interrupted
  // `b` anyway.
  const filterable = (state: PersistedStepState) =>
    state.status === "pending" || state.status === "failed" || state.status === "running" || state.status === "aborted";
  for (const state of steps) {
    if (!filterable(state)) continue;
    const outsideSelection =
      stepFilter !== undefined && !stepFilter.some((selector) => matchesStepSelector(state.id, selector));
    const explicitlySkipped = skipFilter?.some((selector) => matchesStepSelector(state.id, selector)) ?? false;
    if (outsideSelection || explicitlySkipped) {
      state.status = "skipped";
      state.excluded = true;
    }
  }
}

/** Give the snapshot a pending entry for every definition step it never recorded.
 * A step added to the pipeline since the last invocation has no persisted state,
 * so the selectors would never see it and hydration would default it to `pending`:
 * `--step a` would run the new step too. Seeded here, it goes through
 * `applyStepFilters` like any other step that still owes work. */
function seedNewDefinitionSteps(pipeline: Pipeline, saved: PersistedRun): void {
  const persistedIds = new Set(saved.steps.map((state) => state.id));
  for (const def of pipeline.steps) {
    if (persistedIds.has(def.id)) continue;
    saved.steps.push({ id: def.id, status: "pending", retries: 0 });
  }
}

export async function loadOrCreateRun(
  pipelinePath: string,
  ticket?: string,
  stepFilter?: string[],
  skipFilter?: string[],
  explicitRunDir?: string,
  fresh?: boolean,
  startAt?: string,
  context?: PipelineContext,
  options: LoadOrCreateRunOptions = {},
): Promise<Run> {
  const buildContext = context ?? buildPipelineContext({ ticket });
  // Where this invocation actually reads artifacts and writes decisions. The
  // worktree boot step has already chdir'd, so the context cwd is the effective
  // one; a reader outside the runner cannot infer it from the run directory.
  const location = {
    worktree: options.worktree ?? process.env.RUNNER_IN_WORKTREE === "1",
    cwd: buildContext.cwd,
  };
  let pipeline = await loadPipelineDefinition(pipelinePath, buildContext);
  const fallbackStore = new FileRunStateStore({ context: buildContext, ticket, pipeline: pipeline.name });
  const stateStore = options.stateStore ?? fallbackStore;

  // --start-at makes preceding steps effective skips.
  if (startAt) {
    const ids = pipeline.steps.map((step) => step.id);
    const cut = ids.indexOf(startAt);
    if (cut < 0) {
      throw new Error(
        `--start-at: step "${startAt}" not found in pipeline "${pipeline.name}" (steps: ${ids.join(", ")}).`,
      );
    }
    skipFilter = ids.slice(0, cut);
  }

  // A strict explicit selection already has a concrete directory and snapshot
  // path. The ordinary explicit-dir resolver creates missing directories, which
  // would turn a post-selection deletion into a fresh run.
  const strictExplicitSelection = explicitRunDir !== undefined && options.strictSnapshot !== undefined;
  const resolution = strictExplicitSelection
    ? undefined
    : (stateStore as SelectionResolvingStore).resolveRunDirSelection?.(
        pipeline.name,
        ticket,
        explicitRunDir,
        fresh,
        buildContext,
      );
  const dir =
    (strictExplicitSelection ? explicitRunDir : undefined) ??
    resolution?.dir ??
    stateStore.resolveRunDir?.(pipeline.name, ticket, explicitRunDir, fresh, buildContext) ??
    // A required-only adapter owns the authoritative snapshot but has no local
    // selector. Its compatibility scratch directory must not inspect or adopt
    // the filesystem's unrelated `latest` link.
    fallbackStore.resolveRunDir(
      pipeline.name,
      ticket,
      explicitRunDir,
      stateStore === fallbackStore ? fresh : true,
      buildContext,
    );
  const eventStore = options.eventStore ?? new FileRunEventStore({ runDir: dir });
  const logStore = options.logStore ?? new FileRunLogStore({ runDir: dir });

  // Resume a valid snapshot; otherwise create a new run.
  const existingExplicitSnapshot = explicitRunDir !== undefined && hasRunSnapshotEntry(fallbackStore.pathFor(dir));
  const strictPath =
    options.strictSnapshot?.path ??
    (resolution?.selectedSnapshot || existingExplicitSnapshot ? fallbackStore.pathFor(dir) : undefined);
  const saved = strictPath
    ? (() => {
        const diagnostic = readRunSnapshotDiagnostic(strictPath);
        if (diagnostic.kind !== "valid") {
          if (resolution?.acquiredRunLock || options.strictSnapshot?.releaseRunLock) releaseRunDir(dir);
          throw strictSnapshotError(diagnostic);
        }
        const expected = options.strictSnapshot?.expectedIdentity;
        if (
          expected &&
          (diagnostic.snapshot.runId !== expected.runId ||
            diagnostic.snapshot.pipeline !== expected.pipeline ||
            diagnostic.snapshot.ticket !== expected.ticket)
        ) {
          if (resolution?.acquiredRunLock || options.strictSnapshot?.releaseRunLock) releaseRunDir(dir);
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
  if (saved?.schemaVersion === 1 && typeof saved.runId === "string" && Array.isArray(saved.steps)) {
    const resumeContext = buildPipelineContext({
      cwd: buildContext.cwd,
      ticket,
      baseBranch: buildContext.baseBranch,
      runnerBin: buildContext.runnerBin,
      runnerDir: buildContext.runnerDir,
      config: { ...buildContext.config, specPath: saved.specPath ?? DEFAULT_SPEC_PATH },
      lot: saved.lot ?? buildContext.lot,
      // Registries are composition, not configuration: a resumed run must load its
      // definition against the same providers as the original one.
      workItemRegistry: workItemRegistryOf(buildContext),
      agentBackendRegistry: agentBackendRegistryOf(buildContext),
    });
    pipeline = await loadPipelineDefinition(pipelinePath, resumeContext);
    // Filters apply to every still-executable step, including failed and running
    // state restored from a previous attempt, and the definition steps the
    // snapshot does not know yet.
    seedNewDefinitionSteps(pipeline, saved);
    applyStepFilters(saved.steps, stepFilter, skipFilter);
    const projected = projectRunState(saved, readRunEvents({ run_dir: dir, runId: saved.runId, eventStore }));
    const run = hydrate(pipeline, pipelinePath, saved, options, projected);
    run.run_dir = dir;
    run.stateStore = stateStore;
    run.eventStore = eventStore;
    run.logStore = logStore;
    if (saved.schemaVersion === 1) run.runId ??= basename(dir);
    // A resume may run from another place than the invocation that created the
    // run (main clone instead of worktree, or the reverse): record where this one
    // runs, since that is where it will read and write from now on.
    const moved = run.worktree !== location.worktree || run.cwd !== location.cwd;
    run.worktree = location.worktree;
    run.cwd = location.cwd;
    const authorizedNow = run.allow_unmetered !== true && options.allowUnmetered === true;
    applyUnmeteredAuthorization(run, saved, options);
    if (settleCrashedAttempts(run) || moved || (authorizedNow && run.allow_unmetered === true)) saveRun(run);
    if (run.status === "RUNNING") {
      appendRunEvent(run, "run.resumed", { pipeline: run.pipeline });
      saveRun(run);
    }
    return run;
  }

  const runId = basename(dir);
  const run: Run = {
    schemaVersion: 1,
    runId,
    name: pipeline.name,
    ticket,
    pipeline: pipeline.name,
    pipeline_path: pipelinePath,
    run_dir: dir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "RUNNING",
    max_cost_usd: options.maxCostUsd ?? pipeline.max_cost_usd ?? pipeline.max_cost_per_work_item_usd,
    parentRunId: options.parentRunId,
    // A fresh top-level run has no overrun to approve: `--budget` only sets its
    // ceiling. A fresh child inherits its parent's approval so its own children
    // are lifted the same way.
    budget_approved: options.budgetApproved && options.parentRunId !== undefined ? true : undefined,
    // A fresh run starts with no accounting history, so there is nothing to
    // inherit from the run it replaces: only this invocation's flag — or the
    // authorization its parent propagates — can authorize it.
    allow_unmetered: options.allowUnmetered ? true : undefined,
    parentNodeId: options.parentNodeId,
    rootRunId: options.rootRunId ?? runId,
    budgetScopeId: options.budgetScopeId ?? runId,
    lot: buildContext.lot,
    pipelineLineage: options.pipelineLineage,
    worktree: location.worktree,
    cwd: location.cwd,
    specPath: buildContext.config.specPath,
    stateStore,
    eventStore,
    logStore,
    steps: pipeline.steps.map((def) => {
      const excluded =
        (stepFilter && !stepFilter.some((selector) => matchesStepSelector(def.id, selector))) ||
        (skipFilter?.some((selector) => matchesStepSelector(def.id, selector)) ?? false);
      return makeRunStep(def, excluded ? { status: "skipped", excluded: true } : { status: "pending" });
    }),
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
