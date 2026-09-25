// model/cli-options.ts
//
// CLI option METADATA: the `RunnerArgs` shape and the `FLAGS` registry that
// describes every option. Pure data — no parsing, no I/O — so boot, dispatch and
// commands can read the registry without pulling the parser in.
//
// Declaring an option means adding one entry here: the parsing loop
// (`cli/parse.ts`), the help renderers and the command incompatibilities
// (`foreignFlag`) are all DERIVED from this registry, so an option a command does
// not claim is rejected by it without a second list. `RunnerArgs` remains
// handwritten: it is the typed surface read by boot, dispatch, and commands.

import { DEFAULT_UI_PORT, UI_HOST } from "../lib/ui-defaults.js";

export interface RunnerArgs {
  pipelinePath?: string;
  ticket?: string;
  stepFilter?: string[];
  skipFilter?: string[];
  /** Step id at which to start: every preceding step (pipeline order) is marked
   *  skipped. Resolved into an effective skip in loadOrCreateRun (it needs the
   *  pipeline definition to know the order). */
  startAt?: string;
  baseBranch?: string;
  watch: boolean;
  /** With --watch, automatically close the pane when the run becomes terminal. */
  watchAutoClose: boolean;
  fresh: boolean;
  scan: boolean;
  /** Maximum tickets processed by `--scan`. Overrides the work-item source value. */
  limit?: number;
  /** Human approval of a cost overrun: the ceiling in USD for this run. It
   *  outranks the pipeline `.maxCost()` and the one recorded in the snapshot,
   *  and is the only way to spend past a budget stop without replaying. */
  budget?: number;
  /** Human authorization to keep spending when the runner cannot price what was
   *  spent. It lifts the `cost-unaccounted` stop only: the known lower bound
   *  still obeys the ceiling, and no unknown marker is cleared. Persisted on the
   *  selected run, so later resumes need no flag. */
  allowUnmetered: boolean;
  allowDirty: boolean;
  worktree: boolean;
  /** Check the config `steps` section against all pipelines, then exit. */
  lintConfig: boolean;
  /** Load and validate a named pipeline without starting a run. */
  lintPipeline: boolean;
  /** Display registry-derived usage, then exit. */
  help: boolean;
  /** Display the installed package version without booting a run. */
  version?: boolean;
  /** Display the `bin/lancenuit` wrapper usage, then exit. Used by the wrapper
   *  itself so its help text is never a second, hand-maintained copy. */
  wrapperHelp: boolean;
  /** Typecheck project pipelines with the installed DSL declarations. */
  typecheck: boolean;
  /** Install generated DSL declarations for the current or shared kit. */
  typesInstall: boolean;
  /** Create a project pipeline without booting a run. */
  create: boolean;
  /** Bash command serialized into a created pipeline. */
  createCommand?: string;
  /** Starting point rendered by --create (see commands/pipeline-templates.ts). */
  createTemplate?: string;
  /** Target the SHARED kit directory (`~/.lance-nuit`) instead of the project one.
   *  Applies only to non-run commands (--create, --typecheck, --types-install). */
  user: boolean;
  /** Record a human decision for a work-item artifact. */
  approve?: string;
  /** Record --approve, then exit without running a pipeline. */
  approveOnly: boolean;
  /** Mark the latest run of `--pipeline` as closed by hand, then exit. */
  close: boolean;
  /** Remove a closure written by --close, then exit. */
  reopen: boolean;
  /** Diagnostic commands outside a run. */
  inspect: boolean;
  logs: boolean;
  clean: boolean;
  /** Summarize the central run history across runs, then exit. */
  stats: boolean;
  /** With --stats, keep runs started within this duration (`30d`, `12h`). */
  since?: string;
  /** With --stats, keep only runs that did not pass. */
  failures: boolean;
  /** With --stats, also count nested child runs. Off by default: a child's usage
   *  is already folded into its parent, so including it double-counts the spend. */
  includeChildren: boolean;
  /** Serve the local dashboard until interrupted, then exit. */
  ui: boolean;
  /** With --ui, the TCP port to bind on 127.0.0.1. `0` asks the kernel for a
   *  free one, which is how a test starts a server without picking a number. */
  port?: number;
  runId?: string;
  step?: string;
  logsOnly: boolean;
  olderThan?: string;
  keepFailed: boolean;
  passthrough: string[];
}

/** `RunnerArgs` keys an option can populate (`passthrough` is computed). */
export type FlagKey = Exclude<keyof RunnerArgs, "passthrough">;

