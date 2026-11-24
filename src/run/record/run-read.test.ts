import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedRun } from "../persisted.js";
import { lastFeedEvent, readListedRun, readRun, readRunHistory } from "./run-read.js";

/** Above `pid_max` on every supported platform: the lock is unambiguously stale. */
const DEAD_PID = 2147483646;

const LOCATION = { cwd: "/nowhere", specPath: "work-items" };

/** A runner that died with `coder` running. Its journal and feed run ahead of
 *  the snapshot: no reader may take a status or a figure from them. */
function runningRun(state: Partial<PersistedRun> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "run-read-"));
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "feature",
      pipeline: "feature",
      runId: "r-1",
      status: "RUNNING",
      steps: [
        { id: "plan", status: "done", retries: 0 },
        {
          id: "coder",
          status: "running",
          retries: 0,
          control: { duration_ms: 1000, total_cost_usd: 0.1 },
          attempts: [
            {
              attempt: 1,
              kind: "step",
              status: "running",
              started_at: "2026-09-05T08:00:00.000Z",
              log_path: "steps/coder/attempt-001/output.log",
            },
          ],
        },
        { id: "review", status: "pending", retries: 0 },
      ],
      ...state,
    }),
  );
  const events = [
    { ts: "2026-09-05T08:00:00.000Z", type: "step.attempt.started", stepId: "coder", attempt: 1, kind: "step" },
    {
      ts: "2026-09-05T08:05:00.000Z",
      type: "step.attempt.finished",
      stepId: "coder",
      attempt: 1,
      kind: "step",
      status: "done",
      control: { duration_ms: 4000, total_cost_usd: 0.4 },
    },
    { ts: "2026-09-05T08:05:01.000Z", type: "step.status.changed", stepId: "coder", status: "done" },
    { ts: "2026-09-05T08:05:02.000Z", type: "not.a.contract.event" },
  ];
  writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(
    join(dir, "feed.jsonl"),
    `${JSON.stringify({ ts: "2026-09-05T08:05:02.000Z", type: "agent.output", text: "a live-feed line" })}\n`,
  );
  return dir;
}

function lock(dir: string, pid: number): void {
  writeFileSync(join(dir, "runner.lock"), JSON.stringify({ pid }));
}

const statuses = (state: PersistedRun | undefined) => state?.steps.map((step) => [step.id, step.status]);

const SNAPSHOT_STATUSES = [
  ["plan", "done"],
  ["coder", "running"],
  ["review", "pending"],
];

test("readRun: a run whose runner died is read from its snapshot as is, whatever its journal says", () => {
  const dir = runningRun();
  lock(dir, DEAD_PID);

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ runDir: dir, status: "ABORTED", interrupted: true });
  expect(statuses(run?.state)).toEqual(SNAPSHOT_STATUSES);
  expect(run?.state.steps[1]?.control?.total_cost_usd).toBe(0.1);
  expect(run?.state.steps[1]?.attempts).toMatchObject([{ attempt: 1, status: "running" }]);
});

test("readRun: a run a live runner holds is read from its snapshot", () => {
  const dir = runningRun();
  lock(dir, process.ppid);

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ status: "RUNNING", interrupted: false });
  expect(statuses(run?.state)).toEqual(SNAPSHOT_STATUSES);
});

test("readRun: a run with a verdict reads its stored status", () => {
  const dir = runningRun({ status: "FAIL" });

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ status: "FAIL", interrupted: false });
  expect(statuses(run?.state)?.[1]).toEqual(["coder", "running"]);
});

test("readRun and readRunHistory: an unreadable journal costs the timeline only", () => {
  const dir = runningRun();
  lock(dir, DEAD_PID);
  const journal = join(dir, "events.jsonl");
  // A directory in place of the file: reading it fails with something else than ENOENT.
  rmSync(journal);
  mkdirSync(journal);

  const run = readRun(dir, LOCATION);
  if (!run) throw new Error("fixture not readable");

  expect(run.status).toBe("ABORTED");
  expect(statuses(run.state)?.[1]).toEqual(["coder", "running"]);
  const history = readRunHistory(dir, run.state);
  expect(history.events).toEqual([]);
  expect(history.attempts.get("coder")).toMatchObject([{ attempt: 1, status: "running" }]);
});

test("readRun: a missing, corrupt or version 1 snapshot reads as no run", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-read-"));
  expect(readRun(dir, LOCATION)).toBeNull();
  writeFileSync(join(dir, "state.json"), "{ not json");
  expect(readRun(dir, LOCATION)).toBeNull();
  expect(readRun(runningRun({ schemaVersion: 1 as never }), LOCATION)).toBeNull();
});

test("readListedRun: a snapshot listed without its directory has no holder", () => {
  const dir = runningRun();
  lock(dir, process.ppid);
  const { state } = readRun(dir, LOCATION) ?? {};
  if (!state) throw new Error("fixture not readable");

  const listed = readListedRun({ state }, LOCATION);

  expect(listed).toMatchObject({ runDir: "", status: "ABORTED", interrupted: true });
  expect(listed.state).toBe(state);
  expect(readListedRun({ state, runDir: dir }, LOCATION)).toMatchObject({ status: "RUNNING", state });
});

test("readRunHistory: attempts from the snapshot, contracted events from the journal", () => {
  const dir = runningRun();
  const { state } = readRun(dir, LOCATION) ?? {};
  if (!state) throw new Error("fixture not readable");

  const history = readRunHistory(dir, state);

  expect(history.attempts.get("coder")).toMatchObject([{ attempt: 1, status: "running" }]);
  expect(history.attempts.get("plan")).toEqual([]);
  expect(history.events.map((event) => event.type)).toEqual([
    "step.attempt.started",
    "step.attempt.finished",
    "step.status.changed",
  ]);
});

test("lastFeedEvent: the last line of the feed, never the journal", () => {
  const dir = runningRun();
  expect(lastFeedEvent(dir, 64 * 1024)).toMatchObject({ type: "agent.output" });
  rmSync(join(dir, "feed.jsonl"));
  expect(lastFeedEvent(dir, 64 * 1024)).toBeUndefined();
});
