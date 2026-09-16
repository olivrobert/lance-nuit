// runner/boot/boot-state.ts
//
// The boot port and the state it threads, on their own: `step.ts` imports every
// boot step to build BOOT, and every boot step needs these types. Keeping them
// apart is what makes `src/boot/` acyclic.

import type { RunnerArgs } from "../model/cli-options.js";
import type { PipelineConfig } from "../env/config.js";
import type { PipelineContext } from "../model/context.js";
import type { RunnerRegistries } from "./extensions.js";

export interface BootState {
  args: RunnerArgs;
  cwd: string;
  /** Built-in providers composed by the entry point; the extension manifest
   *  extends THIS pair. Boot prepares a run, it never composes one. */
  baseRegistries: RunnerRegistries;
  /** Resolved by `pipelinePathStep`; guaranteed after `runBoot`. */
  pipelinePath?: string;
  /** Set by `configStep`; guaranteed after `runBoot`. */
  config?: PipelineConfig;
  /** Provider registries assembled from built-ins plus the explicit extension module. */
  registries?: RunnerRegistries;
  context?: PipelineContext;
  worktreeMode: boolean;
}

/** Completed boot state with fields guaranteed by the registry narrowed. */
export interface BootedState extends BootState {
  pipelinePath: string;
  config: PipelineConfig;
  registries: RunnerRegistries;
  context: PipelineContext;
}

export interface BootStep {
  id: string;
  /** One-line description used by --help and registry readers. */
  desc: string;
  applies(s: BootState): boolean;
  /** Mutates state and returns control; may exit(1) for usage errors. */
  run(s: BootState): Partial<BootState> | Promise<Partial<BootState>>;
}