export interface FlagSpec {
  long: string;
  short?: string;
  /** `RunnerArgs` field populated by this option. */
  key: FlagKey;
  /** boolean: no value. string: one value. number: a positive integer.
   *  amount: a positive decimal (USD). port: a TCP port, `0` included, because
   *  `0` means "any free port". list: a value split on `,`. */
  kind: "boolean" | "string" | "number" | "amount" | "port" | "list";
  /** Forwarded to self-spawned children (long form + value). See the note below. */
  passthrough?: boolean;
  desc: string;
  /** Internal parser flag; exposed through a friendlier subcommand syntax. */
  hidden?: boolean;
  /** Non-run commands that accept this option. A command derives its rejection
   *  list from this field, so an option is incompatible with it BY DEFAULT: a new
   *  run option needs no entry anywhere to be rejected. The hand-maintained list
   *  this replaced had already lost that guarantee — `--budget` was never added,
   *  so `--create --budget 5` was silently accepted. */
  commands?: readonly CommandScope[];
  /** Accepted by every invocation: usage output belongs to no command. */
  global?: boolean;
}

/** Commands that derive their accepted options from `FlagSpec.commands`. */
export type CommandScope = "create";

/**
 * `passthrough` rule, previously undocumented: an option is forwarded to children
 * iff the child cannot infer it from its environment.
 *  - `--fresh` / `--allow-dirty` / `--base-branch`: parent decisions invisible to the child → forwarded.
 *  - `--worktree`: the child inherits cwd (chdir) + `RUNNER_IN_WORKTREE` → NOT forwarded.
 *  - `--watch`: forwarded only by the multi-work-item strategy (tmux pane per child), not here.
 *  - `--pipeline` / step selectors: explicitly set by the spawn caller.
 */
