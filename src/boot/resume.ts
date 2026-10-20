// runner/boot/resume.ts
//
// Build or resume a run: load the definition, validate `--start-at`, and apply
// this invocation's selection. Opening the run itself — selecting its directory,
// restoring or creating it, and every write that does — is `run-record`'s
// (`openRun`); boot hands it the definition and the selection as a policy.

import { DEFAULT_SPEC_PATH } from "../env/tickets.js";
import { agentBackendRegistryOf, type PipelineContext, workItemRegistryOf } from "../model/context.js";
import type { PipelineStep } from "../model/definition.js";
import type { PersistedStepState } from "../model/persisted.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "../model/storage-ports.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import {
  isChildSettled,
  matchesStepSelector,
  type OpenedRun,
  openRun,
  owesWork,
  type RunScope,
  type StrictSnapshotRead,
} from "../run-record/index.js";

export interface LoadOrCreateRunOptions extends RunScope {
  pipelinePath: string;
  ticket?: string;
  /** `--steps`: the steps this invocation runs. */
  stepFilter?: string[];
  /** `--skip`: the steps this invocation leaves out. */
  skipFilter?: string[];
  /** The run directory the invocation names (`--run`, or a composed child's own). */
  runDir?: string;
  fresh?: boolean;
  /** `--start-at`: requeue this step and every later one, skip the earlier ones. */
  startAt?: string;
  context?: PipelineContext;
  /** Whether this invocation runs inside a worktree: the entry point passes its
   *  boot's answer, a composed child its parent's. */
  worktree?: boolean;
  stateStore?: RunStateStore;
  eventStore?: RunEventStore;
  logStore?: RunLogStore;
  /** An explicit selector was validated before boot. Re-read it immediately
   * before hydration so a deletion or corruption race cannot initialize a run. */
  strictSnapshot?: StrictSnapshotRead;
}

/** Apply resume selectors in one pass; both selectors operate only on steps that
 * still have executable work, preserving terminal history on a resumed run.
 * Returns whether they took any of that work out.
 *
 * The steps must already be reconciled with the journal: a step the snapshot
 * still calls `running` may be one the journal knows finished, and a selector
 * applied to the snapshot would turn that finished work into an exclusion. */
function applyStepFilters(
  steps: readonly PersistedStepState[],
  stepFilter: string[] | undefined,
  skipFilter: string[] | undefined,
): boolean {
  let tookWork = false;
  for (const state of steps) {
    if (!owesWork(state.status)) continue;
    const outsideSelection =
      stepFilter !== undefined && !stepFilter.some((selector) => matchesStepSelector(state.id, selector));
    const explicitlySkipped = skipFilter?.some((selector) => matchesStepSelector(state.id, selector)) ?? false;
    if (outsideSelection || explicitlySkipped) {
      state.status = "skipped";
      state.excluded = true;
      tookWork = true;
    }
  }
  return tookWork;
}

/** Reconcile mode persists no exclusion: the loop applies this invocation's
 * selectors (`step/step-loop.ts`), so one an earlier legacy invocation left in
 * the snapshot is dropped instead of binding every later invocation. */
function dropPersistedExclusions(steps: readonly PersistedStepState[]): void {
  for (const state of steps) delete state.excluded;
}

/** Composed steps in the replay range that cannot run again in place: a child
 * already settled returns at once on the next pass, so the node would turn
 * `done` without running anything. */
function unreplayableSteps(steps: readonly PersistedStepState[], replayIds: ReadonlySet<string>): string[] {
  return steps
    .filter((state) => replayIds.has(state.id) && (state.orchestration?.children.some(isChildSettled) ?? false))
    .map((state) => state.id);
}

/** Requeue the steps `--start-at` names for replay, whatever their status.
 *
 * Naming the target is the operator's newest decision, so it also lifts an
 * exclusion an earlier selection left inside the range. Attempts, retries and
 * spend are kept: the budget ledger seeds from them, and the replay is more work
 * on the same run, not a new one. `replay` is what keeps the requeue durable
 * over the `done` events the journal holds for the earlier pass. */
