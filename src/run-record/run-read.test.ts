import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedRun } from "../model/persisted.js";
import { lastJournalEvent, readListedRun, readRun, readRunHistory } from "./run-read.js";

/** Above `pid_max` on every supported platform: the lock is unambiguously stale. */
const DEAD_PID = 2147483646;

const LOCATION = { cwd: "/nowhere", specPath: "work-items" };

/** A runner that died after the journal recorded `coder` finished, before the
 *  snapshot did. */
function runBehindItsJournal(state: Partial<PersistedRun> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "run-read-"));
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "feature",
      pipeline: "feature",
      runId: "r-1",
      status: "RUNNING",
      steps: [
        { id: "plan", status: "done", retries: 0 },
        { id: "coder", status: "running", retries: 0, control: { duration_ms: 1000, total_cost_usd: 0.1 } },
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
    { ts: "2026-09-05T08:05:02.000Z", type: "agent.output", text: "a live-feed line" },
  ];
  writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return dir;
}

function lock(dir: string, pid: number): void {
  writeFileSync(join(dir, "runner.lock"), JSON.stringify({ pid }));
}

const statuses = (state: PersistedRun | undefined) => state?.steps.map((step) => [step.id, step.status]);

test("readRun: a run whose runner died reads the steps a resume would start from", () => {
  const dir = runBehindItsJournal();
  lock(dir, DEAD_PID);

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ runDir: dir, status: "ABORTED", interrupted: true });
  expect(statuses(run?.state)).toEqual([
    ["plan", "done"],
    ["coder", "done"],
    ["review", "pending"],
  ]);
  // The spend the snapshot had not recorded yet, as a resume restores it.
  expect(run?.state.steps[1]?.control?.total_cost_usd).toBe(0.4);
  expect(run?.state.steps[1]?.finished_at).toBe("2026-09-05T08:05:01.000Z");
});

test("readRun: a run a live runner holds is read from its snapshot, at most one write behind", () => {
  const dir = runBehindItsJournal();
  lock(dir, process.ppid);

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ status: "RUNNING", interrupted: false });
  expect(statuses(run?.state)).toEqual([
    ["plan", "done"],
    ["coder", "running"],
    ["review", "pending"],
  ]);
});

test("readRun: a verdict is written after every event of its pass, so its journal is not read", () => {
  // A journal that contradicts a verdict cannot be produced by the runner; it
  // stands here for "the journal was not parsed".
  const dir = runBehindItsJournal({ status: "FAIL" });

  const run = readRun(dir, LOCATION);

  expect(run).toMatchObject({ status: "FAIL", interrupted: false });
  expect(statuses(run?.state)?.[1]).toEqual(["coder", "running"]);
});

test("readRun: an unreadable journal costs the reconciliation, not the read", () => {
  const dir = runBehindItsJournal();
  lock(dir, DEAD_PID);
  const journal = join(dir, "events.jsonl");
  // A directory in place of the file: reading it fails with something else than ENOENT.
  rmSync(journal);
  mkdirSync(journal);

  const run = readRun(dir, LOCATION);

  expect(run?.status).toBe("ABORTED");
  expect(statuses(run?.state)?.[1]).toEqual(["coder", "running"]);
  expect(() => readRunHistory(dir)).toThrow();
});

test("readRun: a missing or corrupt snapshot reads as no run", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-read-"));
  expect(readRun(dir, LOCATION)).toBeNull();
  writeFileSync(join(dir, "state.json"), "{ not json");
  expect(readRun(dir, LOCATION)).toBeNull();
});

test("readListedRun: a snapshot listed without its directory has no journal and no holder", () => {
  const dir = runBehindItsJournal();
  const { state } = readRun(dir, LOCATION) ?? {};
  if (!state) throw new Error("fixture not readable");
  const raw = {
    ...state,
    steps: state.steps.map((step) => (step.id === "coder" ? { ...step, status: "running" as const } : step)),
  };

  const listed = readListedRun({ state: raw }, LOCATION);

  expect(listed).toMatchObject({ runDir: "", status: "ABORTED", interrupted: true });
  expect(statuses(listed.state)?.[1]).toEqual(["coder", "running"]);
  // With its directory, the same snapshot is projected like `readRun` does.
  expect(statuses(readListedRun({ state: raw, runDir: dir }, LOCATION).state)?.[1]).toEqual(["coder", "done"]);
});

test("readRunHistory: attempts numbered as a resume numbers them, and the contracted events", () => {
  const dir = runBehindItsJournal();

  const history = readRunHistory(dir);

  expect(history.attempts.get("coder")).toMatchObject([
    { attempt: 1, status: "done", control: { total_cost_usd: 0.4 } },
  ]);
  // The live-feed line is not a contracted event.
  expect(history.events.map((event) => event.type)).toEqual([
    "step.attempt.started",
    "step.attempt.finished",
    "step.status.changed",
  ]);
});

test("lastJournalEvent: the last line of the journal, a live-feed line included", () => {
  const dir = runBehindItsJournal();
  expect(lastJournalEvent(dir, 64 * 1024)).toMatchObject({ type: "agent.output" });
  expect(lastJournalEvent(mkdtempSync(join(tmpdir(), "run-read-")), 64 * 1024)).toBeUndefined();
});
