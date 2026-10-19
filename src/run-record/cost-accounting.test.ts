// What the strict stop accepts as evidence, what it refuses, and what each charge
// actually moves.
//
// `cost_unknown` alone is not the contract: it also marks an attempt that died
// before reporting anything, which keeps a total honest without proving the
// ceiling unenforceable. These scenarios pin the line between the two.
//
// `mergeControl` and `mergeUsage` are private to the module, so the summing rules
// are pinned through the charge that applies them, which is also the only way a
// caller can reach them.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepControl, StepUsage } from "../contracts/backends.js";
import type { PersistedAttempt, PersistedPipelineChildRef } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunBudget } from "./budget.js";
import {
  aggregateControl,
  aggregateUsage,
  chargeAttemptToLedger,
  chargeChildReconciliation,
  chargeClosedAttempt,
  controlForRun,
  isUnpricedSpend,
  measuredRunCost,
  projectStepSpend,
  restoreAttemptSpend,
  restoreRunTotals,
  runProvesUnpricedSpend,
  stepProvesUnpricedSpend,
} from "./cost-accounting.js";
import { readRunEvents } from "./run-journal.js";

function makeRun(steps: RunStep[] = []): Run {
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "cost-accounting-")),
    steps,
  };
}

/** A step total, as the charges see it: figures and nothing else. */
function spendOf(control?: StepControl, usage?: StepUsage): { control?: StepControl; usage?: StepUsage } {
  return { control, usage };
}

test("cost accounting: tokens consumed with no price are unpriced spend", () => {
  expect(isUnpricedSpend({ duration_ms: 1, cost_unknown: true }, { input_tokens: 1000, output_tokens: 100 })).toBe(
    true,
  );
});

test("cost accounting: a partial amount flagged unknown is unpriced spend", () => {
  // The backend measured $1 and says the figure is incomplete: a lower bound is
  // still a measurement.
  expect(isUnpricedSpend({ duration_ms: 1, total_cost_usd: 1, cost_unknown: true })).toBe(true);
});

test("cost accounting: an attempt that measured nothing is not unpriced spend", () => {
  // The closure precaution over a timeout, a signal, or a transport break before
  // the first usage event. It marks the total; it must not stop the run.
  expect(isUnpricedSpend({ duration_ms: 60_000, cost_unknown: true })).toBe(false);
  expect(isUnpricedSpend({ duration_ms: 60_000, cost_unknown: true }, { input_tokens: 0, output_tokens: 0 })).toBe(
    false,
  );
});

test("cost accounting: a priced attempt is never unpriced spend", () => {
  expect(isUnpricedSpend({ duration_ms: 1, total_cost_usd: 2 }, { output_tokens: 500 })).toBe(false);
  expect(isUnpricedSpend(undefined, undefined)).toBe(false);
});

test("cost accounting: a step total mixing a priced attempt and an unmeasured one proves nothing", () => {
  // The aggregate carries `cost_unknown` from the failed attempt and the tokens
  // of the priced one. Reading the total alone would invent evidence, so the
  // attempts decide.
  const step = {
    control: { duration_ms: 61_000, total_cost_usd: 0.5, cost_unknown: true },
    usage: { input_tokens: 1000, output_tokens: 100 },
    attempts: [
      { control: { duration_ms: 60_000, cost_unknown: true } },
      { control: { duration_ms: 1000, total_cost_usd: 0.5 }, usage: { input_tokens: 1000, output_tokens: 100 } },
    ],
  };

  expect(stepProvesUnpricedSpend(step)).toBe(false);
  expect(runProvesUnpricedSpend({ steps: [step] })).toBe(false);
});

test("cost accounting: a step total stands in when no attempt figures survived", () => {
  // A snapshot keeps no attempt list, and an orchestration node never had one:
  // its reconciled child figures ARE its totals.
  const node = {
    control: { duration_ms: 10, total_cost_usd: 0, cost_unknown: true },
    usage: { output_tokens: 900 },
  };

  expect(stepProvesUnpricedSpend(node)).toBe(true);
  expect(runProvesUnpricedSpend({ steps: [{ control: { duration_ms: 1 } }, node] })).toBe(true);
  expect(runProvesUnpricedSpend({ steps: [] })).toBe(false);
  expect(runProvesUnpricedSpend(null)).toBe(false);
});

