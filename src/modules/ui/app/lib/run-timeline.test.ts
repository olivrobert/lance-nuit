import { describe, expect, test } from "bun:test";
import type { RunRecap, RunRecapStep, RunStepsView, RunStepView } from "../api/types.js";
import { costByModel, timelineLanes } from "./run-timeline.js";
import { STEPS } from "./testing.js";

describe("timelineLanes", () => {
  const T0 = "2026-09-25T14:00:00.000Z";
  const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
  const recapOf = (steps: RunRecapStep[], overrides: Partial<RunRecap> = {}): RunRecap => ({
    pipeline: "feature",
    runId: "run-1",
    status: "PASS",
    startedAt: T0,
    endedAt: at(100),
    activeMs: 30 * 60_000,
    models: [],
    steps,
    ...overrides,
  });
  const viewOf = (steps: RunStepView[]): RunStepsView => ({ ...STEPS, status: "PASS", steps });

  test("a bar is placed in % of the run span", () => {
    const recap = recapOf([{ id: "implement", status: "done", durationMs: 20 * 60_000, costUsd: 7, model: "opus" }]);
    const steps = viewOf([{ id: "implement", status: "done", startedAt: at(10), finishedAt: at(85) }]);
    const [lane] = timelineLanes(steps, recap).lanes;
    expect(lane?.bar).toEqual({ left: 10, width: 75 });
    expect(lane?.wallMs).toBe(75 * 60_000);
    expect(lane?.agent).toBe(true);
  });

  test("a command step is not drawn as an agent step", () => {
    const recap = recapOf([{ id: "db-reset", status: "done", durationMs: 5 * 60_000 }]);
    const steps = viewOf([{ id: "db-reset", status: "done", startedAt: at(0), finishedAt: at(5) }]);
    const [lane] = timelineLanes(steps, recap).lanes;
    expect(lane?.agent).toBe(false);
  });

  test("short steps merge into one lane of ticks, skipped steps are listed apart", () => {
    const recap = recapOf([
      { id: "gate", status: "done", durationMs: 2 },
      { id: "guard", status: "done", durationMs: 40 },
      { id: "plan-revise", status: "skipped" },
      { id: "plan", status: "done", durationMs: 120_000, costUsd: 1 },
    ]);
    const steps = viewOf([
      { id: "gate", status: "done", startedAt: at(0), finishedAt: at(0) },
      { id: "guard", status: "done", startedAt: at(50), finishedAt: at(50) },
      { id: "plan", status: "done", startedAt: at(50), finishedAt: at(52) },
    ]);
    const result = timelineLanes(steps, recap);
    expect(result.lanes.map((lane) => lane.step.id)).toEqual(["plan"]);
    expect(result.short).toEqual({ count: 2, ticks: [0, 50] });
    expect(result.skipped).toEqual(["plan-revise"]);
  });

  test("a step without timestamps keeps its lane but has no bar", () => {
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }]);
    const [lane] = timelineLanes(viewOf([{ id: "plan", status: "done", startedAt: at(1) }]), recap).lanes;
    expect(lane?.bar).toBeUndefined();
    expect(lane?.wallMs).toBeUndefined();
    expect(timelineLanes(null, recap).lanes[0]?.bar).toBeUndefined();
  });

  test("a zero-length or unknown span places nothing and never divides by zero", () => {
    const steps = viewOf([{ id: "plan", status: "done", startedAt: T0, finishedAt: T0 }]);
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }], { endedAt: T0 });
    const result = timelineLanes(steps, recap);
    expect(result.spanMs).toBe(0);
    expect(result.startMs).toBeUndefined();
    expect(result.lanes[0]?.bar).toBeUndefined();
    expect(result.totals.wallMs).toBeUndefined();
    const unknown = timelineLanes(null, recapOf([], { startedAt: undefined, endedAt: undefined }));
    expect(unknown.spanMs).toBe(0);
  });

  test("the steps' own timestamps stand in for a span the snapshot lacks", () => {
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }], {
      startedAt: undefined,
      endedAt: undefined,
    });
    const steps = viewOf([{ id: "plan", status: "done", startedAt: at(0), finishedAt: at(10) }]);
    expect(timelineLanes(steps, recap).lanes[0]?.bar).toEqual({ left: 0, width: 100 });
  });

  test("a very short notable step still gets a visible bar, kept inside the track", () => {
    const recap = recapOf([{ id: "push", status: "done", durationMs: 1500 }]);
    const steps = viewOf([{ id: "push", status: "done", startedAt: at(100), finishedAt: at(100) }]);
    const bar = timelineLanes(steps, recap).lanes[0]?.bar;
    expect(bar?.width).toBeGreaterThan(0);
    expect((bar?.left ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(100);
  });

  test("a step still running gets a lane that ends at the span's end", () => {
    const recap = recapOf([{ id: "implement", status: "running" }], { status: "RUNNING" });
    const steps = viewOf([{ id: "implement", status: "running", startedAt: at(50) }]);
    expect(timelineLanes(steps, recap).lanes[0]?.bar).toEqual({ left: 50, width: 50 });
  });

  test("the total is the run span", () => {
    expect(timelineLanes(null, recapOf([])).totals).toEqual({ wallMs: 100 * 60_000 });
  });
});

describe("costByModel", () => {
  test("adds a step's own model and a composed node's split, costliest first", () => {
    const recap: RunRecap = {
      pipeline: "feature",
      runId: "run-1",
      status: "PASS",
      models: [],
      steps: [
        { id: "triage", status: "done", model: "opus", costUsd: 1 },
        {
          id: "implement-lots",
          status: "done",
          costUsd: 8,
          models: [
            { model: "opus", costUsd: 7.5 },
            { model: "haiku", costUsd: 0.5 },
          ],
        },
        { id: "mystery", status: "done", costUsd: 0.2 },
        { id: "db-reset", status: "done", durationMs: 30_000 },
      ],
    };
    expect(costByModel(recap)).toEqual([
      { model: "opus", costUsd: 8.5 },
      { model: "haiku", costUsd: 0.5 },
      { model: "unknown", costUsd: 0.2 },
    ]);
  });

  test("a model no step priced keeps an absent cost", () => {
    const recap: RunRecap = {
      pipeline: "feature",
      runId: "run-1",
      status: "PASS",
      models: [],
      steps: [{ id: "triage", status: "done", model: "local" }],
    };
    expect(costByModel(recap)).toEqual([{ model: "local" }]);
  });
});
