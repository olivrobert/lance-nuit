import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "../read-model/test-harness.js";
import { LAUNCH_RETENTION_DAYS, type LaunchRecord, openDashboardHome } from "./index.js";

afterEach(() => cleanupTempDirs());

function record(fields: Partial<LaunchRecord> = {}): LaunchRecord {
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

test("log tail: the last lines of a launch log, and 404 for an unknown or malformed id", () => {
  const home = makeTempDir("ui-home-");
  const dir = join(home, "ui", "launches");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(dir, "20260905T080000000Z-DEMO-1-rerun.log"), `${lines.join("\n")}\n`);
  const env = { ...process.env, PIPELINE_HOME: home };

  const tail = openDashboardHome(env).launches.logTail("20260905T080000000Z-DEMO-1-rerun", 20);
  expect(tail.status).toBe("ok");
  if (tail.status !== "ok") return;
  expect(tail.lines).toHaveLength(20);
  expect(tail.lines[0]).toBe("line 11");
  expect(tail.lines.at(-1)).toBe("line 30");
  expect(tail.truncated).toBe(true);

  expect(openDashboardHome(env).launches.logTail("nope", 20).status).toBe("not-found");
  expect(openDashboardHome(env).launches.logTail("../users", 20).status).toBe("not-found");
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
  const base = record();
  writeLaunch(dir, { ...base, id: "20260905T080000000Z-DEMO-1-rerun", pid: deadPid() });
  writeLaunch(dir, { ...base, id: "20260905T080100000Z-DEMO-2-rerun", ticket: "DEMO-2", pid: process.pid });
  const env = { ...process.env, PIPELINE_HOME: home };

  openDashboardHome(env).launches.reconcile(new Date("2026-09-05T09:00:00.000Z"));

  const dead = JSON.parse(readFileSync(join(dir, "20260905T080000000Z-DEMO-1-rerun.json"), "utf-8"));
  expect(dead).toMatchObject({ exitCode: null, finishedAt: "2026-09-05T09:00:00.000Z" });
  const alive = JSON.parse(readFileSync(join(dir, "20260905T080100000Z-DEMO-2-rerun.json"), "utf-8"));
  expect(alive.exitCode).toBeUndefined();
});

test("reconcile: launches older than the retention window lose both files (H1)", () => {
  const home = makeTempDir("ui-home-");
  const dir = join(home, "ui", "launches");
  const base = record();
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

  openDashboardHome({ ...process.env, PIPELINE_HOME: home }).launches.reconcile(new Date("2026-09-05T08:00:00.000Z"));

  expect(existsSync(join(dir, "old-DEMO-1-rerun.json"))).toBe(false);
  expect(existsSync(join(dir, "old-DEMO-1-rerun.log"))).toBe(false);
  expect(existsSync(join(dir, "recent-DEMO-1-rerun.json"))).toBe(true);
});
