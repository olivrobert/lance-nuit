import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(30_000);
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runRunner(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
  });
}

function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), "strict-resume-cli-"));
  scratchRoots.push(cwd);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    ".counter\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(join(cwd, ".counter"), "0\n");
  writeFileSync(
    join(cwd, ".lance-nuit", "pipelines", "default.ts"),
    `export default ({ pipeline, bashStep }: any) => pipeline("strict-resume")
  .add(bashStep({
    id: "count",
    name: "Count once",
    command: "n=$(cat .counter); printf '%s\\n' $((n + 1)) > .counter",
  }))
  .add(bashStep({ id: "stop", name: "Stop here", command: "exit 17" }))
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

test("damaged latest fails before replay, while --fresh preserves the old run", () => {
  const cwd = scratchProject();
  const runsRoot = join(cwd, ".lance-nuit", "work-items", "STRICT-1", "runs", "strict-resume");
  const latest = join(runsRoot, "latest");

  const first = runRunner(cwd, "STRICT-1");
  expect(first.status).toBe(1);
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
  expect(lstatSync(latest).isSymbolicLink()).toBe(true);
  const oldRunId = readlinkSync(latest);
  const oldRun = join(runsRoot, oldRunId);
  const state = join(oldRun, "state.json");
  const oldEvents = readFileSync(join(oldRun, "events.jsonl"), "utf8");
  const runsBeforeFailure = readdirSync(runsRoot).filter((name) => name !== "latest");
  writeFileSync(state, "{\n");

  const resumed = runRunner(cwd, "STRICT-1");
  const resumedOutput = `${resumed.stdout}${resumed.stderr}`;
  expect(resumed.status).toBe(1);
  expect(resumedOutput).toContain(state);
  expect(resumedOutput).toContain("--fresh");
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("1\n");
  expect(readlinkSync(latest)).toBe(oldRunId);
  expect(readFileSync(state, "utf8")).toBe("{\n");
  expect(readdirSync(runsRoot).filter((name) => name !== "latest")).toEqual(runsBeforeFailure);
  expect(readFileSync(join(oldRun, "events.jsonl"), "utf8")).toBe(oldEvents);

  const fresh = runRunner(cwd, "STRICT-1", "--fresh");
  expect(fresh.status).toBe(1);
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("2\n");
  const freshRunId = readlinkSync(latest);
  expect(freshRunId).not.toBe(oldRunId);
  expect(readFileSync(state, "utf8")).toBe("{\n");
  expect(readFileSync(join(oldRun, "events.jsonl"), "utf8")).toBe(oldEvents);
});

test("explicit --run rejects damaged state without changing another latest run", () => {
  const cwd = scratchProject();
  const runsRoot = join(cwd, ".lance-nuit", "work-items", "STRICT-1", "runs", "strict-resume");
  const latest = join(runsRoot, "latest");

  expect(runRunner(cwd, "STRICT-1").status).toBe(1);
  const oldRunId = readlinkSync(latest);
  const oldRun = join(runsRoot, oldRunId);
  const oldState = join(oldRun, "state.json");
  const oldLock = join(oldRun, "runner.lock");
  const oldLockBefore = existsSync(oldLock) ? readFileSync(oldLock, "utf8") : undefined;
  const damaged = "{\n";

  expect(runRunner(cwd, "STRICT-1", "--fresh").status).toBe(1);
  const currentRunId = readlinkSync(latest);
  expect(currentRunId).not.toBe(oldRunId);
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("2\n");
  writeFileSync(oldState, damaged);

  const explicit = runRunner(cwd, "STRICT-1", "--run", oldRunId);
  expect(explicit.status).toBe(1);
  expect(`${explicit.stdout}${explicit.stderr}`).toContain(oldState);
  expect(readlinkSync(latest)).toBe(currentRunId);
  expect(readFileSync(join(cwd, ".counter"), "utf8")).toBe("2\n");
  expect(readFileSync(oldState, "utf8")).toBe(damaged);
  expect(existsSync(oldLock) ? readFileSync(oldLock, "utf8") : undefined).toBe(oldLockBefore);
});
