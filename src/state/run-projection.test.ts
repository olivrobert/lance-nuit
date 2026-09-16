import { expect, test } from "bun:test";
import type { RunJournalEvent } from "../model/journal.js";
import type { PersistedRun } from "../model/persisted.js";
import { projectRunState } from "./run-projection.js";

function savedRun(steps: PersistedRun["steps"]): PersistedRun {
  return {
    schemaVersion: 1,
    runId: "run-1",
    name: "p",
    pipeline: "p",
    status: "RUNNING",
    steps,
  } as PersistedRun;
}

function attemptEvents(stepId: string, attempt: number, control?: Record<string, unknown>): RunJournalEvent[] {
  return [
    { type: "step.attempt.started", stepId, attempt, kind: "step", logPath: `steps/${stepId}/${attempt}.log` },
    {
      type: "step.attempt.finished",
      stepId,
      attempt,
      kind: "step",
      status: "done",
      logPath: `steps/${stepId}/${attempt}.log`,
      ...(control ? { control } : {}),
    },
  ] as unknown as RunJournalEvent[];
}

test("projectRunState: the journal rebuilds a step total the snapshot never received", () => {
  const saved = savedRun([{ id: "a", status: "running", retries: 0 }]);
  const projected = projectRunState(saved, [...attemptEvents("a", 1, { duration_ms: 1, total_cost_usd: 1 })]);

  const step = projected.steps.get("a")!;
  expect(step.attempts?.[0]?.control?.total_cost_usd).toBe(1);
  // The ledger seeds from step totals: journaled spend must reach them.
  expect(step.state?.control?.total_cost_usd).toBe(1);
});

test("projectRunState: the snapshot total wins when it already covers the journaled attempts", () => {
  const saved = savedRun([
    { id: "a", status: "done", retries: 0, control: { duration_ms: 5, total_cost_usd: 1.5, model: "m" } },
  ]);
  const projected = projectRunState(saved, attemptEvents("a", 1, { duration_ms: 1, total_cost_usd: 1 }));

  expect(projected.steps.get("a")?.state?.control).toEqual({ duration_ms: 5, total_cost_usd: 1.5, model: "m" });
});

test("projectRunState: a step with no journaled attempt keeps its snapshot state untouched", () => {
  const saved = savedRun([{ id: "a", status: "done", retries: 0, usage: { input_tokens: 3 } }]);
  const projected = projectRunState(saved, []);

  const step = projected.steps.get("a")!;
  expect(step.attempts).toBeUndefined();
  expect(step.state).toMatchObject({ status: "done", usage: { input_tokens: 3 } });
});

test("projectRunState: a step the journal knows but the snapshot does not still carries its spend", () => {
  const projected = projectRunState(savedRun([]), attemptEvents("a", 1, { duration_ms: 1, total_cost_usd: 2 }));

  const step = projected.steps.get("a")!;
  expect(step.state).toBeUndefined();
  expect(step.attempts?.[0]?.control?.total_cost_usd).toBe(2);
});

function statusEvent(stepId: string, status: string, extra: Record<string, unknown> = {}): RunJournalEvent {
  return { type: "step.status.changed", ts: "2024-01-01T00:00:05.000Z", stepId, status, ...extra } as RunJournalEvent;
}

test("projectRunState: a step the journal finished is not resumed as running", () => {
  // The crash window of `updateStep`: the event is appended, the snapshot never
  // reaches disk, so the snapshot still says `running`.
  const saved = savedRun([{ id: "a", status: "running", retries: 0 }]);
  const projected = projectRunState(saved, [...attemptEvents("a", 1), statusEvent("a", "done")]);

  expect(projected.steps.get("a")?.state?.status).toBe("done");
  expect(projected.steps.get("a")?.state?.finished_at).toBe("2024-01-01T00:00:05.000Z");
});

test("projectRunState: a journaled failure carries its reason and cause", () => {
  const saved = savedRun([{ id: "a", status: "running", retries: 0 }]);
  const projected = projectRunState(saved, [
    statusEvent("a", "failed", { reason: "verdict rejected", failCause: "blocked" }),
  ]);

  expect(projected.steps.get("a")?.state).toMatchObject({
    status: "failed",
    errors: "verdict rejected",
    fail_cause: "blocked",
  });
});

test("projectRunState: a snapshot already ahead of the journal is left alone", () => {
  // The snapshot is written after the event: a terminal snapshot is the later
  // record, and a journal that reopened the step describes a closed pass.
  const saved = savedRun([{ id: "a", status: "done", retries: 0, finished_at: "2024-01-01T00:00:09.000Z" }]);
  const projected = projectRunState(saved, [statusEvent("a", "running"), statusEvent("a", "failed")]);

  expect(projected.steps.get("a")?.state).toMatchObject({
    status: "done",
    finished_at: "2024-01-01T00:00:09.000Z",
  });
});

test("projectRunState: a journal that reopens a step does not undo the snapshot", () => {
  const saved = savedRun([{ id: "a", status: "running", retries: 0 }]);
  const projected = projectRunState(saved, [statusEvent("a", "done"), statusEvent("a", "running")]);

  // Only the last event counts, and it is not terminal: nothing to reconcile.
  expect(projected.steps.get("a")?.state?.status).toBe("running");
});
