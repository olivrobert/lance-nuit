//
// Build, resume or fork a run: load the definition and decide what this
// invocation opens. Opening the run itself — selecting its directory, restoring,
// creating or forking it, and every write that does — is `run-record`'s
// (`openRun`, `forkRun`); this file hands it the definition as a policy, and
// owns the rule that decides whether a run may be forked (`checkForkSource`).
//
// It lives with the step loop because a composed child opens its run here too:
// from `boot/`, execution would have to reach back into startup.

import { DEFAULT_SPEC_PATH } from "../../shared/env/tickets.js";
import { agentBackendRegistryOf, type PipelineContext, workItemRegistryOf } from "../../shared/language/context.js";
import type { ForkSource, InvocationSelection, RunEventStore, RunLogStore, RunStateStore } from "../../run/index.js";
import { buildPipelineContext, isStamped, loadPipelineDefinition, type Pipeline } from "../../definition/index.js";
import {
  forkRun,
  isSettledStatus,
  type OpenedRun,
  openRun,
  type RunScope,
  type StrictSnapshotRead,
} from "../../run/index.js";
import { stampKey, stepFreshness } from "../../work-items/index.js";

export interface LoadOrCreateRunOptions extends RunScope {
  pipelinePath: string;
  ticket?: string;
  /** The run directory the invocation names (`--run`, or a composed child's own). */
  runDir?: string;
  fresh?: boolean;
  /** `--start-at`: fork `forkSource` at this step instead of opening a run. */
  startAt?: string;
  /** The run `--start-at` forks, selected and checked before any write. */
  forkSource?: ForkSource;
  /** This invocation's selectors, journaled with a resume. */
  selection?: InvocationSelection;
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

/**
 * Why the source cannot be forked at `startAt`, one line per offending step;
 * empty when it can. Read-only, so a refusal leaves no decision, no run
 * directory and the source untouched.
 *
 * Every step before `startAt` must be settled: the fork keeps it as it is. A
 * stamped one with a stamp must still be fresh on its artifacts, a `done` one
 * must have a stamp unless it is non-blocking (an absorbed failure leaves none),
 * and a `skipped` one without a stamp must declare the `when` that skipped it:
 * the fork never runs it again, so its outputs must still be the ones its
 * inputs produced. Sources are not compared, so a hand edit of
 * the code tree, which is what a fork usually follows, blocks nothing.
 */
export async function checkForkSource(
  pipeline: Pipeline,
  source: ForkSource,
  startAt: string,
  ctx: PipelineContext,
): Promise<string[]> {
  const sourceStepId = pipeline.work_item_source?.step_id;
  const states = new Map(source.snapshot.steps.map((state) => [state.id, state]));
  const definitionIds = new Set(pipeline.steps.map((step) => step.id));
  const problems = source.snapshot.steps
    .filter((state) => !definitionIds.has(state.id))
    .map((state) => `step "${state.id}" of run ${source.snapshot.runId} is no longer in the pipeline`);
  const cut = pipeline.steps.findIndex((step) => step.id === startAt);
  const lot = source.snapshot.lot ?? ctx.lot;
  for (const step of pipeline.steps.slice(0, Math.max(cut, 0))) {
    const status = states.get(step.id)?.status ?? "pending";
    if (!isSettledStatus(status)) {
      problems.push(`step "${step.id}" is ${status}: every step before "${startAt}" must be done or skipped`);
      continue;
    }
    if (!isStamped(step, sourceStepId) || !ctx.paths.workItemDir) continue;
    const freshness = await stepFreshness(ctx, step, stampKey(step.id, lot), { artifactsOnly: true });
    if (freshness.value === "stale") {
      problems.push(`step "${step.id}" is stale: its artifacts changed since it succeeded`);
    } else if (freshness.value === "none" && status === "done" && step.blocking !== false) {
      problems.push(`step "${step.id}" is done but has no stamp in the freshness lock`);
    } else if (freshness.value === "none" && status === "skipped" && (step.inputs?.length ?? 0) === 0) {
      // Without a `when` to skip it, only `--steps`/`--skip` leaves a stamped step
      // skipped with no stamp: it never produced what the steps after it read.
      problems.push(`step "${step.id}" was left out by --steps or --skip and never ran`);
    }
  }
  return problems;
}

/** Open the run this invocation executes, with its definition and selection. */
export async function loadOrCreateRun(options: LoadOrCreateRunOptions): Promise<OpenedRun> {
  const {
    pipelinePath,
    ticket,
    runDir,
    fresh,
    startAt,
    forkSource,
    selection,
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

  // Where this invocation actually reads artifacts and writes decisions. The
  // worktree boot step has already chdir'd, so the context cwd is the effective
  // one; a reader outside the runner cannot infer it from the run directory.
  const location = { worktree, cwd: buildContext.cwd };

  if (startAt !== undefined) {
    if (!forkSource) throw new Error("--start-at: no source run was selected to fork.");
    return forkRun({
      pipeline,
      pipelinePath,
      ticket,
      context: buildContext,
      location,
      scope,
      sourceDir: forkSource.dir,
      startAt,
    });
  }

  return openRun({
    pipeline,
    pipelinePath,
    ticket,
    runDir,
    fresh,
    context: buildContext,
    location,
    scope,
    selection,
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
    },
  });
}
