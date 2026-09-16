// cli/parse.ts
//
// PURE parsing of runner CLI arguments. Extracted from the `main()` loop —
// no side effects: usage errors are raised through `CliError`, which the
// entry point turns into a log + exit(1).
//
// The parsing loop is DERIVED from the `FLAGS` registry (`model/cli-options.ts`):
// declaring an option means adding one entry there — no more triple entry
// (interface + parsing + passthrough).

import { pipelineTemplate } from "../commands/pipeline-templates.js";
import { errorMessage } from "../lib/errors.js";
import { CliError, type FlagKey, FLAGS, type FlagSpec, foreignFlag, type RunnerArgs } from "../model/cli-options.js";

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    watch: false,
    watchAutoClose: false,
    fresh: false,
    scan: false,
    allowUnmetered: false,
    allowDirty: false,
    worktree: false,
    lintConfig: false,
    lintPipeline: false,
    help: false,
    version: false,
    wrapperHelp: false,
    approveOnly: false,
    inspect: false,
    logs: false,
    clean: false,
    stats: false,
    ui: false,
    failures: false,
    includeChildren: false,
    typecheck: false,
    typesInstall: false,
    create: false,
    user: false,
    logsOnly: false,
    keepFailed: false,
    passthrough: [],
  };
  // Dynamic assignment: the registry carries the target key, not the loop.
  const set = (key: FlagKey, value: unknown): void => {
    (args as unknown as Record<string, unknown>)[key] = value;
  };

  // The positional identifier and `--ticket` name the same thing; remembering
  // which form was used is what lets the parser refuse both at once instead of
  // silently letting one shadow the other.
  let positionalTicket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const spec = FLAGS.find((f) => f.long === token || f.short === token);
    if (!spec) {
      // An unknown option is NOT a ticket: without this guard, `--tikcet PROJ-318`
      // would run against ticket `--tikcet`, silently ignoring the real identifier.
      if (token.startsWith("-") && token !== "-") {
        throw new CliError(`Unknown option: ${token}. See --help.`);
      }
      if (positionalTicket === undefined) positionalTicket = token;
      continue;
    }
    if (spec.kind === "boolean") {
      set(spec.key, true);
      if (spec.passthrough) args.passthrough.push(spec.long);
      continue;
    }
    const value = argv[++i];
    if (value == null) throw new CliError(`Option ${token} expects a value.`);
    if (FLAGS.some((candidate) => candidate.long === value || candidate.short === value)) {
      throw new CliError(`Option ${token} expects a value (received option ${value}).`);
    }
    set(spec.key, parseFlagValue(spec, token, value));
    // Always use the long form for children: a child never reparses the short alias.
    if (spec.passthrough) args.passthrough.push(spec.long, value);
  }

  if (positionalTicket !== undefined) {
    if (args.ticket !== undefined && args.ticket !== positionalTicket) {
      throw new CliError(
        `Option --ticket ${args.ticket} conflicts with the positional identifier ${positionalTicket}: give one of them.`,
      );
    }
    args.ticket = positionalTicket;
  }

  const selectors = [args.stepFilter, args.skipFilter, args.startAt].filter((v) => v != null).length;
  if (selectors > 1) {
    throw new CliError("Options --steps, --skip, and --start-at are mutually exclusive.");
  }
  // Without --scan there is only one ticket, so a limit would be silently ignored.
  // --stats is the other bounded listing: it caps the runs printed.
  if (args.limit != null && !args.scan && !args.stats) {
    throw new CliError("Option --limit applies to --scan or --stats.");
  }
  if (args.approveOnly && !args.approve) {
    throw new CliError("Option --approve-only requires --approve <subject>.");
  }
  if (args.approve && !args.ticket) {
    throw new CliError("Option --approve requires a ticket.");
  }
  if ([args.inspect, args.logs, args.clean].filter(Boolean).length > 1) {
    throw new CliError("Commands --inspect, --logs, and --clean are mutually exclusive.");
  }
  if ((args.inspect || args.logs) && !args.ticket) {
    throw new CliError("This command requires a ticket.");
  }
  // --run outside inspection = explicit resume of a specific run. This is the way
  // out when `latest` is rejected by resume policy (manually interrupted: ABORTED),
  // while its snapshot remains perfectly resumable.
  if (args.step && !args.inspect && !args.logs) {
    throw new CliError("--step is only valid with --inspect or --logs.");
  }
  if (args.runId && !args.ticket) {
    throw new CliError("Option --run requires a ticket.");
  }
  // A ceiling only means something for a run: silently ignoring it on an
  // inspection command would look like an approval that never happened.
  if (args.budget != null && (args.inspect || args.logs || args.clean || args.approveOnly)) {
    throw new CliError("Option --budget applies to a run, not to an inspection command.");
  }
  // Approving an overrun is a decision about one run that stopped. Under --scan it
  // would silently grant the same ceiling to every ticket swept.
  if (args.budget != null && args.scan) {
    throw new CliError("Option --budget approves one run: rerun that ticket explicitly instead of --scan.");
  }
  // Same reasoning as --budget: an authorization is a decision about the run it
  // is given to. On an inspection command it would look like an approval nobody
  // recorded; under --scan it would silently authorize every ticket swept.
  if (args.allowUnmetered && (args.inspect || args.logs || args.clean || args.approveOnly)) {
    throw new CliError("Option --allow-unmetered applies to a run, not to an inspection command.");
  }
  if (args.allowUnmetered && args.scan) {
    throw new CliError("Option --allow-unmetered authorizes one run: rerun that ticket explicitly instead of --scan.");
  }
  if (args.runId && args.fresh) {
    throw new CliError(
      "--run and --fresh are mutually exclusive: one resumes a specific run, the other starts from scratch.",
    );
  }
  if ((args.logsOnly || args.olderThan || args.keepFailed) && !args.clean) {
    throw new CliError("--logs-only, --older-than, and --keep-failed require --clean.");
  }
  // The dashboard serves every listed project at once, so a ticket would name
  // something it does not act on, and a port belongs to the socket it binds.
  if (args.ui && args.ticket) {
    throw new CliError("The ui command serves every listed project: it does not take a ticket.");
  }
  if (args.port != null && !args.ui) {
    throw new CliError("Option --port applies to --ui.");
  }
  if ((args.since || args.failures || args.includeChildren) && !args.stats) {
    throw new CliError("--since, --failures, and --include-children require --stats.");
  }
  if (args.clean && args.approve) {
    throw new CliError("--clean and --approve are mutually exclusive.");
  }
  if (args.createCommand !== undefined && !args.createCommand.trim()) {
    throw new CliError("Option --command expects a non-empty command.");
  }
  if (args.createCommand !== undefined && !args.create) {
    throw new CliError("Option --command requires --create.");
  }
  if (args.typesInstall && args.ticket) {
    throw new CliError("lancenuit types install does not accept positional arguments.");
  }
  if (args.typesInstall && (args.create || args.typecheck)) {
    throw new CliError("lancenuit types install cannot be combined with --create or --typecheck.");
  }
  if (args.lintPipeline && !args.pipelinePath) {
    throw new CliError("Option --lint-pipeline requires --pipeline <name> (or -p <name>).");
  }
  if (args.lintPipeline && args.ticket) {
    throw new CliError("Option --lint-pipeline does not accept a ticket.");
  }
  if (args.createTemplate !== undefined && !args.create) {
    throw new CliError("Option --template requires --create.");
  }
  if (args.create) {
    if (!args.ticket) {
      throw new CliError("--create requires a pipeline name.");
    }
    // The template decides whether a command is meaningful: an agent or
    // work-item starting point has no shell command to serialize.
    let template: ReturnType<typeof pipelineTemplate>;
    try {
      template = pipelineTemplate(args.createTemplate);
    } catch (error) {
      throw new CliError(errorMessage(error), { cause: error });
    }
    if (template.usesCommand && args.createCommand === undefined) {
      throw new CliError(`--create --template ${template.id} requires --command <command>.`);
    }
    if (!template.usesCommand && args.createCommand !== undefined) {
      throw new CliError(`--create --template ${template.id} does not accept --command.`);
    }

    const conflict = foreignFlag(args, "create");
    if (conflict) {
      throw new CliError(`${conflict.long} is incompatible with --create.`);
    }
  }

  return args;
}

/** Convert the raw option value according to its `kind`. */
function parseFlagValue(spec: FlagSpec, token: string, value: string): unknown {
  if (spec.kind === "list") return value.split(",");
  if (spec.kind === "amount") {
    // A budget is money, not a count: decimals are the norm.
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new CliError(`Option ${token} expects a positive amount in USD (received: ${value}).`);
    }
    return amount;
  }
  if (spec.kind === "port") {
    // `0` is meaningful here and nowhere else: it asks the kernel for a free
    // port, which is how a test binds without choosing a number.
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new CliError(`Option ${token} expects a TCP port between 0 and 65535 (received: ${value}).`);
    }
    return port;
  }
  if (spec.kind !== "number") return value;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`Option ${token} expects a positive integer (received: ${value}).`);
  }
  return parsed;
}
