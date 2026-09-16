import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listItems } from "./items.ts";
import { isPidAlive, latestLaunchByItem, readLaunches, readLaunchesFor } from "./launches.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile, writeRun } from "./test-harness.ts";
import type { LaunchRecord } from "./types.ts";

afterEach(() => cleanupTempDirs());

function writeLaunch(home: string, record: LaunchRecord): void {
  const dir = join(home, "ui", "launches");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
}

function record(fields: Partial<LaunchRecord>): LaunchRecord {
  return {
    id: "20260905T080000000Z-DEMO-1-rerun",
    at: "2026-09-05T08:00:00.000Z",
    by: "Olivier",
    project: "demo-app",
    ticket: "DEMO-1",
    verb: "rerun",
    argv: ["run", "DEMO-1", "--pipeline", "feature"],
    cwd: "/srv/demo-app",
    pid: process.pid,
    ...fields,
  };
}

test("launches: this process is alive, an impossible pid is not", () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(0)).toBe(false);
  expect(isPidAlive(-1)).toBe(false);
  expect(isPidAlive(2 ** 30)).toBe(false);
});

test("launches: records are read newest first, liveness derived from the pid, junk skipped", () => {
  const home = makeTempDir("read-model-home-");
  writeLaunch(home, record({ id: "20260905T080000000Z-DEMO-1-rerun" }));
  writeLaunch(home, record({ id: "20260905T090000000Z-DEMO-1-fresh", at: "2026-09-05T09:00:00.000Z", exitCode: 1 }));
  writeFileSync(join(home, "ui", "launches", "notes.json"), '{"not":"a launch"}');
  writeFileSync(join(home, "ui", "launches", "broken.json"), "{");
  const env = { ...process.env, PIPELINE_HOME: home };

  const launches = readLaunches({ env });
  expect(launches.map((launch) => [launch.id, launch.alive])).toEqual([
    ["20260905T090000000Z-DEMO-1-fresh", false],
    ["20260905T080000000Z-DEMO-1-rerun", true],
  ]);
  expect(readLaunchesFor("demo-app", "DEMO-1", { env })).toHaveLength(2);
  expect(readLaunchesFor("demo-app", "DEMO-2", { env })).toHaveLength(0);
  expect(latestLaunchByItem({ env }).get("demo-app/DEMO-1")?.id).toBe("20260905T090000000Z-DEMO-1-fresh");
});

test("launches: no launch directory yet means no launches, not an error", () => {
  const home = makeTempDir("read-model-home-");
  expect(readLaunches({ env: { ...process.env, PIPELINE_HOME: home } })).toEqual([]);
});

test("items: a live launch puts a stopped item in the running group, a finished one leaves it where the disk says", async () => {
  const home = makeTempDir("read-model-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "STOPPED", updatedAt: "2026-09-05T07:00:00.000Z" });
  writeRun(project, "DEMO-2", "feature", { runId: "r-2", status: "FAIL", updatedAt: "2026-09-05T07:00:00.000Z" });
  writeLaunch(home, record({ id: "20260905T080000000Z-DEMO-1-rerun", pid: process.pid }));
  writeLaunch(home, record({ id: "20260905T080000000Z-DEMO-2-rerun", ticket: "DEMO-2", exitCode: 1 }));

  const items = await listItems({ env: { ...process.env, PIPELINE_HOME: home } });
  const first = items.find((item) => item.ticket === "DEMO-1");
  const second = items.find((item) => item.ticket === "DEMO-2");
  expect(first?.group).toBe("running");
  expect(first?.status).toBe("STOPPED");
  expect(first?.launch).toMatchObject({ id: "20260905T080000000Z-DEMO-1-rerun", alive: true });
  expect(second?.group).toBe("failure");
  expect(second?.launch).toMatchObject({ exitCode: 1, alive: false });
});

test("items: a run stopped by its budget carries the flag the budget verb needs", async () => {
  const home = makeTempDir("read-model-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "FAIL", budget_exceeded: true });
  writeRun(project, "DEMO-2", "feature", { runId: "r-2", status: "FAIL" });

  const items = await listItems({ env: { ...process.env, PIPELINE_HOME: home } });
  expect(items.find((item) => item.ticket === "DEMO-1")?.budgetExceeded).toBe(true);
  expect(items.find((item) => item.ticket === "DEMO-2")?.budgetExceeded).toBeUndefined();
});
