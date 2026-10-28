// runner/boot/resume.ts
//
// Build or resume a run: load the definition, validate `--start-at`, and decide
// this invocation's selection. Opening the run itself — selecting its directory,
// restoring or creating it, applying the selection, and every write that does —
// is `run-record`'s (`openRun`); boot hands it the definition and the selection
// as a policy, and only reads the steps it decides on.

import { DEFAULT_SPEC_PATH } from "../env/tickets.js";
import { agentBackendRegistryOf, type PipelineContext, workItemRegistryOf } from "../model/context.js";
import type { PipelineStep } from "../model/definition.js";
import type { PersistedStepState } from "../model/persisted.js";
import type { DeepReadonly } from "../model/run.js";
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
   *  boot's answer, a composed child its parent's. Required, so that a caller
   *  cannot record a run as outside a worktree by forgetting it. */
  worktree: boolean;
  stateStore?: RunStateStore;
  eventStore?: RunEventStore;
  logStore?: RunLogStore;
  /** An explicit selector was validated before boot. Re-read it immediately
   * before hydration so a deletion or corruption race cannot initialize a run. */
  strictSnapshot?: StrictSnapshotRead;
}

type StepState = DeepReadonly<PersistedStepState>;

/** The steps the resume selectors leave out. Both selectors operate only on steps
 * that still have executable work, preserving terminal history on a resumed run.
 *
 * The steps must already be reconciled with the journal: a step the snapshot
 * still calls `running` may be one the journal knows finished, and a selector
 * applied to the snapshot would turn that finished work into an exclusion. */
function excludedSteps(
  steps: readonly StepState[],
  stepFilter: string[] | undefined,
  skipFilter: string[] | undefined,
): string[] {
  return steps
    .filter((state) => {
      if (!owesWork(state.status)) return false;
      const outsideSelection =
        stepFilter !== undefined && !stepFilter.some((selector) => matchesStepSelector(state.id, selector));
      const explicitlySkipped = skipFilter?.some((selector) => matchesStepSelector(state.id, selector)) ?? false;
      return outsideSelection || explicitlySkipped;
    })
    .map((state) => state.id);
}

/** Composed steps in the replay range that cannot run again in place: a child
 * already settled returns at once on the next pass, so the node would turn
 * `done` without running anything. */
function unreplayableSteps(steps: readonly StepState[], replayIds: ReadonlySet<string>): string[] {
  return steps
    .filter((state) => replayIds.has(state.id) && (state.orchestration?.children.some(isChildSettled) ?? false))
    .map((state) => state.id);
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
    location: { worktree, cwd: buildContext.cwd },
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
            worktree: buildContext.worktree,
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
        const unreplayable = unreplayableSteps(states, replayIds);
        if (unreplayable.length > 0) {
          throw new Error(
            `--start-at: step "${unreplayable[0]}" composes pipelines whose children already settled and cannot be ` +
              `replayed in place. Use --fresh to start a new run.`,
          );
        }
        return {
          exclude: reconcile ? [] : excludedSteps(states, stepFilter, skipFilter),
          // Reconcile mode persists no exclusion: the loop applies this
          // invocation's selectors (`step/step-loop.ts`), so one an earlier legacy
          // invocation left in the snapshot is dropped instead of binding every
          // later invocation.
          dropExclusions: reconcile,
          // `--start-at` is the operator's newest decision, so the requeue also
          // lifts an exclusion an earlier selection left inside the range.
          // Attempts, retries and spend are kept: the budget ledger seeds from
          // them, and the replay is more work on the same run, not a new one.
          // `replay` is what keeps the requeue durable over the `done` events the
          // journal holds for the earlier pass.
          replay: [...replayIds],
        };
      },
      // Reconcile mode leaves the selection to the loop: it lasts this invocation only.
      selectNew: (def, reconcile) => {
        if (!reconcile && excludedFromNewRun(def, stepFilter, skipFilter)) return { status: "skipped", excluded: true };
        return replayIds.has(def.id) ? { status: "pending", replay: true } : { status: "pending" };
      },
    },
  });
}
