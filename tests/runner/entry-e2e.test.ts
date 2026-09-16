// End-to-end coverage of the entry point itself.
//
// Every other pipeline test calls `executeRunSteps` directly, so the phases
// around it — snapshot selection, the run header, the final report and its exit
// code — had no test at all while they were inline in `main()`. These runs go
// through `runner.ts` for real.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");

/** A project with one `default` pipeline, ready for `runner.ts` to boot into. */
function projectWith(pipelineSource: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "runner-entry-"));
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", "default.ts"), pipelineSource);
  return cwd;
}

function runEntry(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [runnerEntry, ...args], { cwd, encoding: "utf8" });
  // The runner logs progress and the report to stderr; only command output uses stdout.
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

const PASSING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("entry-smoke")
    .add(bashStep({ id: "hello", name: "Say hello", command: "printf 'hello\\\\n'" }))
    .build();
`;

const FAILING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("entry-fail")
    .add(bashStep({ id: "ok", name: "First", command: "printf 'ok\\\\n'" }))
    .add(bashStep({ id: "boom", name: "Failing", command: "exit 3" }))
    .build();
`;

test("a passing run reports success and exits 0", () => {
  const result = runEntry(projectWith(PASSING), "SMOKE-1");
  expect(result.out).toContain("Pipeline: entry-smoke");
  expect(result.out).toContain("Ticket: SMOKE-1");
  expect(result.out).toContain("SUCCESS");
  expect(result.status).toBe(0);
});

test("a failing step exits 1, and the next invocation resumes after the done step", () => {
  const cwd = projectWith(FAILING);

  const first = runEntry(cwd, "FAIL-1");
  expect(first.status).toBe(1);

  // The resume header is what proves the snapshot was selected, not recreated.
  const second = runEntry(cwd, "FAIL-1");
  expect(second.out).toContain("Resumed — already done: First");
  expect(second.status).toBe(1);
});

test("a usage error is reported and exits 1 without booting", () => {
  const cwd = projectWith(PASSING);
  for (const [argv, expected] of [
    [["--nope"], /Unknown option: --nope/],
    [["PROJ 28"], /Ticket must be/],
  ] as const) {
    const result = runEntry(cwd, ...argv);
    expect(result.out).toMatch(expected);
    expect(result.status).toBe(1);
  }
});

/** A non-blocking step that fails: the step loop absorbs it and warns, which is
 *  the shortest real path from `absorbNonBlocking` to an operator's terminal. */
const NON_BLOCKING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("entry-warn")
    .add(bashStep({ id: "soft", name: "Soft check", command: "exit 3", blocking: false }))
    .build();
`;

test("a step-loop warning reaches stderr and the feed through the real fan-out", () => {
  // `NULL_RUN_OUTPUT` drops messages by contract, so nothing in the step loop
  // proves on its own that a warning is ever seen. Only the composition root
  // wires the console and the live feed together; this run is that wiring.
  const cwd = projectWith(NON_BLOCKING);

  const result = runEntry(cwd, "WARN-1");

  expect(result.out).toContain("⚠ Soft check — non-blocking warning");

  const feeds = readdirSync(cwd, { recursive: true, encoding: "utf8" }).filter(
    (entry) => entry.endsWith("events.jsonl") && !entry.includes("/latest/"),
  );
  expect(feeds).toHaveLength(1);
  const messages = readFileSync(join(cwd, feeds[0]!), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === "runner.message");

  // The glyph belongs to the console; the feed carries the severity as a field.
  const warning = messages.find((event) => event.level === "warn");
  expect(warning).toBeDefined();
  expect(String(warning!.message)).toContain("non-blocking warning");
  expect(String(warning!.message)).not.toContain("⚠");
});
