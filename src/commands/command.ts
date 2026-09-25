// runner/commands/command.ts
//
// A `RunnerCommand` does not launch a pipeline: no lock, clean-tree guard, or run
// directory. This distinguishes it from a `BootStep` and a `DispatchStrategy`.
//
// Commands are evaluated first in main(), in registry order.

import { readFileSync } from "node:fs";
import { approvalCommand } from "./approval.js";
import { closeCommand, reopenCommand } from "./closure.js";
import { createPipelineCommand } from "./create-pipeline.js";
import { cleanCommand, inspectCommand, logsCommand } from "./diagnostics.js";
import { renderHelp } from "./help.js";
import { lintConfigCommand } from "./lint-config.js";
import { lintPipelineCommand } from "./lint-pipeline.js";
import { statsCommand } from "./stats.js";
import { typecheckCommand } from "./typecheck.js";
import { typesInstallCommand } from "./types-install.js";
import { uiCommand } from "./ui.js";
import type { RunnerCommand } from "./runner-command.js";
import { wrapperHelpCommand } from "./wrapper-help.js";

export const helpCommand: RunnerCommand = {
  id: "help",
  flag: "--help",
  key: "help",
  desc: "Display usage generated from the FLAGS / COMMANDS / DISPATCH / BOOT registries.",
  run(): number {
    process.stdout.write(`${renderHelp(COMMANDS)}\n`);
    return 0;
  },
};

export const COMMANDS: RunnerCommand[] = [
  helpCommand,
  wrapperHelpCommand,
  {
    id: "version",
    flag: "--version",
    key: "version",
    desc: "Display the installed lance-nuit version.",
    run(): number {
      // Both src/commands and dist/commands are two levels below the package.
      const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      process.stdout.write(`lance-nuit ${version}\n`);
      return 0;
    },
  },
  createPipelineCommand,
  lintPipelineCommand,
  lintConfigCommand,
  typecheckCommand,
  typesInstallCommand,
  approvalCommand,
  closeCommand,
  reopenCommand,
  inspectCommand,
  logsCommand,
  cleanCommand,
  statsCommand,
  uiCommand,
];
