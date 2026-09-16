import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStep } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { makeRunStep, type StepStateInput } from "./run-step.ts";
import { closeAttempt, hasSpendFigures, settleAttemptStats } from "./attempt-closure.ts";
import { readRunEvents } from "./run-journal.ts";
import { nextAttemptLogPath } from "./run-timeline.ts";

function makeRun(step: RunStep): Run {
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "attempt-closure-")),
    steps: [step],
  };
}

function makeStep(def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep(
    { id: "verify", name: "Verify", command: "make test", runner: "bash", ...def },
    { status: "running", ...state },
  );
}

const AGENT = { runner: "agent", backend: { id: "claude" } } as const;

function finishedEvents(run: Run) {
  return readRunEvents(run.run_dir).filter((event) => event.type === "step.attempt.finished");
}

test("hasSpendFigures: any token count or price counts as a measurement", () => {
  expect(hasSpendFigures(undefined)).toBe(false);
  expect(hasSpendFigures({ duration_ms: 5 })).toBe(false);
  expect(hasSpendFigures({ duration_ms: 5, input_tokens: 1 })).toBe(true);
  expect(hasSpendFigures({ duration_ms: 5, cache_read_tokens: 1 })).toBe(true);
  expect(hasSpendFigures({ duration_ms: 5, total_cost_usd: 0 })).toBe(true);
});

test("settleAttemptStats: an unmeasured failed agent attempt is flagged cost_unknown", () => {
  const { control } = settleAttemptStats(makeStep(AGENT), "step", false, { duration_ms: 7 });
  expect(control.cost_unknown).toBe(true);
  expect(control.duration_ms).toBe(7);
  // No stats at all: the flag still lands, on a zero-duration control.
  expect(settleAttemptStats(makeStep(AGENT), "step", false, undefined).control).toMatchObject({
    duration_ms: 0,
    cost_unknown: true,
  });
});

test("settleAttemptStats: a fix pass is metered even on a bash step", () => {
  const { control } = settleAttemptStats(makeStep(), "fix", false, { duration_ms: 3 });
  expect(control.cost_unknown).toBe(true);
});

test("settleAttemptStats: a bash step attempt is never flagged", () => {
  const { control } = settleAttemptStats(makeStep(), "step", false, { duration_ms: 3 });
  expect(control.cost_unknown).toBeUndefined();
});

test("settleAttemptStats: a measured or successful attempt keeps its figures", () => {
  const measured = settleAttemptStats(makeStep(AGENT), "step", false, {
    duration_ms: 3,
    total_cost_usd: 0.2,
    input_tokens: 10,
  });
  expect(measured.control.cost_unknown).toBeUndefined();
  expect(measured.control.total_cost_usd).toBe(0.2);
  expect(measured.usage?.input_tokens).toBe(10);
  const succeeded = settleAttemptStats(makeStep(AGENT), "step", true, { duration_ms: 3 });
  expect(succeeded.control.cost_unknown).toBeUndefined();
});

test("closeAttempt: closes a running attempt once, the second call is a no-op", () => {
  const step = makeStep();
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  const attempt = step.attempts[0]!;

  // An accepted closure hands back the figures it stored.
  expect(
    closeAttempt(run, step, attempt, { status: "done", stats: { duration_ms: 10, total_cost_usd: 0.5 } }),
  ).toMatchObject({ control: { duration_ms: 10, total_cost_usd: 0.5 } });
  expect(attempt.status).toBe("done");
  expect(attempt.finished_at).toBeDefined();
  expect(step.control?.total_cost_usd).toBe(0.5);

  expect(
    closeAttempt(run, step, attempt, { status: "aborted", control: { duration_ms: 99, total_cost_usd: 9 } }),
  ).toBeUndefined();
  expect(attempt.status).toBe("done");
  expect(attempt.control?.total_cost_usd).toBe(0.5);
  expect(step.control?.total_cost_usd).toBe(0.5);
  expect(finishedEvents(run)).toHaveLength(1);
});

