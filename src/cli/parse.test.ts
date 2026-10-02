// The ticket is either the first non-option token or `--ticket <id>`; neither is
// mandatory. These cases pin the parser so the Bash wrapper can forward
// arguments verbatim instead of guessing which one is the ticket.

import { expect, test } from "bun:test";
import { parseRunnerArgs } from "./parse.ts";

test("positional ticket may follow the options", () => {
  const args = parseRunnerArgs(["-p", "quality", "FOO-1"]);
  expect(args.ticket).toBe("FOO-1");
  expect(args.pipelinePath).toBe("quality");
});

test("--ticket names the work item like the positional form", () => {
  const args = parseRunnerArgs(["--ticket", "FOO-1", "-p", "quality"]);
  expect(args.ticket).toBe("FOO-1");
});

test("a run without ticket keeps ticket undefined", () => {
  const args = parseRunnerArgs(["-p", "quality"]);
  expect(args.ticket).toBeUndefined();
});

test("--ticket and a different positional identifier are refused", () => {
  expect(() => parseRunnerArgs(["--ticket", "FOO-1", "FOO-2"])).toThrow(/conflicts with the positional identifier/);
});

test("--ticket repeated as positional is accepted", () => {
  expect(parseRunnerArgs(["--ticket", "FOO-1", "FOO-1"]).ticket).toBe("FOO-1");
});

test("--allow-unmetered is a run flag, separate from --budget", () => {
  const args = parseRunnerArgs(["FOO-1", "--allow-unmetered"]);
  expect(args.allowUnmetered).toBe(true);
  expect(args.budget).toBeUndefined();
  // Not forwarded to self-spawned children, exactly like --budget: authorizing
  // spend is a decision about one run.
  expect(args.passthrough).toEqual([]);
});

test("--budget alone authorizes nothing unmetered", () => {
  const args = parseRunnerArgs(["FOO-1", "--budget", "20"]);
  expect(args.budget).toBe(20);
  expect(args.allowUnmetered).toBe(false);
});

test("--allow-unmetered is refused on an inspection command and under --scan", () => {
  expect(() => parseRunnerArgs(["FOO-1", "--inspect", "--allow-unmetered"])).toThrow(
    /applies to a run, not to an inspection command/,
  );
  expect(() => parseRunnerArgs(["--scan", "--allow-unmetered"])).toThrow(/authorizes one run/);
});

test("--reject records a rejection with its reason, --reject-only exits after recording", () => {
  const args = parseRunnerArgs(["FOO-1", "-p", "feature", "--reject", "plan", "--reason", "split step 2"]);
  expect(args).toMatchObject({ reject: "plan", reason: "split step 2", rejectOnly: false });
  expect(parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "no", "--reject-only"]).rejectOnly).toBe(true);
  expect(parseRunnerArgs(["FOO-1"]).rejectOnly).toBe(false);
});

test("--reject is refused without a ticket, without a reason, or beside another decision", () => {
  expect(() => parseRunnerArgs(["--reject", "plan", "--reason", "no"])).toThrow("Option --reject requires a ticket.");
  expect(() => parseRunnerArgs(["FOO-1", "--reject", "plan"])).toThrow(
    "Option --reject requires --reason <text>: the rework step reads it.",
  );
  expect(() => parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "   "])).toThrow(
    "Option --reason expects a non-empty text.",
  );
  expect(() => parseRunnerArgs(["FOO-1", "--reason", "no"])).toThrow("Option --reason requires --reject <subject>.");
  expect(() => parseRunnerArgs(["FOO-1", "--reject-only"])).toThrow(
    "Option --reject-only requires --reject <subject>.",
  );
  expect(() => parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "no", "--approve", "plan"])).toThrow(
    "--reject cannot be combined with --approve, --approve-only, or --clean.",
  );
  expect(() => parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "no", "--clean"])).toThrow(
    "--reject cannot be combined with --approve, --approve-only, or --clean.",
  );
  expect(() =>
    parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "no", "--reject-only", "--budget", "5"]),
  ).toThrow("Option --budget applies to a run, not to an inspection command.");
  expect(() =>
    parseRunnerArgs(["FOO-1", "--reject", "plan", "--reason", "no", "--reject-only", "--allow-unmetered"]),
  ).toThrow("Option --allow-unmetered applies to a run, not to an inspection command.");
});
