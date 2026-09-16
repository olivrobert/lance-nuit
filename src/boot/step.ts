// runner/boot/step.ts
//
// Run prelude: conditional, ordered preparations that combine with one another.
// This distinguishes them from `DispatchStrategy`, whose scopes are exclusive.
//
// BOOT[] order is boot order and serves as its documentation.
//
// A BootStep may only mutate state and return control; it does not select the run
// scope. A mode that moved cwd after the lock would therefore be unrepresentable.

import type { BootState, BootedState, BootStep } from "./boot-state.js";
import { configStep } from "./config.js";
import { lockStep } from "./lock.js";
import { pipelinePathStep } from "./pipeline-path.js";
import { stackStep } from "./stack.js";
import { worktreeStep } from "./worktree.js";

/**
 * ORDER IS THE CONTRACT:
 *  1. worktree      — changes cwd, which everything else depends on;
 *  2. pipeline-path — `.lance-nuit/pipelines/` is relative to cwd;
 *  3. config        — freezes config and context once cwd is final;
 *  4. lock          — is scoped to cwd;
 *  5. stack         — runs Docker preflight after the lock and before steps,
 *                     keeping its wait outside step timeouts.
 *
 * Intentionally outside the registry:
 *  - the clean-tree guard (boot/gitguard.ts), which depends on `resuming`, then
 *    `def.name` and `loadPipelineDefinition`, making it a run precondition;
 *  - the live feed (entry/feed.ts), which depends on `run.run_dir` from
 *    `loadOrCreateRun`.
 */
export const BOOT: BootStep[] = [worktreeStep, pipelinePathStep, configStep, lockStep, stackStep];

export async function runBoot(initial: BootState): Promise<BootedState> {
  let state = initial;
  for (const step of BOOT) {
    if (!step.applies(state)) continue;
    state = { ...state, ...(await step.run(state)) };
  }
  if (!state.pipelinePath || !state.config || !state.registries || !state.context) {
    throw new Error("Incomplete boot: pipelinePath / config / registries / context were not resolved by BOOT[].");
  }
  return state as BootedState;
}
