// End-to-end coverage of the environment a step hands to the processes it starts.
//
// The runner passes its own state to the children it spawns for dispatch through
// RUNNER_* variables. A process started by a step must not see them: a runner it
// starts has to take the lock, apply the worktree guards and keep its events out
// of the parent journal, as if it had been started from the operator's shell.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutRunnerInternalEnv } from "../../src/exec/self-spawn.js";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
const liveFeedModule = resolve(import.meta.dir, "../../src/runtime/live-feed.ts");

/** The suite may itself run inside a step of a runner that leaks its state: the
 *  outer runner of each test must start clean, or it skips its own lock. */
function outerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...withoutRunnerInternalEnv(process.env), ...extra };
}

function runOuter(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: outerEnv(extra),
  });
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

/** `default` runs `command` as its only step; `inner` is what a nested runner
 *  targets, so a regression does not recurse through the nested step. */
function pipelines(dir: string, command: string): void {
  const pipelinesDir = join(dir, ".lance-nuit", "pipelines");
  mkdirSync(pipelinesDir, { recursive: true });
  writeFileSync(
    join(pipelinesDir, "default.ts"),
    `export default ({ pipeline, bashStep }: any) =>
  pipeline("outer")
    .add(bashStep({ id: "nested", name: "Nested", command: ${JSON.stringify(command)} }))
    .build();
`,
  );
  writeFileSync(
    join(pipelinesDir, "inner.ts"),
    `export default ({ pipeline, bashStep }: any) =>
  pipeline("inner")
    .add(bashStep({ id: "noop", name: "Noop", command: "true" }))
    .build();
`,
  );
}

function projectWith(command: (cwd: string) => string): string {
  const cwd = mkdtempSync(join(tmpdir(), "step-env-"));
  pipelines(cwd, command(cwd));
  return cwd;
}

/** Committed Git repository on `main` with an untracked `.lance-nuit/`, the
 *  layout a `--worktree` run needs. */
function repoWith(command: string): { repo: string; worktrees: string } {
  const repo = mkdtempSync(join(tmpdir(), "step-env-repo-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  pipelines(repo, command);
  return { repo, worktrees: mkdtempSync(join(tmpdir(), "step-env-root-")) };
}

function worktreePath(worktrees: string, repo: string, ticket: string): string {
  return join(worktrees, repo.split("/").pop()!, ticket.toLowerCase());
}

const nestedRunner = (...args: string[]) =>
  [process.execPath, runnerEntry, ...args].map((part) => `'${part}'`).join(" ");

test("a runner started by a step takes the project lock", () => {
  const cwd = projectWith((dir) => `cd '${dir}' && ${nestedRunner("L-2", "--pipeline", "inner")}`);

  const result = runOuter(cwd, ["L-1"]);

  expect(result.out).toContain("A runner is already active for this project");
  expect(result.status).toBe(1);
}, 60_000);

test("a --worktree runner started by a step applies the worktree guards", () => {
  const { repo, worktrees } = repoWith(nestedRunner("T2", "--worktree", "--pipeline", "inner"));

  const result = runOuter(repo, ["T1", "--worktree"], { WORKTREES_ROOT: worktrees });

  expect(result.out).toContain("--worktree from a worktree is not allowed");
  expect(result.status).toBe(1);
  expect(existsSync(worktreePath(worktrees, repo, "T2"))).toBe(false);
}, 60_000);

test("a process started by a step does not write to the parent journal", () => {
  // The marker goes only through liveFeedFilePath(), never to stdout, so the
  // step's own output capture cannot copy it into the journal.
  const foreign = [
    `import { appendFileSync } from "node:fs";`,
    `import { liveFeedFilePath } from ${JSON.stringify(liveFeedModule)};`,
    `appendFileSync(liveFeedFilePath(), JSON.stringify({ type: "foreign-marker" }) + "\\n");`,
  ].join("\n");
  const cwd = projectWith(() => `'${process.execPath}' -e '${foreign}' && echo visible-line`);

  const result = runOuter(cwd, ["J-1"]);
  expect(result.status).toBe(0);

  const journals = readdirSync(join(cwd, ".lance-nuit"), { recursive: true, encoding: "utf8" }).filter(
    (entry) => entry.endsWith("events.jsonl") && !entry.includes("latest"),
  );
  expect(journals).toHaveLength(1);
  const journal = readFileSync(join(cwd, ".lance-nuit", journals[0]!), "utf8");
  expect(journal).toContain('"type":"bash-output"');
  expect(journal).toContain("visible-line");
  expect(journal).not.toContain("foreign-marker");
}, 60_000);
