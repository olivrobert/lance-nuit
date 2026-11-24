// End-to-end coverage of the entry point itself.
//
// Every other pipeline test calls `executeRunSteps` directly, so the phases
// around it — snapshot selection, the run header, the final report and its exit
// code — had no test at all while they were inline in `main()`. These runs go
// through `runner.ts` for real.

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
    .add(bashStep({ id: "hello", name: "Say hello", command: "printf 'hello\\\\n'", rerunOnResume: true }))
    .build();
`;

const FAILING = `export default ({ pipeline, bashStep, textArtifact }: any) =>
  pipeline("entry-fail")
    .add(bashStep({ id: "ok", name: "First", output: [textArtifact("ok.txt")],
      command: (ctx: any) => { const out = ctx.paths.artifact("ok.txt"); return "mkdir -p '" + out.slice(0, out.lastIndexOf("/")) + "' && printf ok > '" + out + "'"; } }))
    .add(bashStep({ id: "boom", name: "Failing", command: "exit 3", rerunOnResume: true }))
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
  // First declares an output: a resume re-checks it, and finds its stamp holding.
  expect(second.out).toContain("Re-checked on resume: First");
  expect(second.out).toContain("First — already completed: up to date");
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

/** The run's `state.json`, or `undefined` before the runner wrote it. */
function runState(cwd: string): Record<string, any> | undefined {
  const file = readdirSync(cwd, { recursive: true, encoding: "utf8" }).find(
    (entry) => entry.endsWith("state.json") && entry.includes("/runs/") && !entry.includes("/latest/"),
  );
  return file ? JSON.parse(readFileSync(join(cwd, file), "utf8")) : undefined;
}

test("a runner killed while its attempt runs leaves it running; the resume closes it as crashed before replaying", async () => {
  const cwd = projectWith(`export default ({ pipeline, bashStep }: any) =>
  pipeline("entry-crash")
    .add(bashStep({ id: "work", name: "Work", command: "test -f done.flag || sleep 30", rerunOnResume: true }))
    .build();
`);
  const runner = spawn(process.execPath, [runnerEntry, "CRASH-1"], { cwd, detached: true, stdio: "ignore" });
  try {
    const deadline = Date.now() + 20_000;
    while (runState(cwd)?.steps?.[0]?.attempts?.[0]?.status !== "running") {
      if (Date.now() > deadline) throw new Error("the attempt never reached running");
      await Bun.sleep(50);
    }
  } finally {
    process.kill(-runner.pid!, "SIGKILL");
  }
  await new Promise((done) => runner.once("exit", done));
  expect(runState(cwd)?.steps[0].attempts).toMatchObject([{ attempt: 1, status: "running" }]);
  expect(runState(cwd)?.steps[0].attempts[0].finished_at).toBeUndefined();

  writeFileSync(join(cwd, "done.flag"), "");
  const resumed = runEntry(cwd, "CRASH-1");

  expect(resumed.status).toBe(0);
  const [crashed, replayed] = runState(cwd)!.steps[0].attempts;
  expect(crashed).toMatchObject({
    attempt: 1,
    status: "failed",
    interrupted: true,
    errors: "runner died before the attempt reported its result (crash, OOM, or SIGKILL)",
  });
  expect(crashed.finished_at).toBeString();
  expect(replayed).toMatchObject({ attempt: 2, status: "done" });
}, 30_000);

/** A non-blocking step that fails: the step loop absorbs it and warns, which is
 *  the shortest real path from `absorbNonBlocking` to an operator's terminal. */
const NON_BLOCKING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("entry-warn")
    .add(bashStep({ id: "soft", name: "Soft check", command: "exit 3", blocking: false, rerunOnResume: true }))
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
    (entry) => entry.endsWith("feed.jsonl") && !entry.includes("/latest/"),
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
