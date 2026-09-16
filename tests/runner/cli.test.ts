import { expect, test } from "bun:test";
import { CliError, FLAGS } from "../../src/model/cli-options.ts";
import { parseRunnerArgs } from "../../src/cli/parse.ts";

test("positional ticket only", () => {
  const a = parseRunnerArgs(["PROJ-28"]);
  expect(a.ticket).toBe("PROJ-28");
  expect(a.pipelinePath).toBeUndefined();
  expect(a.watch).toBe(false);
  expect(a.scan).toBe(false);
});

test("types install internal flag supports --user", () => {
  const project = parseRunnerArgs(["--types-install"]);
  expect(project.typesInstall).toBe(true);
  expect(project.ticket).toBeUndefined();
  expect(parseRunnerArgs(["--types-install", "--user"]).user).toBe(true);
  expect(() => parseRunnerArgs(["--types-install", "unexpected"])).toThrow(/does not accept positional/);
});

test("long and short options are equivalent", () => {
  const long = parseRunnerArgs(["T", "--pipeline", "p.ts", "--steps", "a,b", "--base-branch", "dev"]);
  const short = parseRunnerArgs(["T", "-p", "p.ts", "-s", "a,b", "-b", "dev"]);
  expect(long.pipelinePath).toBe("p.ts");
  expect(long.stepFilter).toEqual(["a", "b"]);
  expect(long.baseBranch).toBe("dev");
  expect(short).toEqual(long);
});

test("--skip parses as a list", () => {
  const a = parseRunnerArgs(["T", "--skip", "quality,commit"]);
  expect(a.skipFilter).toEqual(["quality", "commit"]);
  expect(a.stepFilter).toBeUndefined();
});

test("--start-at and -a are equivalent", () => {
  const long = parseRunnerArgs(["T", "--start-at", "implement"]);
  const short = parseRunnerArgs(["T", "-a", "implement"]);
  expect(long.startAt).toBe("implement");
  expect(short).toEqual(long);
  expect(long.skipFilter).toBeUndefined();
  expect(long.stepFilter).toBeUndefined();
});

test("boolean flags", () => {
  const a = parseRunnerArgs(["T", "--watch", "--fresh", "--allow-dirty", "--worktree"]);
  expect(a.watch).toBe(true);
  expect(a.fresh).toBe(true);
  expect(a.allowDirty).toBe(true);
  expect(a.worktree).toBe(true);
});

test("--scan without a ticket", () => {
  const a = parseRunnerArgs(["--scan", "-p", "bugfix.ts"]);
  expect(a.scan).toBe(true);
  expect(a.ticket).toBeUndefined();
  expect(a.pipelinePath).toBe("bugfix.ts");
});

test("--lint-pipeline requires -p and remains a command outside a run", () => {
  const args = parseRunnerArgs(["--lint-pipeline", "-p", "feature"]);
  expect(args.lintPipeline).toBe(true);
  expect(args.pipelinePath).toBe("feature");
  expect(args.ticket).toBeUndefined();
  expect(() => parseRunnerArgs(["--lint-pipeline"])).toThrow(/requires --pipeline/);
  expect(() => parseRunnerArgs(["PROJ-1", "--lint-pipeline", "-p", "feature"])).toThrow(/does not accept a ticket/);
});

test("passthrough: base-branch, fresh, allow-dirty propagated; watch/worktree NOT", () => {
  const a = parseRunnerArgs(["T", "--base-branch", "dev", "--fresh", "--allow-dirty", "--watch", "--worktree"]);
  expect(a.passthrough).toEqual(["--base-branch", "dev", "--fresh", "--allow-dirty"]);
});

test("missing value → CliError", () => {
  expect(() => parseRunnerArgs(["T", "--pipeline"])).toThrow(CliError);
  expect(() => parseRunnerArgs(["T", "--base-branch"])).toThrow(/--base-branch expects a value/);
  expect(() => parseRunnerArgs(["T", "--pipeline", "--fresh"])).toThrow(
    /--pipeline expects a value \(received option --fresh\)/,
  );
  expect(() => parseRunnerArgs(["T", "-p", "-f"])).toThrow(/-p expects a value \(received option -f\)/);
});

