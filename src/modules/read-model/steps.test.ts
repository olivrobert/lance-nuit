import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSteps } from "./steps.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  writeProjectsFile,
  writeRun,
  writeRunEvents,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

function home(): string {
  const dir = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = dir;
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(name = "demo-app"): string {
  const kit = home();
  const project = makeProject(name);
  writeProjectsFile(kit, [project]);
  return project;
}

test("steps: the snapshot order is kept, with what each step carries", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [
      {
        id: "spec",
        status: "done",
        retries: 0,
        started_at: "2026-09-05T07:00:00.000Z",
        finished_at: "2026-09-05T07:05:00.000Z",
      },
      { id: "excluded", status: "skipped", retries: 0 },
      { id: "tests", status: "failed", retries: 2, fail_kind: "verdict", errors: "3 tests failed" },
      // A block is reported beside the kind, not folded into it: "incident" sends
      // a reader to the logs, "blocked" to the environment.
      {
        id: "deploy",
        status: "failed",
        retries: 0,
        fail_kind: "technical",
        fail_cause: "blocked",
        errors: "API Claude: Not logged in",
      },
      { id: "review", status: "pending", retries: 0 },
    ],
  });

  const view = readSteps("demo-app", "DEMO-1");

  expect(view?.pipeline).toBe("feature");
  expect(view?.runId).toBe("r-1");
  expect(view?.status).toBe("FAIL");
  expect(view?.steps).toEqual([
    { id: "spec", status: "done", startedAt: "2026-09-05T07:00:00.000Z", finishedAt: "2026-09-05T07:05:00.000Z" },
    { id: "excluded", status: "skipped" },
    { id: "tests", status: "failed", retries: 2, failKind: "judgment", error: "3 tests failed" },
    {
      id: "deploy",
      status: "failed",
      failKind: "incident",
      failCause: "blocked",
      error: "API Claude: Not logged in",
    },
    { id: "review", status: "pending" },
  ]);
});

test("steps: a running run also reports the last line of its journal", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "RUNNING",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [{ id: "coder", status: "running", retries: 0 }],
  });
  writeRunEvents(runDir, [
    { ts: "2026-09-05T08:00:00.000Z", type: "run.started", runId: "r-1" },
    { ts: "2026-09-05T08:01:00.000Z", type: "step.attempt.started", runId: "r-1", stepId: "coder", attempt: 1 },
  ]);

  const view = readSteps("demo-app", "DEMO-1");

  expect(view?.lastEvent).toEqual({ type: "step.attempt.started", at: "2026-09-05T08:01:00.000Z", stepId: "coder" });
});

test("steps: a finished run reports no event; the snapshot already told the end", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [{ id: "coder", status: "done", retries: 0 }],
  });
  writeRunEvents(runDir, [{ ts: "2026-09-05T08:01:00.000Z", type: "run.finished", runId: "r-1" }]);

  expect(readSteps("demo-app", "DEMO-1")?.lastEvent).toBeUndefined();
});

test("steps: a truncated journal line never hides the events before it", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "RUNNING",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [{ id: "coder", status: "running", retries: 0 }],
  });
  writeFileSync(
    join(runDir, "events.jsonl"),
    '{"ts":"2026-09-05T08:00:00.000Z","type":"run.started"}\n{"ts":"2026-09-05T08:0',
  );

  expect(readSteps("demo-app", "DEMO-1")?.lastEvent).toEqual({ type: "run.started", at: "2026-09-05T08:00:00.000Z" });
});

test("steps: a run without a journal, and an item without a run", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "RUNNING", updatedAt: "2026-09-05T08:00:00.000Z" });

  expect(readSteps("demo-app", "DEMO-1")).toMatchObject({ steps: [], status: "RUNNING" });
  expect(readSteps("demo-app", "DEMO-1")?.lastEvent).toBeUndefined();
  expect(readSteps("demo-app", "DEMO-404")).toBeUndefined();
  expect(readSteps("unknown", "DEMO-1")).toBeUndefined();
});
