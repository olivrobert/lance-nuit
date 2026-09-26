import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDashboardHome } from "../dashboard-home/index.js";
import { cleanupTempDirs, makeTempDir } from "../read-model/test-harness.js";
import type { Item, LaunchRecord } from "../read-model/types.js";
import { type LaunchRequest, type LaunchResult, VerbLauncher } from "./launcher.js";

afterEach(() => cleanupTempDirs());

/** A stopped item at a gate, in a worktree, as the read model would build it. */
function item(overrides: Partial<Item> = {}): Item {
  return {
    key: "demo-app/DEMO-1",
    project: { name: "demo-app", cwd: "/srv/demo-app", provider: "jira" },
    ticket: "DEMO-1",
    pipeline: "feature",
    runId: "r-1",
    status: "STOPPED",
    group: "decision",
    stop: { subject: "plan", kind: "needs-decision", detail: "waiting for the plan" },
    cost: { estimated: false },
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    effectiveWorkItemDir: "/home/x/.lance-nuit/worktrees/demo-app/DEMO-1/.lance-nuit/work-items/DEMO-1",
    ...overrides,
  };
}

/** One launch through a launcher bound to `env`'s home. */
function launchVerb(request: LaunchRequest & { launcher: string; env: NodeJS.ProcessEnv }): LaunchResult {
  const { launcher, env, ...rest } = request;
  return new VerbLauncher({ launches: openDashboardHome(env).launches, env, executable: launcher }).launch(rest);
}

/** A stand-in for `bin/lancenuit`: it prints what it received and exits with
 *  the code the test asked for, so the launch record and the log can be read
 *  back and checked. */
function fakeLauncher(dir: string): string {
  const path = join(dir, "fake-lancenuit");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      'echo "argv: $*"',
      'echo "cwd: $PWD"',
      'echo "actor: $LANCENUIT_ACTOR"',
      'exit "$FAKE_EXIT"',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function waitForExit(path: string): Promise<LaunchRecord> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = JSON.parse(readFileSync(path, "utf-8")) as LaunchRecord;
    if (record.exitCode !== undefined) return record;
    if (Date.now() > deadline) throw new Error(`launch ${path} never finished`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

test("launch: the runner is spawned in the project's cwd with the actor set, and the record closes with its exit code", async () => {
  const home = makeTempDir("ui-home-");
  const project = makeTempDir("ui-project-");
  const launcher = fakeLauncher(makeTempDir("ui-bin-"));
  const env = { ...process.env, PIPELINE_HOME: home, FAKE_EXIT: "3" };

  const result = launchVerb({
    item: item({ project: { name: "demo-app", cwd: project, provider: "jira" } }),
    verb: "approve-and-rerun",
    argv: ["run", "DEMO-1", "--pipeline", "feature", "--approve", "plan", "--worktree"],
    by: "Olivier",
    launcher,
    env,
    now: new Date("2026-09-05T08:15:00.123Z"),
  });
  if (!result.ok) throw new Error(result.reason);

  expect(result.launch.id).toBe("20260905T081500123Z-DEMO-1-approve-and-rerun");
  expect(result.launch.pid).toBeGreaterThan(0);
  const jsonPath = join(home, "ui", "launches", `${result.launch.id}.json`);
  const record = await waitForExit(jsonPath);
  expect(record).toMatchObject({
    by: "Olivier",
    project: "demo-app",
    ticket: "DEMO-1",
    verb: "approve-and-rerun",
    cwd: project,
    exitCode: 3,
  });
  expect(typeof record.finishedAt).toBe("string");

  const log = readFileSync(join(home, "ui", "launches", `${result.launch.id}.log`), "utf-8");
  expect(log).toContain("argv: run DEMO-1 --pipeline feature --approve plan --worktree");
  expect(log).toContain(`cwd: ${project}`);
  expect(log).toContain("actor: Olivier");
});

test("launch: an executable that cannot start closes the record without a code and says so in the log", async () => {
  const home = makeTempDir("ui-home-");
  const project = makeTempDir("ui-project-");
  const result = launchVerb({
    item: item({ project: { name: "demo-app", cwd: project, provider: "jira" } }),
    verb: "rerun",
    argv: ["run", "DEMO-1"],
    by: "Olivier",
    launcher: join(project, "does-not-exist"),
    env: { ...process.env, PIPELINE_HOME: home, FAKE_EXIT: "0" },
  });
  if (!result.ok) throw new Error(result.reason);

  const record = await waitForExit(join(home, "ui", "launches", `${result.launch.id}.json`));
  expect(record.exitCode).toBeNull();
  const log = readFileSync(join(home, "ui", "launches", `${result.launch.id}.log`), "utf-8");
  expect(log).toContain("lancenuit could not be started");
});

test("launch: a record that cannot be closed does not throw out of the exit callback, and says so in the log", async () => {
  const home = makeTempDir("ui-home-");
  const project = makeTempDir("ui-project-");
  const launcher = fakeLauncher(makeTempDir("ui-bin-"));
  const env = { ...process.env, PIPELINE_HOME: home, FAKE_EXIT: "0" };
  const result = launchVerb({
    item: item({ project: { name: "demo-app", cwd: project, provider: "jira" } }),
    verb: "rerun",
    argv: ["run", "DEMO-1"],
    by: "Olivier",
    launcher,
    env,
  });
  if (!result.ok) throw new Error(result.reason);

  // Replace the record by a directory: the atomic rename over it fails at exit.
  const jsonPath = join(home, "ui", "launches", `${result.launch.id}.json`);
  rmSync(jsonPath);
  mkdirSync(jsonPath);

  const logPath = join(home, "ui", "launches", `${result.launch.id}.log`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !readFileSync(logPath, "utf-8").includes("launch record could not be closed")) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(readFileSync(logPath, "utf-8")).toContain("launch record could not be closed");
});