test("chargeClosedAttempt: sums cost and duration into the step total", () => {
  const step = spendOf({
    duration_ms: 100,
    total_cost_usd: 0.1,
    model: "claude-sonnet-4-6",
    last_turn_context_tokens: 100,
    context_window: 200_000,
  });
  chargeClosedAttempt(
    step,
    {},
    {
      control: {
        duration_ms: 50,
        total_cost_usd: 0.2,
        model: "claude-opus-4-8",
        last_turn_context_tokens: 5000,
        context_window: 1_000_000,
      },
    },
  );
  const merged = step.control!;
  expect(merged.duration_ms).toBe(150);
  expect(merged.total_cost_usd).toBeCloseTo(0.3, 8);
  expect(merged.model).toBe("claude-opus-4-8");
  expect(merged.last_turn_context_tokens).toBe(5000);
  expect(merged.context_window).toBe(1_000_000);
});

test("chargeClosedAttempt: propagates estimated cost onto the step total", () => {
  const estimated = spendOf({ duration_ms: 0 });
  chargeClosedAttempt(estimated, {}, { control: { duration_ms: 0, cost_estimated: true } });
  expect(estimated.control?.cost_estimated).toBe(true);

  const exact = spendOf({ duration_ms: 0 });
  chargeClosedAttempt(exact, {}, { control: { duration_ms: 0 } });
  expect(exact.control?.cost_estimated).toBeUndefined();
});

test("chargeClosedAttempt: sums counters and tool usage into the step total", () => {
  const step = spendOf(undefined, { output_tokens: 10, cache_read_tokens: 1000, tools_used: ["Read"] });
  chargeClosedAttempt(
    step,
    {},
    {
      control: { duration_ms: 0 },
      usage: { output_tokens: 5, cache_read_tokens: 500, tools_used: ["Read", "Edit"] },
    },
  );
  expect(step.usage).toEqual({
    duration_api_ms: undefined,
    num_turns: undefined,
    input_tokens: undefined,
    output_tokens: 15,
    cache_read_tokens: 1500,
    cache_creation_tokens: undefined,
    tools_used: ["Read", "Edit"],
  });
});

test("chargeClosedAttempt: an unpriced attempt is an estimate, and the flag is sticky", () => {
  const attempt: PersistedAttempt = {
    attempt: 1,
    kind: "step",
    status: "failed",
    started_at: "now",
    log_path: "log",
  };
  const step = spendOf();
  const stored = chargeClosedAttempt(step, attempt, {
    control: { duration_ms: 1, cost_unknown: true },
  });
  // A total that carries an unpriced attempt is a lower bound; the report reads
  // `cost_estimated` to say so.
  expect(stored.control.cost_estimated).toBe(true);
  expect(attempt.control?.cost_estimated).toBe(true);

  // One unpriced attempt makes the step total an underestimate for good.
  chargeClosedAttempt(step, {}, { control: { duration_ms: 1, total_cost_usd: 0.3 } });
  expect(step.control?.cost_unknown).toBe(true);
  expect(step.control?.total_cost_usd).toBeCloseTo(0.3, 8);
  expect(aggregateControl([{ control: { duration_ms: 1, cost_unknown: true } }] as RunStep[]).cost_unknown).toBe(true);
});

test("cost accounting: a run total is the sum of its steps", () => {
  const steps = [
    { control: { duration_ms: 10, total_cost_usd: 0.5 }, usage: { output_tokens: 10 } },
    { control: { duration_ms: 5, total_cost_usd: 0.1, cost_estimated: true }, usage: { output_tokens: 5 } },
  ] as RunStep[];
  const control = aggregateControl(steps);
  const usage = aggregateUsage(steps);
  expect(control.total_cost_usd).toBeCloseTo(0.6, 8);
  expect(control.cost_estimated).toBe(true);
  expect(usage?.output_tokens).toBe(15);
});

test("measuredRunCost: the fallback stands in only when nothing was measured", () => {
  expect(measuredRunCost({ steps: [], total_control: { duration_ms: 1, total_cost_usd: 2 } }, 5)).toBe(2);
  expect(measuredRunCost({ steps: [] }, 5)).toBe(5);
});

test("chargeAttemptToLedger: the ledger advances by the attempt cost alone", () => {
  const run = makeRun();
  const budget: RunBudget = { cumulative: 1 };
  chargeAttemptToLedger(run, budget, { duration_ms: 2, total_cost_usd: 0.25 }, { input_tokens: 10 });
  expect(budget.cumulative).toBe(1.25);
  // No spend was proven unpriceable, so no latch and no run-level mark.
  expect(budget.costUnknown).toBeUndefined();
  expect(run.cost_unaccounted).toBeUndefined();
});

