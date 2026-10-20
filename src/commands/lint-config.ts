// runner/commands/lint-config.ts
//
// Configuration lint compares the `profiles` and `steps` sections of
// `.lance-nuit/config.json` with every pipeline. It runs outside a run, so it needs
// neither a lock nor a clean-tree guard; the implementation lives in
// ./lint-config-check.ts.

import type { PipelineContext } from "../model/context.js";
import { log } from "../runtime/logging.js";
import type { CommandEnvironment, RunnerCommand } from "./runner-command.js";
import { formatLintReport, lintConfigContext, lintStepOverrides } from "./lint-config-check.js";
import { errorMessage } from "./shared.js";

export const lintConfigCommand: RunnerCommand = {
  id: "lint-config",
  flag: "--lint-config",
  key: "lintConfig",
  desc: "Compare the config `steps` section with all pipelines.",
  async run(_args, environment: CommandEnvironment): Promise<number> {
    let context: PipelineContext;
    try {
      context = await lintConfigContext(environment.composeRegistries);
    } catch (error) {
      // The extension manifest the configuration names cannot load: no pipeline
      // could be checked against the providers a run would see.
      log(`Unable to load the project configuration: ${errorMessage(error)}`);
      return 1;
    }
    const { text, exitCode } = formatLintReport(await lintStepOverrides(context));
    log(text);
    return exitCode;
  },
};
