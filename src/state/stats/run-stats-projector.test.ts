import { expect, test } from "bun:test";
import type { RunJournalEvent } from "../../model/journal.js";
import type { Run } from "../../model/run.js";
import { createLogRef, type RunEventStore, type RunLogStore } from "../../model/storage-ports.js";
import { makeRunStep } from "../run-step.js";
import { projectRunStatsEntry } from "./run-stats-projector.js";

function runWithStores(eventStore?: RunEventStore, logStore?: RunLogStore): Run {
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
        },
      ),
    ],
    eventStore,
    logStore,
  };
}

test("projectRunStatsEntry reads facts from the event store: validates the contract", () => {
  const events: RunJournalEvent[] = [
    { ts: "2026-08-01T10:00:01.000Z", type: "step.attempt.started", stepId: "quality.tests", attempt: 1, kind: "step" },
    {
      ts: "2026-08-01T10:01:00.000Z",
      type: "step.attempt.finished",
      stepId: "quality.tests",
      attempt: 1,
      kind: "step",
      status: "failed",
      logPath: "virtual/quality.tests/attempt-001/output.log",
    },
  ];
  const eventReads: string[] = [];
  const eventStore: RunEventStore = {
    append: () => undefined,
    read: (runId) => {
      eventReads.push(runId);
      return events;
    },
  };
  const logReads: string[] = [];
  const logStore: RunLogStore = {
    allocate: (run, stepId, attempt) => createLogRef(run, stepId, attempt),
    append: () => undefined,
    read: (log) => {
      logReads.push(`${log.run.runId}:${log.stepId}:${log.attempt}`);
      return "start\nthe last useful error\n";
    },
  };

  const entry = projectRunStatsEntry(runWithStores(), { eventStore, logStore, ticketDir: "PROJ-42" });

  expect(eventReads).toEqual(["run-pure-projector", "run-pure-projector", "run-pure-projector"]);
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
  const eventStore: RunEventStore = { append: () => undefined, read: () => [] };
  const logStore: RunLogStore = {
    allocate: (run, stepId, attempt) => createLogRef(run, stepId, attempt),
    append: () => undefined,
    read: () => null,
  };
  const entry = projectRunStatsEntry(runWithStores(eventStore, logStore), { ticketDir: "PROJ-42" });
  expect(entry.schemaVersion).toBe(1);
  expect(entry.fixEvents).toEqual([]);
});

test("run-stats-projector: an abort event carrying costUsd and usage changes nothing in the projection", () => {
  // Phase figures come from the step totals; the journal only tells that an attempt
  // was aborted. Enriching the abort event must not be read as extra spend, nor
  // must the absence of those fields be what marks the phase as partial.
  const abortedRun = (): Run => {
    const run = runWithStores();
    run.status = "ABORTED";
    const step = run.steps[0]!;
    step.status = "aborted";
    step.control = { duration_ms: 60_000, total_cost_usd: 0.4, model: "model-a", cost_estimated: true };
    return run;
  };
  const events = (extra: Record<string, unknown>): RunJournalEvent[] => [
    { ts: "2026-08-01T10:00:01.000Z", type: "step.attempt.started", stepId: "quality.tests", attempt: 1, kind: "step" },
    {
      ts: "2026-08-01T10:01:00.000Z",
      type: "step.attempt.finished",
      stepId: "quality.tests",
      attempt: 1,
      kind: "step",
      status: "aborted",
      control: { duration_ms: 60_000, total_cost_usd: 0.4, model: "model-a", cost_estimated: true },
      logPath: "virtual/quality.tests/attempt-001/output.log",
      reason: "SIGINT: run interrupted manually",
      ...extra,
    },
  ];
  const storeOf = (list: RunJournalEvent[]): RunEventStore => ({ append: () => undefined, read: () => list });

  const bare = projectRunStatsEntry(abortedRun(), { eventStore: storeOf(events({})), ticketDir: "PROJ-42" });
  const enriched = projectRunStatsEntry(abortedRun(), {
    eventStore: storeOf(events({ costUsd: 0.4, usage: { input_tokens: 3, output_tokens: 7 }, provider: "claude" })),
    ticketDir: "PROJ-42",
  });

  expect(enriched).toEqual(bare);
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
