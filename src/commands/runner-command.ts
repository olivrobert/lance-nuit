// runner/commands/runner-command.ts
//
// The command port on its own, so the handlers do not import the registry that
// assembles them: `command.ts` imports every handler, and every handler needs
// this interface. Keeping the two apart is what makes `src/commands/` acyclic.

import type { ComposeRegistries } from "../boot/extensions.js";
import type { RunnerArgs } from "../model/cli-options.js";

/** What the entry point hands every command beside its arguments. */
export interface CommandEnvironment {
  /** Called only by the commands that load a pipeline: importing the manifest
   *  runs project code, which a command resolving no provider must not depend on. */
  readonly composeRegistries: ComposeRegistries;
}

export interface RunnerCommand {
  id: string;
  /** CLI flag that activates it; it must exist in model/cli-options.ts's FLAGS registry. */
  flag: string;
  /** `RunnerArgs` boolean field represented by this flag. */
  key: keyof RunnerArgs;
  desc: string;
  label?: string;
  run(args: RunnerArgs, environment: CommandEnvironment): number | Promise<number>;
}