test("--steps and --skip are mutually exclusive → CliError", () => {
  expect(() => parseRunnerArgs(["T", "--steps", "a", "--skip", "b"])).toThrow(/mutually exclusive/);
});

test("--start-at is exclusive with --steps / --skip → CliError", () => {
  expect(() => parseRunnerArgs(["T", "--start-at", "x", "--skip", "b"])).toThrow(/mutually exclusive/);
  expect(() => parseRunnerArgs(["T", "--steps", "a", "--start-at", "x"])).toThrow(/mutually exclusive/);
});

test("--run also targets a run: explicit runId resume, outside --inspect/--logs", () => {
  expect(parseRunnerArgs(["T", "--run", "20260810T155756-feature-2dd762"]).runId).toBe(
    "20260810T155756-feature-2dd762",
  );
  expect(() => parseRunnerArgs(["--run", "x"])).toThrow(/requires a ticket/);
  expect(() => parseRunnerArgs(["T", "--run", "x", "--fresh"])).toThrow(/mutually exclusive/);
  expect(() => parseRunnerArgs(["T", "--step", "quality.tests"])).toThrow(/only valid with --inspect or --logs/);
});

test("--limit / -n: integer, not propagated to children", () => {
  const long = parseRunnerArgs(["--scan", "--limit", "3"]);
  const short = parseRunnerArgs(["--scan", "-n", "3"]);
  expect(long.limit).toBe(3);
  expect(short.limit).toBe(3);
  expect(long.passthrough).toEqual([]);
});

test("--limit: absent → undefined (unlimited)", () => {
  expect(parseRunnerArgs(["--scan"]).limit).toBeUndefined();
});

test("--limit: non-integer or < 1 → CliError", () => {
  expect(() => parseRunnerArgs(["--scan", "--limit", "0"])).toThrow(/positive integer/);
  expect(() => parseRunnerArgs(["--scan", "--limit", "-2"])).toThrow(/positive integer/);
  expect(() => parseRunnerArgs(["--scan", "--limit", "1.5"])).toThrow(/positive integer/);
  expect(() => parseRunnerArgs(["--scan", "--limit", "trois"])).toThrow(/positive integer/);
});

test("--limit outside --scan and --stats → CliError", () => {
  expect(() => parseRunnerArgs(["T", "--limit", "3"])).toThrow(/applies to --scan or --stats/);
});

test("--ui: no ticket, and --port accepts 0 as 'any free port'", () => {
  const a = parseRunnerArgs(["--ui"]);
  expect(a.ui).toBe(true);
  expect(a.port).toBeUndefined();
  expect(parseRunnerArgs(["--ui", "--port", "4848"]).port).toBe(4848);
  expect(parseRunnerArgs(["--ui", "--port", "0"]).port).toBe(0);
});

test("--port: outside --ui, or outside the TCP range → CliError", () => {
  expect(() => parseRunnerArgs(["--port", "4848"])).toThrow(/applies to --ui/);
  expect(() => parseRunnerArgs(["--ui", "--port", "70000"])).toThrow(/between 0 and 65535/);
  expect(() => parseRunnerArgs(["--ui", "--port", "-1"])).toThrow(/between 0 and 65535/);
  expect(() => parseRunnerArgs(["--ui", "--port", "http"])).toThrow(/between 0 and 65535/);
});

test("--ui with a ticket → CliError (it serves every listed project)", () => {
  expect(() => parseRunnerArgs(["PROJ-28", "--ui"])).toThrow(/does not take a ticket/);
});

test("unknown option → CliError (never mistaken for a ticket)", () => {
  expect(() => parseRunnerArgs(["--tikcet", "PROJ-318"])).toThrow(/Unknown option: --tikcet/);
  expect(() => parseRunnerArgs(["PROJ-318", "--nope"])).toThrow(CliError);
  expect(() => parseRunnerArgs(["--pipeline=p.ts"])).toThrow(/Unknown option/);
});

test("first positional is the ticket; later ones are ignored", () => {
  const a = parseRunnerArgs(["PROJ-1", "PROJ-2"]);
  expect(a.ticket).toBe("PROJ-1");
});

