//
// A dispatch strategy selects a set of tickets and delegates each to a child
// runner. It replaces the run rather than running inside it: the parent becomes a
// process orchestrator and each child is a normal run.
//
// Strategies are mutually exclusive: a run selects one scope. Composable setup
// such as worktree preparation and locking belongs in a `BootStep`.
//
// Adding a strategy means adding an object, a DISPATCH entry, and its case in
// `selectDispatch` and `validateDispatchArgs`. Adding another
// ticket source is not a strategy; it belongs behind the work-item port.

import type { PipelineContext } from "../../shared/language/context.js";
import type { Pipeline } from "../../definition/index.js";
import type { DispatchArgs, DispatchStrategy } from "./dispatch-strategy.js";
import { scanStrategy } from "./scan.js";

/** The strategies `--help` lists. `selectDispatch` and `validateDispatchArgs`
 *  name the one strategy directly. */
export const DISPATCH: DispatchStrategy[] = [scanStrategy];

/**
 * Select after `loadPipelineDefinition`: strategies need `def.name` for resume
 * state, so selection belongs at this layer.
 */
export function selectDispatch(args: DispatchArgs, _def: Pipeline, _ctx: PipelineContext): DispatchStrategy | null {
  return args.scan ? scanStrategy : null;
}

/**
 * Validate strategy usage before side effects such as worktree chdir or locking.
 * Return an error message, or null.
 */
export function validateDispatchArgs(args: DispatchArgs): string | null {
  return scanStrategy.isActive(args) && args.ticket ? scanStrategy.ticketError : null;
}