export const FLAGS: FlagSpec[] = [
  {
    long: "--types-install",
    key: "typesInstall",
    kind: "boolean",
    hidden: true,
    desc: "Install generated DSL declarations.",
  },
  {
    long: "--pipeline",
    short: "-p",
    key: "pipelinePath",
    kind: "string",
    desc: "Name (`deploy`, resolved through the kit chain) or pipeline path (default: `default`).",
  },
  {
    long: "--ticket",
    key: "ticket",
    kind: "string",
    // Global because it fills the same field as the positional identifier, which
    // every command reads (`create` takes its pipeline name from it). Scoping it
    // would make a positional look like a foreign `--ticket` to those commands.
    global: true,
    desc: "Work item to run; equivalent to the positional identifier. Omit both for a ticket-less run.",
  },
  {
    long: "--steps",
    short: "-s",
    key: "stepFilter",
    kind: "list",
    desc: "List of steps to run (all others are skipped).",
  },
  { long: "--skip", short: "-k", key: "skipFilter", kind: "list", desc: "List of steps to skip." },
  {
    long: "--start-at",
    short: "-a",
    key: "startAt",
    kind: "string",
    desc: "Start at this step; all preceding steps are skipped.",
  },
  {
    long: "--base-branch",
    short: "-b",
    key: "baseBranch",
    kind: "string",
    passthrough: true,
    desc: "Base branch (default: the configured branch).",
  },
  { long: "--watch", short: "-w", key: "watch", kind: "boolean", desc: "Open a tmux pane on the run's live feed." },
  {
    long: "--watch-auto-close",
    key: "watchAutoClose",
    kind: "boolean",
    desc: "With --watch, close the tmux pane when the run reaches a terminal state (default: persistent pane).",
  },
  {
    long: "--fresh",
    short: "-f",
    key: "fresh",
    kind: "boolean",
    passthrough: true,
    desc: "Ignore the previous run and start from scratch.",
  },
  {
    long: "--scan",
    key: "scan",
    kind: "boolean",
    desc: "Discover tickets through the tracker and process them sequentially.",
  },
  {
    long: "--limit",
    short: "-n",
    key: "limit",
    kind: "number",
    desc: "Bound the items a command handles: tickets processed by --scan, runs listed by --stats.",
  },
  {
    long: "--budget",
    key: "budget",
    kind: "amount",
    desc: "Approve a cost ceiling in USD for this run. Use it to resume a run stopped by its budget.",
  },
  {
    long: "--allow-unmetered",
    key: "allowUnmetered",
    kind: "boolean",
    // Not forwarded to self-spawned children, exactly like --budget: authorizing
    // spend is a decision about one run, and a dispatch sweep must not grant it
    // to every item it launches. A composed child receives it through its budget
    // scope instead (`boot/resume.ts`).
    desc: "Authorize spend the runner could not price, and resume a run stopped by cost-unaccounted. The ceiling still applies to the priced spend.",
  },
  {
    long: "--allow-dirty",
    key: "allowDirty",
    kind: "boolean",
    passthrough: true,
    desc: "Disable the clean Git tree guard.",
  },
  {
    long: "--worktree",
    key: "worktree",
    kind: "boolean",
    desc: "Prepare a dedicated worktree for the ticket and run there.",
  },
  {
    long: "--lint-config",
    key: "lintConfig",
    kind: "boolean",
    desc: "Compare the config `steps` section with all pipelines, then exit.",
  },
  {
    long: "--lint-pipeline",
    key: "lintPipeline",
    kind: "boolean",
    desc: "Validate the pipeline selected by -p and print its step table, then exit.",
  },
  {
    long: "--approve",
    key: "approve",
    kind: "string",
    desc: "Approve a subject declared by the pipeline (`--pipeline`) and bind its artifact by SHA-256.",
  },
  {
    long: "--approve-only",
    key: "approveOnly",
    kind: "boolean",
    desc: "With --approve, write the decision and exit without running the pipeline.",
  },
  {
    long: "--close",
    key: "close",
    kind: "boolean",
    desc: "Mark the latest failed or stopped run of --pipeline as closed by hand, without changing its status.",
  },
  { long: "--reopen", key: "reopen", kind: "boolean", desc: "Remove the closure written by --close." },
  { long: "--inspect", key: "inspect", kind: "boolean", desc: "Display a ticket's run state." },
  { long: "--logs", key: "logs", kind: "boolean", desc: "Display a ticket's logs, optionally filtered by --step." },
  {
    long: "--run",
    key: "runId",
    kind: "string",
    desc: "Target a specific runId: explicitly resume a run, or filter --inspect / --logs.",
  },
  { long: "--step", key: "step", kind: "string", desc: "Filter a step for --logs (e.g. quality.tests)." },
  { long: "--clean", key: "clean", kind: "boolean", desc: "Clean logs from old runs; never modify pipeline-history." },
  {
    long: "--stats",
    key: "stats",
    kind: "boolean",
    desc: "Summarize pipeline-history across runs (--pipeline / --since / --failures / --limit).",
  },
  {
    long: "--ui",
    key: "ui",
    kind: "boolean",
    desc: `Serve the local dashboard on ${UI_HOST} until interrupted (--port).`,
  },
  {
    long: "--port",
    key: "port",
    kind: "port",
    desc: `TCP port for --ui on ${UI_HOST} (default: ${DEFAULT_UI_PORT}; 0 picks a free one).`,
  },
  { long: "--since", key: "since", kind: "string", desc: "Minimum recency for --stats (e.g. 30d, 12h)." },
  { long: "--failures", key: "failures", kind: "boolean", desc: "With --stats, keep only runs that did not pass." },
  {
    long: "--include-children",
    key: "includeChildren",
    kind: "boolean",
    desc: "With --stats, also count nested runs (their usage is already counted in the parent).",
  },
  { long: "--logs-only", key: "logsOnly", kind: "boolean", desc: "With --clean, remove only step log files." },
  { long: "--older-than", key: "olderThan", kind: "string", desc: "Minimum age for --clean (e.g. 30d, 12h)." },
  {
    long: "--keep-failed",
    key: "keepFailed",
    kind: "boolean",
    desc: "With --clean, keep logs from failed or interrupted runs.",
  },
  { long: "--help", short: "-h", key: "help", kind: "boolean", global: true, desc: "Display this help." },
  {
    long: "--version",
    key: "version",
    kind: "boolean",
    global: true,
    desc: "Display the installed lance-nuit version.",
  },
  {
    long: "--wrapper-help",
    key: "wrapperHelp",
    kind: "boolean",
    hidden: true,
    global: true,
    desc: "Display the bin/lancenuit wrapper usage.",
  },
  { long: "--typecheck", key: "typecheck", kind: "boolean", desc: "Typecheck project pipelines before a run." },
  {
    long: "--create",
    key: "create",
    kind: "boolean",
    commands: ["create"],
    desc: "Create a project pipeline without starting a run.",
  },
  {
    long: "--command",
    key: "createCommand",
    kind: "string",
    commands: ["create"],
    desc: "Bash command for the created pipeline (with --create).",
  },
  {
    long: "--template",
    key: "createTemplate",
    kind: "string",
    commands: ["create"],
    // Static text: the template list lives in `commands/pipeline-templates.ts`,
    // which this registry must not reach. The help renderers list the ids.
    desc: "Starting point for the created pipeline; see `runner --help` or `lancenuit help` for the list.",
  },
  {
    long: "--user",
    key: "user",
    kind: "boolean",
    commands: ["create"],
    desc: "Target the shared kit directory ~/.lance-nuit (with --create, --typecheck, or --types-install).",
  },
];

/** CLI usage error (missing option value, mutually exclusive options). */
export class CliError extends Error {}

/** Option spec by long form — used by registries that declare a `flag`. */
export function flagSpec(long: string): FlagSpec | undefined {
  return FLAGS.find((f) => f.long === long);
}

/** True when the option was actually provided on the command line. A boolean
 *  option defaults to `false`, every other one to `undefined`. */
function flagProvided(args: RunnerArgs, spec: FlagSpec): boolean {
  const value = (args as unknown as Record<string, unknown>)[spec.key];
  return spec.kind === "boolean" ? value === true : value !== undefined;
}

/**
 * First provided option that `command` does not accept, if any.
 *
 * DERIVED from the FLAGS registry rather than restated as a list: declaring an
 * option is enough for a command to reject it, which is the same rule the parsing
 * loop already follows for the option itself.
 */
export function foreignFlag(args: RunnerArgs, command: CommandScope): FlagSpec | undefined {
  return FLAGS.find((spec) => !spec.global && !spec.commands?.includes(command) && flagProvided(args, spec));
}