test("closeAttempt: writes the single finished payload", () => {
  const step = makeStep(AGENT);
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  const attempt = step.attempts[0]!;
  const session = { provider: "claude", id: "sess-1", resumable: true };

  closeAttempt(run, step, attempt, {
    status: "failed",
    stats: { duration_ms: 12, total_cost_usd: 0.3, model: "opus", input_tokens: 5, output_tokens: 2 },
    session,
    reason: "exit 1",
    logPath: "logs/verify-1.log",
  });

  expect(attempt).toMatchObject({
    status: "failed",
    session,
    errors: "exit 1",
    log_path: "logs/verify-1.log",
    control: { duration_ms: 12, total_cost_usd: 0.3, model: "opus" },
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const [event] = finishedEvents(run);
  expect(event).toMatchObject({
    type: "step.attempt.finished",
    stepId: "verify",
    attempt: 1,
    kind: "step",
    status: "failed",
    sessionId: "sess-1",
    session,
    provider: "claude",
    model: "opus",
    costUsd: 0.3,
    // The journal is JSON: keys the split left `undefined` vanish on the way.
    control: JSON.parse(JSON.stringify(attempt.control)),
    usage: JSON.parse(JSON.stringify(attempt.usage)),
    logPath: "logs/verify-1.log",
    reason: "exit 1",
  });
});

test("closeAttempt: omits optional payload fields it has no value for", () => {
  const step = makeStep();
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  const attempt = step.attempts[0]!;
  closeAttempt(run, step, attempt, { status: "done", stats: { duration_ms: 1 } });
  const [event] = finishedEvents(run);
  expect(event).not.toHaveProperty("sessionId");
  expect(event).not.toHaveProperty("session");
  expect(event).not.toHaveProperty("provider");
  expect(event).not.toHaveProperty("model");
  expect(event).not.toHaveProperty("costUsd");
  expect(event).not.toHaveProperty("usage");
  expect(event).not.toHaveProperty("reason");
  expect(event).toHaveProperty("control", { duration_ms: 1 });
  expect(event).toHaveProperty("logPath", attempt.log_path);
});

test("closeAttempt: an explicit control wins over stats and still obeys the cost_unknown rule", () => {
  const step = makeStep(AGENT);
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  const attempt = step.attempts[0]!;
  closeAttempt(run, step, attempt, {
    status: "aborted",
    control: { duration_ms: 40, model: "opus", provider: "claude", cost_estimated: true },
    stats: { duration_ms: 1, total_cost_usd: 5 },
    reason: "SIGINT: run interrupted manually",
  });
  expect(attempt.control).toEqual({
    duration_ms: 40,
    total_cost_usd: undefined,
    cost_estimated: true,
    cost_unknown: true,
    model: "opus",
    provider: "claude",
    last_turn_context_tokens: undefined,
    context_window: undefined,
  });
  expect(attempt.usage).toBeUndefined();
  const [event] = finishedEvents(run);
  expect(event).toMatchObject({ status: "aborted", model: "opus", provider: "claude" });
  expect(event).not.toHaveProperty("costUsd");
});

test("closeAttempt: cost_unknown marks the total as estimated on every path", () => {
  for (const kind of ["step", "fix"] as const) {
    const step = makeStep(AGENT);
    const run = makeRun(step);
    nextAttemptLogPath(run, step, kind);
    const attempt = step.attempts[0]!;
    closeAttempt(run, step, attempt, { status: "failed", control: attempt.control, reason: "crashed" });
    expect(attempt.control).toMatchObject({ duration_ms: 0, cost_unknown: true, cost_estimated: true });
    expect(step.control).toMatchObject({ cost_unknown: true, cost_estimated: true });
  }
  // A bash step attempt closed the same way stays unflagged.
  const step = makeStep();
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  closeAttempt(run, step, step.attempts[0]!, { status: "failed", reason: "crashed" });
  expect(step.control?.cost_unknown).toBeUndefined();
  expect(step.control?.cost_estimated).toBeUndefined();
});

test("closeAttempt: merges into a step that already carries totals", () => {
  const step = makeStep(AGENT, {
    control: { duration_ms: 100, total_cost_usd: 1, model: "sonnet", cost_estimated: true },
    usage: { input_tokens: 10, tools_used: ["Read"] },
  });
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  closeAttempt(run, step, step.attempts[0]!, {
    status: "done",
    stats: { duration_ms: 50, total_cost_usd: 0.25, model: "opus", input_tokens: 5, tools_used: ["Edit"] },
  });
  expect(step.control).toMatchObject({
    duration_ms: 150,
    total_cost_usd: 1.25,
    model: "opus",
    cost_estimated: true,
  });
  expect(step.control?.cost_unknown).toBeUndefined();
  expect(step.usage).toMatchObject({ input_tokens: 15, tools_used: ["Read", "Edit"] });
});

test("closeAttempt: leaves the step status and the run untouched", () => {
  const step = makeStep();
  const run = makeRun(step);
  run.status = "RUNNING";
  nextAttemptLogPath(run, step);
  closeAttempt(run, step, step.attempts[0]!, { status: "failed", reason: "exit 1" });
  expect(step.status).toBe("running");
  expect(step.fail_kind).toBeUndefined();
  expect(step.errors).toBeUndefined();
  expect(run.status).toBe("RUNNING");
  expect(run.aborted).toBeUndefined();
});

test("closeAttempt: keeps the session, reason and log path already on the attempt", () => {
  const step = makeStep(AGENT);
  const run = makeRun(step);
  nextAttemptLogPath(run, step);
  const attempt = step.attempts[0]!;
  attempt.session = { provider: "claude", id: "sess-0", resumable: true };
  attempt.errors = "earlier cause";
  const logPath = attempt.log_path;
  closeAttempt(run, step, attempt, { status: "done", stats: { duration_ms: 1, total_cost_usd: 0.1 } });
  expect(attempt.session?.id).toBe("sess-0");
  expect(attempt.errors).toBe("earlier cause");
  expect(attempt.log_path).toBe(logPath);
  expect(finishedEvents(run)[0]).toMatchObject({ sessionId: "sess-0", reason: "earlier cause", logPath });
});
