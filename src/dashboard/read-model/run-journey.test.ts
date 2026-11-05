import { afterEach, expect, test } from "bun:test";
import { readRunJourney } from "./run-journey.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  writeProjectsFile,
  writeRun,
  writeRunEvents,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(): string {
  const kit = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = kit;
  const project = makeProject("demo-app");
  writeProjectsFile(kit, [project]);
  return project;
}

function attempt(ts: string, stepId: string, n: number, end: string, extra: Record<string, unknown> = {}) {
  return [
    { ts, type: "step.attempt.started", stepId, attempt: n, kind: "step" },
    { ts: end, type: "step.attempt.finished", stepId, attempt: n, kind: "step", status: "done", ...extra },
  ];
}

/** A run that stopped at a review gate, was approved and resumed, and replayed
 *  the gate's step: the journal as the runner appends it. */
function gatedRun(project: string): string {
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    createdAt: "2026-09-05T07:00:00.000Z",
    max_cost_usd: 15,
    steps: [
      { id: "implement", status: "done", retries: 0 },
      { id: "review", status: "done", retries: 0 },
    ],
  });
  writeRunEvents(runDir, [
    { ts: "2026-09-05T07:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "DEMO-1" },
    ...attempt("2026-09-05T07:00:01.000Z", "implement", 1, "2026-09-05T07:10:00.000Z", {
      control: { duration_ms: 599000, total_cost_usd: 1.2, model: "claude-opus-5-5" },
    }),
    {
      ts: "2026-09-05T07:10:01.000Z",
      type: "run.stopped",
      phase: "review",
      reason: "awaiting approval",
      logPath: null,
    },
    { ts: "2026-09-05T07:10:02.000Z", type: "run.finished", status: "STOPPED" },
    { ts: "2026-09-05T08:00:00.000Z", type: "run.resumed", pipeline: "feature" },
    { ts: "2026-09-05T08:00:00.500Z", type: "decision.recorded", subject: "review", decision: "approved" },
    ...attempt("2026-09-05T08:00:01.000Z", "review", 2, "2026-09-05T08:00:02.000Z"),
    { ts: "2026-09-05T08:00:03.000Z", type: "decision.recorded", subject: "other", decision: "rejected" },
  ]);
  return runDir;
}

test("every attempt of the run comes in the order it started, named after its step", () => {
  const project = listedProject();
  gatedRun(project);

  const journey = readRunJourney("demo-app", "DEMO-1");

  expect(journey?.attempts.map((entry) => [entry.stepId, entry.attempt])).toEqual([
    ["implement", 1],
    ["review", 2],
  ]);
  expect(journey?.attempts[0]).toMatchObject({ costUsd: 1.2, model: "claude-opus-5-5", status: "done" });
  expect(journey?.maxCostUsd).toBe(15);
  expect(journey?.startedAt).toBe("2026-09-05T07:00:00.000Z");
});

test("a pause runs from the run's last line to the resume, with the decision the resume carried", () => {
  const project = listedProject();
  gatedRun(project);

  const journey = readRunJourney("demo-app", "DEMO-1");

  // The rejection journaled after a step ran belongs to no pause.
  expect(journey?.pauses).toEqual([
    {
      stoppedAt: "2026-09-05T07:10:02.000Z",
      resumedAt: "2026-09-05T08:00:00.000Z",
      reason: "awaiting approval",
      decision: "approved",
    },
  ]);
});

test("a runner that died without stopping still leaves a pause, with no reason", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", steps: [] });
  writeRunEvents(runDir, [
    { ts: "2026-09-05T07:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "DEMO-1" },
    { ts: "2026-09-05T07:00:01.000Z", type: "step.attempt.started", stepId: "a", attempt: 1, kind: "step" },
    { ts: "2026-09-05T09:00:00.000Z", type: "run.resumed", pipeline: "feature" },
  ]);

  expect(readRunJourney("demo-app", "DEMO-1")?.pauses).toEqual([
    { stoppedAt: "2026-09-05T07:00:01.000Z", resumedAt: "2026-09-05T09:00:00.000Z" },
  ]);
});

test("a run stopped and not resumed yet ends on an open pause", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "STOPPED", steps: [] });
  writeRunEvents(runDir, [
    { ts: "2026-09-05T07:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "DEMO-1" },
    { ts: "2026-09-05T07:05:00.000Z", type: "run.stopped", phase: "gate", reason: "awaiting approval", logPath: null },
  ]);

  expect(readRunJourney("demo-app", "DEMO-1")?.pauses).toEqual([
    { stoppedAt: "2026-09-05T07:05:00.000Z", reason: "awaiting approval" },
  ]);
});

test("a work item with no run has no journey", () => {
  listedProject();

  expect(readRunJourney("demo-app", "DEMO-404")).toBeUndefined();
  expect(readRunJourney("unlisted", "DEMO-1")).toBeUndefined();
});
