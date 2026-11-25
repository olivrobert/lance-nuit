// End-to-end coverage of `worktree-stop.sh` through the real entry point.
//
// Only a real `--worktree` process shows that the hook runs after the report and
// before the process exits, that only the runner which entered the worktree runs
// it, and that a Ctrl+C during the hook leaves the run's exit code alone.

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");

/** Committed Git repository on `main` with an untracked `.lance-nuit/`: the
 *  worktree reaches the pipeline through the shared `pipelines` link and the
 *  hook through the main-clone fallback. */
function repoWith(pipelineSource: string, stopHook: string): { repo: string; worktrees: string } {
  const repo = mkdtempSync(join(tmpdir(), "wt-stop-repo-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  mkdirSync(join(repo, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(join(repo, ".lance-nuit", "pipelines", "default.ts"), pipelineSource);
  writeFileSync(join(repo, ".lance-nuit", "worktree-stop.sh"), `${stopHook}\n`);
  return { repo, worktrees: mkdtempSync(join(tmpdir(), "wt-stop-root-")) };
}

/** Appends `$1` to a marker next to the hook, so a second run shows as a second line. */
const RECORDING_HOOK = 'echo "→ stopping services"\necho "$1" >> "$(dirname "$0")/stop.called"';

function envFor(worktrees: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { RUNNER_IN_WORKTREE: _inherited, RUNNER_LIVE_FEED: _feed, ...env } = process.env;
  return { ...env, WORKTREES_ROOT: worktrees, ...extra };
}

function runEntry(
  repo: string,
  worktrees: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string; out: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerEntry, ...args], {
      cwd: repo,
      env: envFor(worktrees, extra),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr, out: `${stdout}${stderr}` });
    });
  });
}

function stopCalls(repo: string): string[] {
  const marker = join(repo, ".lance-nuit", "stop.called");
  if (!existsSync(marker)) return [];
  return readFileSync(marker, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function worktreePath(worktrees: string, repo: string, ticket: string): string {
  return join(worktrees, repo.split("/").pop()!, ticket.toLowerCase());
}

/** Status of the run snapshot the worktree run left behind. The worktree only
 *  links the work item, and a recursive listing does not follow links: the
 *  snapshot is read from the main clone, where it lives. */
function runStatus(repo: string): string | undefined {
  const snapshots = readdirSync(join(repo, ".lance-nuit"), { recursive: true, encoding: "utf8" }).filter(
    (entry) => entry.endsWith("state.json") && !entry.includes("latest"),
  );
  expect(snapshots).toHaveLength(1);
  return JSON.parse(readFileSync(join(repo, ".lance-nuit", snapshots[0]!), "utf8")).status;
}

const PASSING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("stop-pass")
    .add(bashStep({ id: "hello", name: "Say hello", command: "true", rerunOnResume: true }))
    .build();
`;

const FAILING = `export default ({ pipeline, bashStep }: any) =>
  pipeline("stop-fail")
    .add(bashStep({ id: "boom", name: "Failing", command: "exit 3", rerunOnResume: true }))
    .build();
`;

const GATED = `export default ({ pipeline, bashStep }: any) =>
  pipeline("stop-gate")
    .add(bashStep({ id: "gated", name: "Gated", command: "true", rerunOnResume: true, when: { command: "false", else: "stop" } }))
    .build();
`;

test.concurrent("a failing --worktree run stops the stack after its report and exits 1", async () => {
  const { repo, worktrees } = repoWith(FAILING, RECORDING_HOOK);
  try {
    const result = await runEntry(repo, worktrees, ["--worktree", "STOP-1"]);

    expect(result.status).toBe(1);
    expect(stopCalls(repo)).toEqual([worktreePath(worktrees, repo, "STOP-1")]);
    const report = result.out.lastIndexOf("FAIL");
    expect(report).toBeGreaterThan(-1);
    expect(result.out.indexOf("→ stopping services")).toBeGreaterThan(report);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
}, 30_000);

test.concurrent("a gate stop runs the stop hook and exits 0", async () => {
  const { repo, worktrees } = repoWith(GATED, RECORDING_HOOK);
  try {
    const result = await runEntry(repo, worktrees, ["--worktree", "STOP-2"]);

    expect(result.status).toBe(0);
    expect(stopCalls(repo)).toEqual([worktreePath(worktrees, repo, "STOP-2")]);
    expect(result.out.indexOf("→ stopping services")).toBeGreaterThan(result.out.lastIndexOf("STOPPED"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
}, 30_000);

test.concurrent("a passing --worktree run keeps the stack running", async () => {
  const { repo, worktrees } = repoWith(PASSING, RECORDING_HOOK);
  try {
    const result = await runEntry(repo, worktrees, ["--worktree", "STOP-3"]);

    expect(result.status).toBe(0);
    expect(stopCalls(repo)).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
}, 30_000);

test.concurrent("a sub-runner (RUNNER_IN_WORKTREE=1) never runs the stop hook", async () => {
  const { repo, worktrees } = repoWith(FAILING, RECORDING_HOOK);
  try {
    const result = await runEntry(repo, worktrees, ["STOP-4"], { RUNNER_IN_WORKTREE: "1" });

    expect(result.status).toBe(1);
    expect(stopCalls(repo)).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
}, 30_000);

test.concurrent("one Ctrl+C during the stop hook lets it finish and keeps exit 1 and FAIL", async () => {
  const { repo, worktrees } = repoWith(
    FAILING,
    'touch "$(dirname "$0")/stop.started"\nsleep 0.4\ntouch "$(dirname "$0")/stop.done"',
  );
  try {
    const child = spawn(process.execPath, [runnerEntry, "--worktree", "STOP-5"], {
      cwd: repo,
      env: envFor(worktrees),
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));

    const started = join(repo, ".lance-nuit", "stop.started");
    while (!existsSync(started) && child.exitCode === null) await Bun.sleep(20);
    child.kill("SIGINT");

    expect(await exited).toBe(1);
    expect(existsSync(join(repo, ".lance-nuit", "stop.done"))).toBe(true);
    expect(runStatus(repo)).toBe("FAIL");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
}, 30_000);
