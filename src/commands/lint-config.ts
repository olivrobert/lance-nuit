// runner/commands/lint-config.ts
//
// Configuration lint compares the `profiles` and `steps` sections of
// `.lance-nuit/config.json` with every pipeline. It runs outside a run, so it needs
// neither a lock nor a clean-tree guard; the implementation lives in
// ./lint-config-check.ts.

import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";
import { formatLintReport, lintStepOverrides } from "./lint-config-check.js";

export const lintConfigCommand: RunnerCommand = {
  id: "lint-config",
  flag: "--lint-config",
  key: "lintConfig",
  desc: "Compare the config `steps` section with all pipelines.",
  async run(): Promise<number> {
    const { text, exitCode } = formatLintReport(await lintStepOverrides());
    log(text);
    return exitCode;
  },
};
