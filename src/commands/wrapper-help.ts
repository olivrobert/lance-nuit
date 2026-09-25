// runner/commands/wrapper-help.ts
//
// Help text for the `bin/lancenuit` wrapper, generated from registries.
//
// The wrapper is a thin Bash front-end: each verb rewrites into runner flags.
// The verbs live here and the option list is derived, so every option stays in
// sync with `FLAGS` instead of drifting; `wrapper-help.test.ts` keeps this
// registry aligned with the `case` labels the script actually routes.

import type { RunnerCommand } from "./runner-command.js";
import { DEFAULT_TEMPLATE_ID, PIPELINE_TEMPLATES } from "./pipeline-templates.js";
import { flagRows, helpSection } from "./shared.js";

export interface WrapperCommand {
  /** Verb typed by the user; also the `case` label in `bin/lancenuit`. */
  verb: string;
  /** Additional `case` labels routed to the same behaviour. */
  aliases?: readonly string[];
  /** Runner flag this verb substitutes for. Such a flag is not repeated in the
   *  option list: the wrapper user types the verb, never the flag. */
  flag?: string;
  /** Invocation shown in the help text. */
  usage: string;
  desc: string;
}

export const WRAPPER_COMMANDS: readonly WrapperCommand[] = [
  {
    verb: "version",
    aliases: ["--version"],
    flag: "--version",
    usage: "version",
    desc: "Display the installed lance-nuit version.",
  },
  {
    verb: "run",
    usage: "run [<id>]",
    desc: "Run the default pipeline, or the one selected with -p; without <id>, a ticket-less run on the current branch.",
  },
  {
    verb: "single",
    usage: "single [<id>]",
    desc: "Same as run, with multi-work-item dispatch disabled.",
  },
  {
    verb: "approve",
    flag: "--approve",
    usage: "approve <id> <subject> --pipeline <name>",
    desc: "Record approval for a subject declared by the pipeline, without running (use `run --approve <subject>` to approve and resume).",
  },
  {
    verb: "close",
    flag: "--close",
    usage: "close <id> --pipeline <name>",
    desc: "Mark the latest failed or stopped run as closed by hand; its status is kept, and a later run reopens it.",
  },
  {
    verb: "reopen",
    flag: "--reopen",
    usage: "reopen <id> --pipeline <name>",
    desc: "Remove the closure written by close.",
  },
  {
    verb: "inspect",
    flag: "--inspect",
    usage: "inspect <id>",
    desc: "Display a run's state.",
  },
  {
    verb: "logs",
    flag: "--logs",
    usage: "logs <id>",
    desc: "Display attempt logs (--step / --run).",
  },
  {
    verb: "clean",
    flag: "--clean",
    usage: "clean",
    desc: "Clean old logs (--logs-only --older-than 30d).",
  },
  {
    verb: "stats",
    flag: "--stats",
    usage: "stats [-p <name>] [--since 30d] [--failures]",
    desc: "Summarize run history across runs: status, cost, tokens, failing phases.",
  },
  {
    verb: "ui",
    flag: "--ui",
    usage: "ui [--port <n>]",
    desc: "Serve the local dashboard on 127.0.0.1 (default port 4848) until interrupted.",
  },
  {
    verb: "typecheck",
    flag: "--typecheck",
    usage: "typecheck",
    desc: "Typecheck project pipelines with TypeScript.",
  },
  {
    verb: "types",
    flag: "--types-install",
    usage: "types install",
    desc: "Install generated DSL declarations for project pipelines.",
  },
  {
    verb: "lint",
    flag: "--lint-pipeline",
    usage: "lint -p <name>",
    desc: "Validate a pipeline and display its steps without running it.",
  },
  {
    verb: "create",
    flag: "--create",
    usage: "create <name> [--template <id>] [--command <command>]",
    desc: "Create a project pipeline, install types, and typecheck it.",
  },
  {
    verb: "list",
    aliases: ["--list"],
    usage: "list",
    desc: "List available pipelines.",
  },
  {
    verb: "help",
    aliases: ["--help", "-h"],
    flag: "--help",
    usage: "help",
    desc: "Display this help.",
  },
];

/**
 * Options a wrapper user may still pass through: every declared flag except the
 * hidden ones and those already exposed as a verb.
 */
function passthroughOptions(): Array<[string, string]> {
  const owned = new Set(WRAPPER_COMMANDS.map((command) => command.flag).filter((flag): flag is string => !!flag));
  return flagRows(owned);
}

export function renderWrapperHelp(): string {
  return [
    "lancenuit <command> [<id>] [options...]",
    ...helpSection(
      "Commands",
      WRAPPER_COMMANDS.map((command): [string, string] => [command.usage, command.desc]),
    ),
    ...helpSection("Options forwarded to the runner", passthroughOptions()),
    "",
    "  --                          Forward everything that follows unchanged to the runner",
    ...helpSection(
      `Starting points for create (--template, default: ${DEFAULT_TEMPLATE_ID})`,
      PIPELINE_TEMPLATES.map((template): [string, string] => [template.id, template.desc]),
    ),
    "",
    "Examples:",
    "  lancenuit create build --command 'npm test'",
    "  lancenuit create review --template review",
    "  lancenuit run build-42",
    "  lancenuit run build-42 --pipeline custom --worktree",
    "  lancenuit run -p quality",
  ].join("\n");
}

export const wrapperHelpCommand: RunnerCommand = {
  id: "wrapper-help",
  flag: "--wrapper-help",
  key: "wrapperHelp",
  desc: "Display the bin/lancenuit wrapper usage generated from the WRAPPER_COMMANDS, FLAGS and PIPELINE_TEMPLATES registries.",
  run(): number {
    process.stdout.write(`${renderWrapperHelp()}\n`);
    return 0;
  },
};