function requeueForReplay(steps: readonly PersistedStepState[], replayIds: ReadonlySet<string>): void {
  for (const state of steps) {
    if (!replayIds.has(state.id)) continue;
    state.status = "pending";
    state.replay = true;
    delete state.excluded;
  }
}

/** Whether a step is left out of a new run by `--steps` or `--skip`. */
function excludedFromNewRun(def: PipelineStep, stepFilter?: string[], skipFilter?: string[]): boolean {
  return (
    (stepFilter !== undefined && !stepFilter.some((selector) => matchesStepSelector(def.id, selector))) ||
    (skipFilter?.some((selector) => matchesStepSelector(def.id, selector)) ?? false)
  );
}

/** Open the run this invocation executes, with its definition and selection. */
export async function loadOrCreateRun(options: LoadOrCreateRunOptions): Promise<OpenedRun> {
  const {
    pipelinePath,
    ticket,
    stepFilter,
    skipFilter: skipSelectors,
    runDir,
    fresh,
    startAt,
    context,
    worktree,
    stateStore,
    eventStore,
    logStore,
    strictSnapshot,
    ...scope
  } = options;
  let skipFilter = skipSelectors;
  const buildContext = context ?? buildPipelineContext({ ticket });
  const pipeline = await loadPipelineDefinition(pipelinePath, buildContext);

  // --start-at makes preceding steps effective skips, and requeues the target
  // and every later step even when an earlier pass finished them.
  let replayIds: ReadonlySet<string> = new Set();
  if (startAt) {
    const ids = pipeline.steps.map((step) => step.id);
    const cut = ids.indexOf(startAt);
    if (cut < 0) {
      throw new Error(
        `--start-at: step "${startAt}" not found in pipeline "${pipeline.name}" (steps: ${ids.join(", ")}).`,
      );
    }
    skipFilter = ids.slice(0, cut);
    replayIds = new Set(ids.slice(cut));
  }

  return openRun({
    pipeline,
    pipelinePath,
    ticket,
    runDir,
    fresh,
    context: buildContext,
    // Where this invocation actually reads artifacts and writes decisions. The
    // worktree boot step has already chdir'd, so the context cwd is the effective
    // one; a reader outside the runner cannot infer it from the run directory.
    location: { worktree: worktree ?? false, cwd: buildContext.cwd },
    scope,
    stateStore,
    eventStore,
    logStore,
    strictSnapshot,
    policy: {
      resumeDefinition: (saved) =>
        loadPipelineDefinition(
          pipelinePath,
          buildPipelineContext({
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
          }),
        ),
      // Filters apply to every still-executable step, including failed and running
      // state restored from a previous attempt, and the definition steps the
      // snapshot does not know yet. They and the requeue read the journal-reconciled
      // states, which are the ones hydration consumes.
      selectResumed: (states, reconcile) => {
        const selectionTookWork = !reconcile && applyStepFilters(states, stepFilter, skipFilter);
        if (reconcile) dropPersistedExclusions(states);
        const unreplayable = unreplayableSteps(states, replayIds);
        if (unreplayable.length > 0) {
          throw new Error(
            `--start-at: step "${unreplayable[0]}" composes pipelines whose children already settled and cannot be ` +
              `replayed in place. Use --fresh to start a new run.`,
          );
        }
        requeueForReplay(states, replayIds);
        return selectionTookWork;
      },
      // Reconcile mode leaves the selection to the loop: it lasts this invocation only.
      selectNew: (def, reconcile) => {
        if (!reconcile && excludedFromNewRun(def, stepFilter, skipFilter)) return { status: "skipped", excluded: true };
        return replayIds.has(def.id) ? { status: "pending", replay: true } : { status: "pending" };
      },
    },
  });
}
