// runner/commands/help.ts
//
// `--help` is generated from registries: adding an option, strategy, or boot
// step automatically adds it here.
//
// Commands are passed in because command.ts builds its registry from this module;
// importing them here would create a cycle.

import { BOOT } from "../boot/step.js";
import { DISPATCH } from "../dispatch/strategy.js";
import type { RunnerCommand } from "./runner-command.js";
import { DEFAULT_TEMPLATE_ID, PIPELINE_TEMPLATES } from "./pipeline-templates.js";
import { flagRows, helpSection } from "./shared.js";

export function renderHelp(commands: RunnerCommand[]): string {
  const commandFlags = new Set(commands.map((c) => c.flag));

  const options = flagRows(commandFlags);

  return [
    "Usage: runner [ticket] [options]",
    '       lancenuit create <name> [--template <id>] [--command "<command>"]',
    "",
    "  ticket   Simple identifier (PROJ-28) or work-item path (exports/PROJ-1478).",
    ...helpSection(
      "Commands (do not run a pipeline)",
      commands.map((c): [string, string] => [c.label ?? c.flag, c.desc]),
    ),
    ...helpSection("Options", options),
    ...helpSection(
      `Starting points for --create (--template, default: ${DEFAULT_TEMPLATE_ID})`,
      PIPELINE_TEMPLATES.map((template): [string, string] => [template.id, template.desc]),
    ),
    ...helpSection(
      "Dispatch strategies (exclusive scopes)",
      DISPATCH.map((s): [string, string] => [s.flag ?? `${s.id} (auto)`, s.desc]),
    ),
    ...helpSection(
      "Run preflight, in order",
      BOOT.map((s): [string, string] => [s.id, s.desc]),
    ),
  ].join("\n");
}