test("chargeAttemptToLedger: a priced-out attempt neither poisons nor credits the ledger", () => {
  const run = makeRun();
  const budget: RunBudget = { cumulative: 2 };
  chargeAttemptToLedger(run, budget, { duration_ms: 1, cost_unknown: true }, { output_tokens: 900 });
  expect(budget.cumulative).toBe(2);
  // Tokens with no rate PROVE the ceiling unenforceable: both latches are set.
  expect(budget.costUnknown).toBe(true);
  expect(run.cost_unaccounted).toBe(true);
});

test("chargeAttemptToLedger: an attempt that measured nothing marks no latch", () => {
  const run = makeRun();
  const budget: RunBudget = { cumulative: 0 };
  chargeAttemptToLedger(run, budget, { duration_ms: 60_000, cost_unknown: true }, undefined);
  expect(budget.costUnknown).toBeUndefined();
  expect(run.cost_unaccounted).toBeUndefined();
  // A live guard that PROVED the usage unpriceable is the other road to the latch.
  chargeAttemptToLedger(run, budget, { duration_ms: 1 }, undefined, { guardProvedUnpriced: true });
  expect(budget.costUnknown).toBe(true);
  expect(run.cost_unaccounted).toBe(true);
});

test("chargeAttemptToLedger: materialized run totals stop being authoritative", () => {
  const run = makeRun();
  run.total_control = { duration_ms: 5, total_cost_usd: 3 };
  run.total_usage = { output_tokens: 7 };
  chargeAttemptToLedger(run, { cumulative: 0 }, { duration_ms: 1, total_cost_usd: 1 }, undefined);
  expect(run.total_control).toBeUndefined();
  expect(run.total_usage).toBeUndefined();
});

function childRef(): PersistedPipelineChildRef {
  return { key: "item-1", kind: "main", pipeline: "child", status: "running", accountedCostUsd: 0 };
}

test("chargeChildReconciliation: a child is charged once, by difference", () => {
  const step = { id: "compose" } as RunStep;
  const parent = makeRun([step]);
  const ref = childRef();
  const budget: RunBudget = { cumulative: 0 };
  const child = makeRun();
  child.total_control = { duration_ms: 40, total_cost_usd: 1.5 };
  child.total_usage = { output_tokens: 200 };

  expect(chargeChildReconciliation({ parent, step, ref, child, budget, fallbackCost: 0 })).toBeCloseTo(1.5, 8);
  expect(step.control?.total_cost_usd).toBeCloseTo(1.5, 8);
  expect(step.control?.duration_ms).toBe(40);
  expect(step.usage?.output_tokens).toBe(200);
  expect(budget.cumulative).toBeCloseTo(1.5, 8);
  // The reference remembers the three figures already charged, not only the dollars.
  expect(ref).toMatchObject({ accountedCostUsd: 1.5, accountedDurationMs: 40, accountedUsage: { output_tokens: 200 } });

  // The resumed child re-reports its whole history: the delta is zero and nothing
  // is paid a second time — no dollars, no milliseconds, no tokens.
  expect(chargeChildReconciliation({ parent, step, ref, child, budget, fallbackCost: 0 })).toBe(0);
  expect(step.control?.total_cost_usd).toBeCloseTo(1.5, 8);
  expect(step.control?.duration_ms).toBe(40);
  expect(step.usage?.output_tokens).toBe(200);
  expect(budget.cumulative).toBeCloseTo(1.5, 8);

  const reconciled = readRunEvents(parent.run_dir).filter((event) => event.type === "pipeline.child.cost.reconciled");
  expect(reconciled.map((event) => event.deltaCostUsd)).toEqual([1.5, 0]);
});

test("chargeChildReconciliation: the parent node takes no model from its child", () => {
  // The child's run-level model is its LAST agent step's; on the parent it would
  // label the whole subtree's spend with, say, a cheap extractor's model.
  const step = { id: "compose" } as RunStep;
  const parent = makeRun([step]);
  const child = makeRun();
  child.total_control = { duration_ms: 10, total_cost_usd: 7.4, model: "claude-haiku-4-5" };

  chargeChildReconciliation({ parent, step, ref: childRef(), child, budget: { cumulative: 0 }, fallbackCost: 0 });

  expect(step.control?.total_cost_usd).toBeCloseTo(7.4, 8);
  expect(step.control?.model).toBeUndefined();
});

