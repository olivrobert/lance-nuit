import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "../read-model/test-harness.js";
import type { Item, LaunchRecord } from "../read-model/types.js";
import {
  buildArgv,
  isBusy,
  LAUNCH_RETENTION_DAYS,
  launchVerb,
  MAX_BUDGET_USD,
  readLaunchLogTail,
  reconcileLaunches,
} from "./actions.js";

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

function argvOf(result: ReturnType<typeof buildArgv>): string[] {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.argv;
}

test("argv: approve and rerun replays the run's pipeline, subject, and worktree mode", () => {
  expect(argvOf(buildArgv(item(), "approve-and-rerun", { subject: "plan" }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--approve",
    "plan",
    "--worktree",
  ]);
  expect(argvOf(buildArgv(item({ worktree: false }), "approve-and-rerun", { subject: "plan" }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--approve",
    "plan",
  ]);
});

test("argv: approve only goes through the approve verb, worktree included", () => {
  expect(argvOf(buildArgv(item(), "approve", { subject: "plan" }))).toEqual([
    "approve",
    "DEMO-1",
    "plan",
    "--pipeline",
    "feature",
    "--worktree",
  ]);
});

test("argv: the subject must be the pending gate, and a gate is required", () => {
  const other = buildArgv(item(), "approve", { subject: "spec" });
  expect(other).toMatchObject({ ok: false, status: 400 });
  const none = buildArgv(item(), "approve-and-rerun", {});
  expect(none).toMatchObject({ ok: false, status: 400 });
  const blocked = buildArgv(item({ stop: { kind: "blocked", detail: "BLOCKED: no branch" } }), "approve", {
    subject: "plan",
  });
  expect(blocked).toMatchObject({ ok: false, status: 409 });
  const failed = buildArgv(item({ status: "FAIL", group: "failure", stop: undefined }), "approve", {
    subject: "plan",
  });
  expect(failed).toMatchObject({ ok: false, status: 409 });
});

test("argv: rerun resumes a blocked stop or a failure, nothing else", () => {
  const blocked = item({ stop: { kind: "blocked", detail: "BLOCKED: no branch" } });
  expect(argvOf(buildArgv(blocked, "rerun"))).toEqual(["run", "DEMO-1", "--pipeline", "feature", "--worktree"]);
  const failed = item({ status: "FAIL", group: "failure", stop: undefined, worktree: false });
  expect(argvOf(buildArgv(failed, "rerun"))).toEqual(["run", "DEMO-1", "--pipeline", "feature"]);
  const aborted = item({ status: "ABORTED", group: "failure", stop: undefined });
  expect(buildArgv(aborted, "rerun").ok).toBe(true);
  expect(buildArgv(item(), "rerun")).toMatchObject({ ok: false, status: 409 });
  expect(buildArgv(item({ status: "PASS", group: "done", stop: undefined }), "rerun")).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("argv: fresh is allowed on everything that is not running", () => {
  expect(argvOf(buildArgv(item(), "fresh"))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--fresh",
    "--worktree",
  ]);
  expect(buildArgv(item({ status: "PASS", group: "done", stop: undefined }), "fresh").ok).toBe(true);
  expect(buildArgv(item({ status: "RUNNING", group: "running", stop: undefined }), "fresh")).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("argv: budget needs a budget stop and a bounded positive amount the server formats", () => {
  const stopped = item({ status: "FAIL", group: "failure", stop: undefined, budgetExceeded: true });
  expect(argvOf(buildArgv(stopped, "budget", { budget: 12.5 }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--budget",
    "12.5",
    "--worktree",
  ]);
  expect(argvOf(buildArgv(stopped, "budget", { budget: "7,00".replace(",", ".") }))).toContain("7");
  expect(buildArgv(stopped, "budget", { budget: -1 })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(stopped, "budget", { budget: 0 })).toMatchObject({ ok: false, status: 400 });
  // Positive, but rounds to "0" once formatted for the CLI: refused, not sent.
  expect(buildArgv(stopped, "budget", { budget: 0.001 })).toMatchObject({ ok: false, status: 400 });
  expect(argvOf(buildArgv(stopped, "budget", { budget: 0.005 }))).toContain("0.01");
  expect(buildArgv(stopped, "budget", { budget: MAX_BUDGET_USD + 1 })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(stopped, "budget", { budget: "12; rm -rf /" })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(item(), "budget", { budget: 5 })).toMatchObject({ ok: false, status: 409 });
});

test("argv: a running item, or one with a live launch of ours, refuses every verb", () => {
  const running = item({ status: "RUNNING", group: "running", stop: undefined });
  expect(isBusy(running)).toBe(true);
  const live = item({ launch: launchOf({ pid: process.pid, alive: true }) });
  expect(isBusy(live)).toBe(true);
  for (const verb of ["approve-and-rerun", "approve", "rerun", "fresh", "budget"] as const) {
    expect(buildArgv(live, verb, { subject: "plan", budget: 1 })).toMatchObject({ ok: false, status: 409 });
  }
  const closed = item({ launch: launchOf({ pid: process.pid, alive: false, exitCode: 0 }) });
  expect(isBusy(closed)).toBe(false);
});

function launchOf(fields: Partial<LaunchRecord> & { alive: boolean }): Item["launch"] {
  return {
    id: "20260905T080000000Z-DEMO-1-rerun",
    at: "2026-09-05T08:00:00.000Z",
    by: "Olivier",
    project: "demo-app",
    ticket: "DEMO-1",
    verb: "rerun",
    argv: ["run", "DEMO-1"],
    cwd: "/srv/demo-app",
    pid: 1,
    ...fields,
  };
}

// ───────────────────────── spawning ─────────────────────────

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

test("log tail: the last lines of a launch log, and 404 for an unknown or malformed id", () => {
  const home = makeTempDir("ui-home-");
  const dir = join(home, "ui", "launches");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(dir, "20260905T080000000Z-DEMO-1-rerun.log"), `${lines.join("\n")}\n`);
  const env = { ...process.env, PIPELINE_HOME: home };

  const tail = readLaunchLogTail("20260905T080000000Z-DEMO-1-rerun", 20, env);
  expect(tail.status).toBe("ok");
  if (tail.status !== "ok") return;
  expect(tail.lines).toHaveLength(20);
  expect(tail.lines[0]).toBe("line 11");
  expect(tail.lines.at(-1)).toBe("line 30");
  expect(tail.truncated).toBe(true);

  expect(readLaunchLogTail("nope", 20, env).status).toBe("not-found");
  expect(readLaunchLogTail("../users", 20, env).status).toBe("not-found");
});

// ───────────────────────── reconciliation at startup ─────────────────────────

function writeLaunch(dir: string, record: LaunchRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
  writeFileSync(join(dir, `${record.id}.log`), "some output\n");
}

/** A pid that is certainly dead: a process that just exited. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "0"]);
  if (!done.pid) throw new Error("could not spawn a process to get a dead pid");
  return done.pid;
}

test("reconcile: a launch left open by a previous server is closed when its pid is dead, kept when alive", () => {
  const home = makeTempDir("ui-home-");
  const dir = join(home, "ui", "launches");
  const base = launchOf({ alive: false }) as LaunchRecord;
  writeLaunch(dir, { ...base, id: "20260905T080000000Z-DEMO-1-rerun", pid: deadPid() });
  writeLaunch(dir, { ...base, id: "20260905T080100000Z-DEMO-2-rerun", ticket: "DEMO-2", pid: process.pid });
  const env = { ...process.env, PIPELINE_HOME: home };

  reconcileLaunches(env, new Date("2026-09-05T09:00:00.000Z"));

  const dead = JSON.parse(readFileSync(join(dir, "20260905T080000000Z-DEMO-1-rerun.json"), "utf-8"));
  expect(dead).toMatchObject({ exitCode: null, finishedAt: "2026-09-05T09:00:00.000Z" });
  const alive = JSON.parse(readFileSync(join(dir, "20260905T080100000Z-DEMO-2-rerun.json"), "utf-8"));
  expect(alive.exitCode).toBeUndefined();
});

test("reconcile: launches older than the retention window lose both files (H1)", () => {
  const home = makeTempDir("ui-home-");
  const dir = join(home, "ui", "launches");
  const base = launchOf({ alive: false }) as LaunchRecord;
  const old = new Date("2026-09-05T08:00:00.000Z");
  old.setDate(old.getDate() - LAUNCH_RETENTION_DAYS - 1);
  writeLaunch(dir, {
    ...base,
    id: "old-DEMO-1-rerun",
    at: old.toISOString(),
    exitCode: 0,
    finishedAt: old.toISOString(),
  });
  writeLaunch(dir, { ...base, id: "recent-DEMO-1-rerun", at: "2026-09-04T08:00:00.000Z", exitCode: 0 });

  reconcileLaunches({ ...process.env, PIPELINE_HOME: home }, new Date("2026-09-05T08:00:00.000Z"));

  expect(existsSync(join(dir, "old-DEMO-1-rerun.json"))).toBe(false);
  expect(existsSync(join(dir, "old-DEMO-1-rerun.log"))).toBe(false);
  expect(existsSync(join(dir, "recent-DEMO-1-rerun.json"))).toBe(true);
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
