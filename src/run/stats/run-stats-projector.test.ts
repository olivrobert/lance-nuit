import { expect, test } from "bun:test";
import type { Run } from "../record/run.js";
import { createLogRef, type RunLogStore } from "../storage-ports.js";
import { makeRunStep } from "../record/run-step.js";
import { projectRunStatsEntry } from "./run-stats-projector.js";

function runWithStores(logStore?: RunLogStore): Run {
  return {
    runId: "run-pure-projector",
    name: "quality",
    ticket: "PROJ-42",
    pipeline: "quality",
    pipeline_path: "quality.ts",
    // This path does not exist; the projector must not consult it.
    run_dir: "/path/that/does/not/exist",
    status: "FAIL",
    steps: [
      makeRunStep(
        { id: "quality.tests", name: "Tests", command: "test", profile: "reviewer" },
        {
          status: "failed",
          started_at: "2026-08-01T10:00:00.000Z",
          finished_at: "2026-08-01T10:01:00.000Z",
          control: { duration_ms: 60_000, model: "model-a" },
          usage: { input_tokens: 3, output_tokens: 7 },
          attempts: [
            {
              attempt: 1,
              kind: "step",
              status: "failed",
              started_at: "2026-08-01T10:00:01.000Z",
              log_path: "virtual/quality.tests/attempt-001/output.log",
            },
          ],
        },
      ),
    ],
    logStore,
  };
}

test("projectRunStatsEntry reads attempts from the snapshot and tails from the log store: validates the contract", () => {
  const logReads: string[] = [];
  const logStore: RunLogStore = {
    allocate: (run, stepId, attempt) => createLogRef(run, stepId, attempt),
    append: () => undefined,
    read: (log) => {
      logReads.push(`${log.run.runId}:${log.stepId}:${log.attempt}`);
      return "start\nthe last useful error\n";
    },
  };

  const entry = projectRunStatsEntry(runWithStores(logStore), { ticketDir: "PROJ-42" });

  expect(logReads).toEqual(["run-pure-projector:quality.tests:1"]);
  expect(entry.schemaVersion).toBe(1);
  expect(entry.ticketDir).toBe("PROJ-42");
  expect(entry.phases["quality.tests"]?.fixLoops).toBe(0);
  expect(entry.fixEvents).toEqual([
    {
      kind: "fail",
      phase: "quality.tests",
      iter: 1,
      contract: "quality.tests",
      details: "start\nthe last useful error",
      logPath: "virtual/quality.tests/attempt-001/output.log",
    },
  ]);
});

test("run-stats-projector: validates the integration contract", () => {
  const logStore: RunLogStore = {
    allocate: (run, stepId, attempt) => createLogRef(run, stepId, attempt),
    append: () => undefined,
    read: () => null,
  };
  const entry = projectRunStatsEntry({ ...runWithStores(logStore), steps: [] }, { ticketDir: "PROJ-42" });
  expect(entry.schemaVersion).toBe(1);
  expect(entry.fixEvents).toEqual([]);
});

test("run-stats-projector: an aborted attempt marks its phase partial and fabricates no fix event", () => {
  const run = runWithStores();
  run.status = "ABORTED";
  const step = run.steps[0]!;
  step.status = "aborted";
  step.control = { duration_ms: 60_000, total_cost_usd: 0.4, model: "model-a", cost_estimated: true };
  step.attempts[0]!.status = "aborted";

  const bare = projectRunStatsEntry(run, { ticketDir: "PROJ-42" });

  expect(bare.phases["quality.tests"]).toMatchObject({ costUsd: 0.4, usageStatus: "partial", costStatus: "partial" });
  expect(bare.warnings).toEqual([
    {
      phase: "quality.tests",
      reason: "usage/cost unavailable or partial: attempt interrupted before its usage report",
    },
  ]);
  // Aborted is not failed: no fix event is fabricated from it.
  expect(bare.fixEvents).toEqual([]);
});

test("run-stats-projector: a node composing pipelines is attributed to no model", () => {
  // Snapshots written before the fix carry the child's last model on the node; its
  // tokens are the whole subtree's, and the child entries already break them down.
  const run = runWithStores();
  const step = run.steps[0]!;
  step.control = { duration_ms: 60_000, total_cost_usd: 7.4, model: "claude-haiku-4-5" };
  step.usage = { input_tokens: 400, output_tokens: 2000 };
  step.orchestration = { kind: "forEachPipeline", children: [] };

  const entry = projectRunStatsEntry(run, { ticketDir: "PROJ-42" });

  expect(entry.models).toEqual({});
  expect(entry.phases["quality.tests"]).toMatchObject({ costUsd: 7.4, tokens: { in: 400, out: 2000 } });
  expect(entry.costUsd).toBeCloseTo(7.4, 8);
});
