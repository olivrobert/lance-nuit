import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processStartToken } from "../../src/shared/env/lock.ts";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runRunner(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // The kit lives inside the scratch repository: a caller's LANCENUIT_ORIGIN would
  // record the run's origin there and dirty the tree the next run checks.
  const { LANCENUIT_ORIGIN: _origin, ...env } = process.env;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerEntry, ...args], {
      cwd,
      env: { ...env, PIPELINE_HOME: join(cwd, "shared-kit") },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), "strict-resume-cli-"));
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    ".counter\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(join(cwd, ".counter"), "0\n");
  writeFileSync(
    join(cwd, ".lance-nuit", "pipelines", "default.ts"),
    `export default ({ pipeline, bashStep, textArtifact }: any) => pipeline("strict-resume")
  .add(bashStep({
    id: "count",
    name: "Count once",
    output: [textArtifact("counted.txt")],
    command: (ctx: any) => {
      const out = ctx.paths.artifact("counted.txt");
      return "n=$(cat .counter); printf '%s\\n' $((n + 1)) > .counter && mkdir -p '" + out.slice(0, out.lastIndexOf("/")) + "' && touch '" + out + "'";
    },
  }))
  .add(bashStep({ id: "stop", name: "Stop here", command: "exit 17", rerunOnResume: true }))
  .build();
`,
  );
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "lance-nuit acceptance");
  git(cwd, "config", "user.email", "acceptance@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

/** The freshness lock belongs to the work item, so a `--fresh` run skips the step whose output is still stamped. */
function expectFreshRunSkippedCountAndReachedStop(runsRoot: string, runId: string, output: string) {
  expect(output).toContain("Count once — skipped: up to date");
  const state = JSON.parse(readFileSync(join(runsRoot, runId, "state.json"), "utf8"));
  expect(state.steps).toMatchObject([
    { id: "count", status: "skipped", attempts: [] },
    { id: "stop", status: "failed", attempts: [{ attempt: 1, status: "failed" }] },
  ]);
}

test.concurrent("damaged latest fails before replay, while --fresh preserves the old run", async () => {
  const cwd = scratchProject();
  try {
    const runsRoot = join(cwd, ".lance-nuit", "work-items", "STRICT-1", "runs", "strict-resume");
    const latest = join(runsRoot, "latest");

    const first = await runRunner(cwd, "STRICT-1");
    expect(first.status).toBe(1);
    expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
    expect(lstatSync(latest).isSymbolicLink()).toBe(true);
    const oldRunId = readlinkSync(latest);
    const oldRun = join(runsRoot, oldRunId);
    const state = join(oldRun, "state.json");
    const oldEvents = readFileSync(join(oldRun, "events.jsonl"), "utf8");
    const runsBeforeFailure = readdirSync(runsRoot).filter((name) => name !== "latest");
    writeFileSync(state, "{\n");

    const resumed = await runRunner(cwd, "STRICT-1");
    const resumedOutput = `${resumed.stdout}${resumed.stderr}`;
    expect(resumed.status).toBe(1);
    expect(resumedOutput).toContain(state);
    expect(resumedOutput).toContain("--fresh");
    expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
    expect(readlinkSync(latest)).toBe(oldRunId);
    expect(readFileSync(state, "utf8")).toBe("{\n");
    expect(readdirSync(runsRoot).filter((name) => name !== "latest")).toEqual(runsBeforeFailure);
    expect(readFileSync(join(oldRun, "events.jsonl"), "utf8")).toBe(oldEvents);

    const fresh = await runRunner(cwd, "STRICT-1", "--fresh");
    expect(fresh.status).toBe(1);
    const freshRunId = readlinkSync(latest);
    expect(freshRunId).not.toBe(oldRunId);
    expectFreshRunSkippedCountAndReachedStop(runsRoot, freshRunId, `${fresh.stdout}${fresh.stderr}`);
    expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
    expect(readFileSync(state, "utf8")).toBe("{\n");
    expect(readFileSync(join(oldRun, "events.jsonl"), "utf8")).toBe(oldEvents);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("explicit --run rejects damaged state without changing another latest run", async () => {
  const cwd = scratchProject();
  try {
    const runsRoot = join(cwd, ".lance-nuit", "work-items", "STRICT-1", "runs", "strict-resume");
    const latest = join(runsRoot, "latest");

    expect((await runRunner(cwd, "STRICT-1")).status).toBe(1);
    const oldRunId = readlinkSync(latest);
    const oldRun = join(runsRoot, oldRunId);
    const oldState = join(oldRun, "state.json");
    const oldLock = join(oldRun, "runner.lock");
    const oldLockBefore = existsSync(oldLock) ? readFileSync(oldLock, "utf8") : undefined;
    const damaged = "{\n";

    const fresh = await runRunner(cwd, "STRICT-1", "--fresh");
    expect(fresh.status).toBe(1);
    const currentRunId = readlinkSync(latest);
    expect(currentRunId).not.toBe(oldRunId);
    expectFreshRunSkippedCountAndReachedStop(runsRoot, currentRunId, `${fresh.stdout}${fresh.stderr}`);
    expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
    writeFileSync(oldState, damaged);

    const explicit = await runRunner(cwd, "STRICT-1", "--run", oldRunId);
    expect(explicit.status).toBe(1);
    expect(`${explicit.stdout}${explicit.stderr}`).toContain(oldState);
    expect(readlinkSync(latest)).toBe(currentRunId);
    expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
    expect(readFileSync(oldState, "utf8")).toBe(damaged);
    expect(existsSync(oldLock) ? readFileSync(oldLock, "utf8") : undefined).toBe(oldLockBefore);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** A live process that is not a runner, killed whatever the test outcome. */
async function withSleeper(run: (pid: number) => Promise<void>): Promise<void> {
  const sleeper = spawn("sleep", ["30"]);
  try {
    const pid = sleeper.pid;
    if (pid === undefined) throw new Error("sleep did not start");
    await run(pid);
  } finally {
    sleeper.kill();
  }
}

async function runsAfterFirstFailure(cwd: string) {
  const runsRoot = join(cwd, ".lance-nuit", "work-items", "STRICT-1", "runs", "strict-resume");
  expect((await runRunner(cwd, "STRICT-1")).status).toBe(1);
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
  const runId = readlinkSync(join(runsRoot, "latest"));
  const runDir = join(runsRoot, runId);
  return {
    runsRoot,
    runId,
    lock: join(runDir, "runner.lock"),
    events: join(runDir, "events.jsonl"),
    runs: readdirSync(runsRoot).filter((name) => name !== "latest"),
  };
}

test.concurrent("a recycled pid in runner.lock does not make the implicit resume start over", async () => {
  const cwd = scratchProject();
  try {
    const first = await runsAfterFirstFailure(cwd);
    await withSleeper(async (pid) => {
      // The dead runner's pid was recycled: only the pid changes, the recorded start
      // token is still the dead runner's.
      writeFileSync(first.lock, JSON.stringify({ ...JSON.parse(readFileSync(first.lock, "utf8")), pid }));
      const eventsBefore = readFileSync(first.events, "utf8");

      const resumed = await runRunner(cwd, "STRICT-1");
      expect(`${resumed.stdout}${resumed.stderr}`).not.toContain("held by another runner process");
      expect(JSON.parse(readFileSync(first.lock, "utf8")).pid).not.toBe(pid);
      expect(readFileSync(first.events, "utf8").length).toBeGreaterThan(eventsBefore.length);
      expect(resumed.status).toBe(1);
      expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
      expect(readdirSync(first.runsRoot).filter((name) => name !== "latest")).toEqual(first.runs);
      expect(readlinkSync(join(first.runsRoot, "latest"))).toBe(first.runId);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("a run held by a live runner stops the implicit resume with the options", async () => {
  const cwd = scratchProject();
  try {
    const first = await runsAfterFirstFailure(cwd);
    await withSleeper(async (pid) => {
      writeFileSync(first.lock, JSON.stringify({ pid, pidStart: processStartToken(pid) }));
      const lockBefore = readFileSync(first.lock, "utf8");
      const eventsBefore = readFileSync(first.events, "utf8");

      const refused = await runRunner(cwd, "STRICT-1");
      const output = `${refused.stdout}${refused.stderr}`;
      expect(refused.status).toBe(1);
      expect(output).toContain("held by another runner process");
      expect(output).toContain(`pid ${pid}`);
      expect(output).toContain("--run");
      expect(output).toContain("--fresh");
      expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
      expect(readdirSync(first.runsRoot).filter((name) => name !== "latest")).toEqual(first.runs);
      expect(readFileSync(first.lock, "utf8")).toBe(lockBefore);
      expect(readFileSync(first.events, "utf8")).toBe(eventsBefore);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
