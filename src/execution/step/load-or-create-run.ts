//
// Build or resume a run: load the definition, validate `--start-at`, and decide
// this invocation's selection. Opening the run itself — selecting its directory,
// restoring or creating it, applying the selection, and every write that does —
// is `run-record`'s (`openRun`); this file hands it the definition and the
// selection as a policy, and only reads the steps it decides on.
//
// It lives with the step loop because a composed child opens its run here too:
// from `boot/`, execution would have to reach back into startup.

import { DEFAULT_SPEC_PATH } from "../../shared/env/tickets.js";
import { agentBackendRegistryOf, type PipelineContext, workItemRegistryOf } from "../../shared/language/context.js";
import type { PersistedStepState, DeepReadonly, RunEventStore, RunLogStore, RunStateStore } from "../../run/index.js";
import { buildPipelineContext, loadPipelineDefinition } from "../../definition/index.js";
import { isChildSettled, type OpenedRun, openRun, type RunScope, type StrictSnapshotRead } from "../../run/index.js";

export interface LoadOrCreateRunOptions extends RunScope {
  pipelinePath: string;
  ticket?: string;
  /** The run directory the invocation names (`--run`, or a composed child's own). */
  runDir?: string;
  fresh?: boolean;
  /** `--start-at`: requeue this step and every later one. */
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

/** Composed steps in the replay range that cannot run again in place: a child
 * already settled returns at once on the next pass, so the node would turn
 * `done` without running anything. */
function unreplayableSteps(steps: readonly StepState[], replayIds: ReadonlySet<string>): string[] {
  return steps
    .filter((state) => replayIds.has(state.id) && (state.orchestration?.children.some(isChildSettled) ?? false))
    .map((state) => state.id);
}

/** Open the run this invocation executes, with its definition and selection. */
export async function loadOrCreateRun(options: LoadOrCreateRunOptions): Promise<OpenedRun> {
  const {
    pipelinePath,
    ticket,
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
  const buildContext = context ?? buildPipelineContext({ ticket });
  const pipeline = await loadPipelineDefinition(pipelinePath, buildContext);

  // --start-at requeues the target and every later step even when an earlier
  // pass finished them; the loop leaves out the preceding steps still owing work.
  let replayIds: ReadonlySet<string> = new Set();
  if (startAt) {
    const ids = pipeline.steps.map((step) => step.id);
    const cut = ids.indexOf(startAt);
    if (cut < 0) {
      throw new Error(
        `--start-at: step "${startAt}" not found in pipeline "${pipeline.name}" (steps: ${ids.join(", ")}).`,
      );
    }
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
      // The requeue reads the journal-reconciled states, which are the ones
      // hydration consumes.
      selectResumed: (states) => {
        const unreplayable = unreplayableSteps(states, replayIds);
        if (unreplayable.length > 0) {
          throw new Error(
            `--start-at: step "${unreplayable[0]}" composes pipelines whose children already settled and cannot be ` +
              `replayed in place. Use --fresh to start a new run.`,
          );
        }
        return {
          // Attempts, retries and spend are kept: the budget ledger seeds from
          // them, and the replay is more work on the same run, not a new one.
          // `replay` is what keeps the requeue durable over the `done` events the
          // journal holds for the earlier pass.
          replay: [...replayIds],
        };
      },
      selectNew: (def) => (replayIds.has(def.id) ? { status: "pending", replay: true } : { status: "pending" }),
    },
  });
}
