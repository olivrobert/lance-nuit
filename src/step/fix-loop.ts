// runner/step/fix-loop.ts
//
// Public on_failure repair facade. Session/context preparation and pass execution
// live in internal modules; this file keeps the API.

import type { PipelineContext } from "../model/context.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunBudget } from "../state/budget.js";
import { type FixLoopOpts, prepareFixRun } from "./fix-loop-runtime.js";
import { runFixRetryLoop } from "./fix-loop-strategies.js";

export type { FixLoopDeps, FixLoopOpts } from "./fix-loop-runtime.js";
export { buildFixContext } from "./fix-loop-runtime.js";

/**
 * Repair loop: repair the step, then replay its command, up to `max_retries`.
 * `opts.resumeSession` runs the repair inside the session recorded by the named
 * step instead of a fresh one, and writes the forked session back to that step.
 */
export async function runFixLoop(
  run: Run,
  step: RunStep,
  command: string,
  output: string,
  baseCtx: PipelineContext,
  budget: RunBudget,
  initialFailReason: string | undefined,
  opts: FixLoopOpts,
): Promise<{ failed: boolean }> {
  const fx = prepareFixRun(run, step, command, baseCtx, budget, opts);
  return runFixRetryLoop(fx, output, initialFailReason);
}
