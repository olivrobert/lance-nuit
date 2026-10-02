import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(60_000);
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

/** The reproduction of issue #1: `publish` fails until a manual fix creates `fixed`. */
function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), "start-at-cli-"));
  scratchRoots.push(cwd);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    "trace.log\nfixed\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(
    join(cwd, ".lance-nuit", "pipelines", "default.ts"),
    `export default ({ pipeline, bashStep }: any) => pipeline("startat")
  .add(bashStep({ id: "implement", name: "implement", command: "echo implement >> trace.log" }))
  .add(bashStep({ id: "acceptance", name: "acceptance", command: "echo acceptance >> trace.log" }))
  .add(bashStep({ id: "commit", name: "commit", command: "echo commit >> trace.log" }))
  .add(bashStep({ id: "publish", name: "publish", command: "echo publish >> trace.log && test -f fixed" }))
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

function trace(cwd: string): string[] {
  return readFileSync(join(cwd, "trace.log"), "utf8").trim().split("\n");
}

function latestRunId(cwd: string): string {
  return readlinkSync(join(cwd, ".lance-nuit", "work-items", "T-1", "runs", "startat", "latest"));
}

/** Runs the reproduction up to the replay that passes. */
function replayAfterFix(cwd: string) {
  expect(runRunner(cwd, "T-1").status).not.toBe(0);
  writeFileSync(join(cwd, "fixed"), "");
  return runRunner(cwd, "T-1", "--start-at", "acceptance");
}

test("--start-at replays the target and every later step after a manual fix", () => {
  const cwd = scratchProject();

  const replayed = replayAfterFix(cwd);

  expect(replayed.status).toBe(0);
  expect(trace(cwd)).toEqual(["implement", "acceptance", "commit", "publish", "acceptance", "commit", "publish"]);
});

test("--run on a PASS run with --start-at replays from the target in the same run", () => {
  const cwd = scratchProject();
  expect(replayAfterFix(cwd).status).toBe(0);
  const runId = latestRunId(cwd);

  const again = runRunner(cwd, "T-1", "--run", runId, "--start-at", "publish");

  expect(again.status).toBe(0);
  expect(trace(cwd).slice(-2)).toEqual(["publish", "publish"]);
  expect(latestRunId(cwd)).toBe(runId);
});
