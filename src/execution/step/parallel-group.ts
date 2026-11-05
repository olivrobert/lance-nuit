//
// One admitted group of `parallelize`: each member gets the same pass a lone step
// gets, at the same time, in one git tree. Which members were admitted stays with the
// loop; what they may be stays with `ParallelGroupValidator`.
//
// A member that fails does not stop its siblings: their work is paid for and a resume
// keeps it, so the run stops once the whole group has answered.

import { isAbsolute, join } from "node:path";
import { expectAllowances, type RunStepView, stopRun } from "../../run/index.js";
import type { StepAdmission } from "./step-admission.js";
import { INTERRUPTED, runStepPass, type StepLoopStop, type StepPassEnv } from "./step-pass.js";
import { snapshotTree, treeChanges } from "./tree-snapshot.js";

export interface AdmittedStep {
  step: RunStepView;
  admission: Extract<StepAdmission, { kind: "ready" }>;
}

/** The steps in execution order, one list per thing the loop runs at once: a lone
 *  step, or all the members of a group. The build keeps a group contiguous. */
export function executionUnits(steps: readonly RunStepView[]): RunStepView[][] {
  const units: RunStepView[][] = [];
  let start = 0;
  while (start < steps.length) {
    const group = steps[start]?.def.parallel_group?.id;
    let end = start + 1;
    while (group !== undefined && steps[end]?.def.parallel_group?.id === group) end += 1;
    units.push(steps.slice(start, end));
    start = end;
  }
  return units;
}

/** A member is an agent step, whose pass asks only for these two: its cost stops reach
 *  the loop through the shared ledger (`ledgerStops`). */
function mergeStops(stops: readonly (StepLoopStop | undefined)[]): StepLoopStop | undefined {
  const asked = stops.filter((stop) => stop !== undefined);
  if (asked.length === 0) return undefined;
  return {
    failed: asked.some((stop) => stop.failed),
    stopped: asked.some((stop) => stop.stopped),
  };
}

/** What the group may leave behind: the run's own records, the work item, and the
 *  reports its members declare. */
function allowedWrites(env: StepPassEnv, admitted: readonly AdmittedStep[]): string[] {
  const { run, baseCtx } = env;
  const reports = admitted.flatMap(({ step }) => step.def.report_paths ?? []);
  return [
    run.run_dir,
    ...(baseCtx.paths.workItemDir ? [baseCtx.paths.workItemDir] : []),
    ...reports.map((path) => (isAbsolute(path) ? path : join(baseCtx.cwd, path))),
  ];
}

/**
 * A member that wrote to the tree breaks what the group promised its siblings, and
 * no backend can forbid it: Claude can write through `Bash`. This only sees it
 * afterwards and undoes nothing, so a human decides: the members keep their verdict
 * and a resume goes on from the next step.
 */
function stopOnTreeWrites(
  env: StepPassEnv,
  admitted: readonly AdmittedStep[],
  changed: readonly string[],
): StepLoopStop {
  const { run, deps } = env;
  const first = admitted[0]!.step;
  const detail = `${first.def.parallel_group?.name} — its steps changed files they should only read: ${changed.join(", ")}. Check them, then rerun to continue`;
  stopRun(run, first, detail, { kind: "needs-decision", detail });
  deps.output.emit({ type: "runner.message", level: "error", message: `⏹ ${detail}` });
  return { stopped: true };
}

/** Run every admitted member of a group to its verdict. Returns the stop the group
 *  asks of the loop, or nothing when the loop may go on. */
export async function runParallelGroup(
  env: StepPassEnv,
  admitted: readonly AdmittedStep[],
): Promise<StepLoopStop | undefined> {
  const { run, budget, abort } = env;
  const before = await snapshotTree(env.baseCtx.cwd);
  if (abort.isRunAborted(run)) return INTERRUPTED;

  expectAllowances(
    budget,
    admitted.map(({ step }) => step.id),
  );
  // `allSettled`: returning on the first rejection would leave the siblings spending
  // behind a run that has already moved on.
  const passes = await Promise.allSettled(admitted.map(({ step, admission }) => runStepPass(env, step, admission)));

  const rejected = passes.find((pass) => pass.status === "rejected");
  if (rejected) throw rejected.reason;

  const after = before && (await snapshotTree(env.baseCtx.cwd));
  if (abort.isRunAborted(run)) return INTERRUPTED;
  if (before && !after) {
    env.deps.output.emit({
      type: "runner.message",
      level: "warn",
      message: `${admitted[0]!.step.def.parallel_group?.name} — could not read the git tree after the group: writes by its steps were not checked`,
    });
  }
  const changed = before && after ? treeChanges(before, after, allowedWrites(env, admitted)) : [];
  const stops = passes.map((pass) => (pass.status === "fulfilled" ? pass.value : undefined));
  return mergeStops(changed.length > 0 ? [...stops, stopOnTreeWrites(env, admitted, changed)] : stops);
}
