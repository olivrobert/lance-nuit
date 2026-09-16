// runner/dispatch/strategy.ts
//
// A dispatch strategy selects a set of tickets and delegates each to a child
// runner. It replaces the run rather than running inside it: the parent becomes a
// process orchestrator and each child is a normal run with dispatch disabled.
//
// Strategies are mutually exclusive: a run selects one scope. Composable setup
// such as worktree preparation and locking belongs in a `BootStep`.
//
// Adding a strategy means adding an object and a DISPATCH entry. Adding another
// ticket source is not a strategy; it belongs behind the work-item port.

import type { PipelineContext } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import { flagSpec, type RunnerArgs } from "../model/cli-options.js";
import type { DispatchStrategy } from "./dispatch-strategy.js";
import { scanStrategy } from "./scan.js";

export { DispatchAbort } from "./abort.js";

/** The first applicable strategy in this array wins. */
export const DISPATCH: DispatchStrategy[] = [scanStrategy];

function dispatchDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.RUNNER_DISABLE_DISPATCH === "1";
}

/**
 * Select after `loadPipelineDefinition`: strategies need `def.name` for resume
 * state, so selection belongs at this layer.
 */
export function selectDispatch(
  args: RunnerArgs,
  _def: Pipeline,
  _ctx: PipelineContext,
  env: NodeJS.ProcessEnv = process.env,
): DispatchStrategy | null {
  if (args.scan) {
    return dispatchDisabled(env) ? null : scanStrategy;
  }
  return null;
}

/**
 * Validate strategy usage before side effects such as worktree chdir or locking.
 * Return an error message, or null.
 */
export function validateDispatchArgs(args: RunnerArgs): string | null {
  for (const strategy of DISPATCH) {
    if (!strategy.flag) continue;
    const active = (args as unknown as Record<string, unknown>)[flagKeyOf(strategy.flag)];
    if (active !== true) continue;
    if (strategy.ticket === "forbidden" && args.ticket) {
      return strategy.ticketError ?? `${strategy.flag} does not accept a ticket.`;
    }
  }
  return null;
}

/** Resolve the `RunnerArgs` key for a long flag through the FLAGS registry. */
function flagKeyOf(long: string): string {
  const spec = flagSpec(long);
  if (!spec)
    throw new Error(`Dispatch strategy: flag "${long}" is missing from the FLAGS registry (model/cli-options.ts).`);
  return spec.key;
}