test("lancenuit create parses the name and command", () => {
  const a = parseRunnerArgs(["feature", "--create", "--command", "make test"]);
  expect(a.ticket).toBe("feature");
  expect(a.create).toBe(true);
  expect(a.createCommand).toBe("make test");
});

test("--command without --create is rejected", () => {
  expect(() => parseRunnerArgs(["feature", "--command", "make test"])).toThrow(/requires --create/);
});

test("--create requires a name and a non-empty command", () => {
  expect(() => parseRunnerArgs(["--create", "--command", "make test"])).toThrow(/requires a pipeline name/);
  expect(() => parseRunnerArgs(["feature", "--create"])).toThrow(/requires --command/);
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "  "])).toThrow(/non-empty command/);
});

test("--template selects a starting point and decides whether a command applies", () => {
  const agent = parseRunnerArgs(["feature", "--create", "--template", "agent"]);
  expect(agent.createTemplate).toBe("agent");
  expect(agent.createCommand).toBeUndefined();

  // A template that runs no shell command must reject one rather than drop it.
  expect(() => parseRunnerArgs(["feature", "--create", "--template", "agent", "--command", "make test"])).toThrow(
    /does not accept --command/,
  );
  expect(() => parseRunnerArgs(["feature", "--create", "--template", "checked"])).toThrow(/requires --command/);
  expect(() => parseRunnerArgs(["feature", "--create", "--template", "nope"])).toThrow(/Unknown template/);
  expect(() => parseRunnerArgs(["feature", "--template", "agent"])).toThrow(/--template requires --create/);
});

test("execution flags are incompatible with --create", () => {
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "make test", "--fresh"])).toThrow(
    /--fresh.*incompatible/,
  );
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "make test", "--pipeline", "x.ts"])).toThrow(
    /--pipeline.*incompatible/,
  );
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "make test", "--lint-config"])).toThrow(
    /--lint-config.*incompatible/,
  );
});

test("--budget accepts a decimal amount and is not propagated to children", () => {
  const a = parseRunnerArgs(["PROJ-28", "--budget", "12.50"]);
  expect(a.budget).toBe(12.5);
  // Orchestration computes each child ceiling; a human approval is not inherited.
  expect(a.passthrough).not.toContain("--budget");
});

test("--budget absent → undefined (the pipeline ceiling applies)", () => {
  expect(parseRunnerArgs(["PROJ-28"]).budget).toBeUndefined();
});

test("--budget zero, negative, or non-numeric → CliError", () => {
  for (const value of ["0", "-3", "abc"]) {
    expect(() => parseRunnerArgs(["PROJ-28", "--budget", value])).toThrow(CliError);
  }
});

test("--budget on an inspection command → CliError", () => {
  expect(() => parseRunnerArgs(["PROJ-28", "--inspect", "--budget", "20"])).toThrow(CliError);
});

test("--budget with --scan → CliError (an approval targets one run)", () => {
  expect(() => parseRunnerArgs(["--scan", "--budget", "20"])).toThrow(CliError);
});

test("--create rejects every run option, derived from the FLAGS registry", () => {
  // The rejection list used to be hand-maintained, and --budget had never been
  // added to it: `--create --budget` was silently accepted.
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "make test", "--budget", "5"])).toThrow(
    /--budget.*incompatible/,
  );
  // Every non-hidden option that is neither global nor claimed by --create must
  // be rejected, so a NEW option needs no entry anywhere to be incompatible.
  const foreign = FLAGS.filter((spec) => !spec.global && !spec.commands?.includes("create") && !spec.hidden);
  for (const spec of foreign) {
    const argv = ["feature", "--create", "--command", "make test", spec.long];
    if (spec.kind !== "boolean") argv.push(spec.kind === "number" || spec.kind === "amount" ? "1" : "x");
    expect(() => parseRunnerArgs(argv)).toThrow(CliError);
  }
});

test("--create accepts the options it owns, plus the global ones", () => {
  const a = parseRunnerArgs(["feature", "--create", "--command", "make test", "--user"]);
  expect(a.create).toBe(true);
  expect(a.user).toBe(true);
  // --help belongs to no command: it is answered before --create ever runs.
  expect(() => parseRunnerArgs(["feature", "--create", "--command", "make test", "--help"])).not.toThrow();
});