test("chargeChildReconciliation: a child that could not price itself latches the parent", () => {
  const step = { id: "compose" } as RunStep;
  const parent = makeRun([step]);
  const budget: RunBudget = { cumulative: 0 };
  const child = makeRun();
  child.total_control = { duration_ms: 10, total_cost_usd: 0, cost_unknown: true };
  child.total_usage = { output_tokens: 900 };

  chargeChildReconciliation({ parent, step, ref: childRef(), child, budget, fallbackCost: 0 });
  expect(step.control?.cost_unknown).toBe(true);
  expect(budget.costUnknown).toBe(true);
  expect(parent.cost_unaccounted).toBe(true);
});

test("projectStepSpend: the journal wins only when it knows of more spend", () => {
  const state = { id: "verify", status: "failed", control: { duration_ms: 5, total_cost_usd: 1 } } as never;
  const attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "failed",
      started_at: "",
      log_path: "",
      control: { duration_ms: 5, total_cost_usd: 1 },
    },
    {
      attempt: 2,
      kind: "step",
      status: "done",
      started_at: "",
      log_path: "",
      control: { duration_ms: 5, total_cost_usd: 0.5 },
    },
  ] as PersistedAttempt[];
  expect(projectStepSpend(state, attempts).control?.total_cost_usd).toBeCloseTo(1.5, 8);
  // The snapshot already holds at least as much: it stays the record.
  expect(projectStepSpend(state, [attempts[0]!]).control?.total_cost_usd).toBe(1);
  expect(projectStepSpend(state, undefined).control?.total_cost_usd).toBe(1);
});

test("restoreAttemptSpend: figures are put back, never charged again", () => {
  const attempt: PersistedAttempt = { attempt: 1, kind: "step", status: "done", started_at: "", log_path: "" };
  restoreAttemptSpend(attempt, { duration_ms: 3, total_cost_usd: 0.2 }, { output_tokens: 5 });
  expect(attempt.control?.total_cost_usd).toBe(0.2);
  expect(attempt.usage?.output_tokens).toBe(5);
  // Replaying the same event does not double anything: it is an assignment.
  restoreAttemptSpend(attempt, { duration_ms: 3, total_cost_usd: 0.2 }, { output_tokens: 5 });
  expect(attempt.control?.total_cost_usd).toBe(0.2);
  expect(attempt.usage?.output_tokens).toBe(5);
  // Absent figures leave what the attempt already carried.
  restoreAttemptSpend(attempt, undefined, undefined);
  expect(attempt.control?.total_cost_usd).toBe(0.2);
});

test("restoreRunTotals: a terminal snapshot keeps its totals, a live resume derives them", () => {
  const persisted = { total_control: { duration_ms: 5, total_cost_usd: 3 }, total_usage: { output_tokens: 7 } };
  expect(restoreRunTotals(persisted, true)).toEqual(persisted);
  // Nothing to trust: the steps are the record until the next finalization.
  expect(restoreRunTotals(persisted, false)).toEqual({ total_control: undefined, total_usage: undefined });
  const steps = [
    { control: { duration_ms: 1, total_cost_usd: 1 }, usage: { output_tokens: 2 } },
  ] as unknown as RunStep[];
  expect(controlForRun({ steps, ...restoreRunTotals(persisted, false) }).total_cost_usd).toBe(1);
  expect(controlForRun({ steps, ...restoreRunTotals(persisted, true) }).total_cost_usd).toBe(3);
});

test("chargeChildReconciliation: a reconciled child invalidates the parent's materialized totals", () => {
  const step = { id: "batch", control: undefined, usage: undefined } as unknown as RunStep;
  const parent = makeRun([step]);
  parent.total_control = { duration_ms: 50, total_cost_usd: 9 };
  parent.total_usage = { output_tokens: 70 };
  const child = makeRun();
  child.total_control = { duration_ms: 40, total_cost_usd: 1.5 };
  chargeChildReconciliation({ parent, step, ref: childRef(), child, budget: { cumulative: 0 }, fallbackCost: 0 });
  expect(parent.total_control).toBeUndefined();
  expect(parent.total_usage).toBeUndefined();
  expect(controlForRun(parent).total_cost_usd).toBe(1.5);
});
