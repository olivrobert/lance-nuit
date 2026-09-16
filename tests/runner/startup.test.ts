// The pre-run phases of the entry point, tested WITHOUT a process boundary.
//
// These phases used to be inline in `main()`, each ending in `process.exit`, so
// none of them could be asserted on: the only way to reach them was to spawn the
// binary. They now return their outcome and `runner.ts` owns the single exit.

import { expect, test } from "bun:test";
import { checkRunArgs, parseArgs, runEarlyCommand } from "../../src/entry/startup.ts";
import { parseRunnerArgs } from "../../src/cli/parse.ts";

test("parseArgs turns a usage error into a reportable message, not a throw", () => {
  const outcome = parseArgs(["--nope"]);
  expect(outcome.kind).toBe("error");
  if (outcome.kind === "error") expect(outcome.message).toMatch(/Unknown option: --nope/);
});

test("parseArgs returns the parsed arguments for a valid invocation", () => {
  const outcome = parseArgs(["PROJ-28", "--fresh"]);
  expect(outcome.kind).toBe("args");
  if (outcome.kind === "args") {
    expect(outcome.args.ticket).toBe("PROJ-28");
    expect(outcome.args.fresh).toBe(true);
  }
});

test("checkRunArgs rejects a ticket that could reach the filesystem", () => {
  // The ticket derives context paths and the worktree directory, so its shape is
  // validated BEFORE boot.
  for (const ticket of ["PROJ 28", "../escape", "a/../b"]) {
    expect(checkRunArgs({ ...parseRunnerArgs([]), ticket })).toMatch(/Ticket must be/);
  }
});

test("checkRunArgs accepts an identifier and a work-item path", () => {
  for (const ticket of ["PROJ-28", "exports/PROJ-1478", "a/b/c"]) {
    expect(checkRunArgs({ ...parseRunnerArgs([]), ticket })).toBeUndefined();
  }
});

test("checkRunArgs surfaces a dispatch usage error", () => {
  // --scan forbids a positional ticket; the strategy registry owns the message.
  expect(checkRunArgs(parseRunnerArgs(["--scan"]))).toBeUndefined();
  expect(checkRunArgs({ ...parseRunnerArgs(["--scan"]), ticket: "PROJ-28" })).toBeTruthy();
});

test("runEarlyCommand returns undefined when the invocation is a run", async () => {
  expect(await runEarlyCommand(parseRunnerArgs(["PROJ-28"]))).toBeUndefined();
});
