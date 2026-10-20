import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunStep } from "../model/run.js";
import { openAttempt, settleAttempt } from "./attempt-lifecycle.js";
import type { RunBudget } from "./budget.js";
import { readRunEvents } from "./run-journal.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { makeRunStep } from "./run-step.js";
import { abortRun } from "./run-transitions.js";

function makeRun(step: RunStep, maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "attempt-lifecycle-"));
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, max_cost_usd: maxCost, steps: [step] };
}

function runningStep(runner: "bash" | "agent" = "bash"): RunStep {
  return makeRunStep(
    { id: "a", name: "a", command: "work", runner, ...(runner === "agent" ? { backend: { id: "claude" } } : {}) },
    { status: "running" },
  );
}

test("openAttempt: registers, journals and persists the attempt before anything spawns", () => {
  const step = runningStep();
  const run = makeRun(step);

  const opened = openAttempt(run, step, { kind: "fix", command: "repair it" });

  expect(opened.attempt).toBe(step.attempts!.at(-1)!);
  expect(opened.attempt).toMatchObject({ attempt: 1, kind: "fix", status: "running" });
  expect(opened.logPath).toBe(join(run.run_dir, "steps/a/attempt-001/output.log"));
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual(["step.attempt.started"]);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.steps[0]?.last_attempt).toBe(1);
});

test("settleAttempt: a result arriving after the signal handler closed the attempt changes nothing", () => {
  const step = runningStep();
  const run = makeRun(step, 1);
  run.executingStepId = step.id;
  const opened = openAttempt(run, step, { kind: "step", command: "work" });
  abortRun(run, "SIGINT", { estimatedCostUsd: 0.25 });
  const budget: RunBudget = { cumulative: 0 };
  const eventsBefore = readRunEvents(run.run_dir).length;

  const settled = settleAttempt(
    run,
    step,
    opened,
    { ok: true, budgetExceeded: true, stats: { duration_ms: 1, total_cost_usd: 0.5 } },
    budget,
  );

  expect(settled).toEqual({});
  expect(budget).toEqual({ cumulative: 0 });
  expect(step.control?.total_cost_usd).toBe(0.25);
  expect(run.budget_exceeded).toBeUndefined();
  expect(readRunEvents(run.run_dir)).toHaveLength(eventsBefore);
});

test("settleAttempt: reports the unknown cost for the caller to word, and journals it", () => {
  const unpriced = runningStep();
  const run = makeRun(unpriced);
  const opened = openAttempt(run, unpriced, { kind: "step", command: "work" });

  expect(
    settleAttempt(
      run,
      unpriced,
      opened,
      { ok: true, stats: { duration_ms: 1, cost_unknown: true, output_tokens: 10, model: "m" } },
      { cumulative: 0 },
    ),
  ).toEqual({ costWarning: { model: "m", cause: "unpriced" } });

  const silent = runningStep("agent");
  const other = makeRun(silent);
  const failed = openAttempt(other, silent, { kind: "step", command: "work" });
  expect(settleAttempt(other, silent, failed, { ok: false, failReason: "transport" }, { cumulative: 0 })).toEqual({
    costWarning: { cause: "unreported" },
  });

  const priced = runningStep();
  const third = makeRun(priced);
  const done = openAttempt(third, priced, { kind: "step", command: "work" });
  expect(
    settleAttempt(third, priced, done, { ok: true, stats: { duration_ms: 1, total_cost_usd: 0.5 } }, { cumulative: 0 }),
  ).toEqual({});

  expect(readRunEvents(run.run_dir).filter((event) => event.type === "step.cost.unaccounted")).toHaveLength(1);
  expect(readRunEvents(third.run_dir).filter((event) => event.type === "step.cost.unaccounted")).toHaveLength(0);
});
