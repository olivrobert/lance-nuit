// What recording a cost stop writes, per origin, and what it leaves alone.
//
// The gates and the live guard all pass through `recordCostStop`; these scenarios
// pin the contract each of them relies on: which latches move, what the journal
// says, and that a stop observed by several sites is one fact per generation.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../model/run.js";
import type { RunBudget } from "./budget.js";
import { inheritChildBudgetStop, recordCostStop } from "./cost-stop-events.js";
import { readRunEvents } from "./run-journal.js";

function makeRun(maxCostUsd?: number): Run {
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "cost-stop-")),
    max_cost_usd: maxCostUsd,
    steps: [
      { id: "a", def: { id: "a", name: "a", command: "x" }, status: "failed", retries: 0 },
      { id: "b", def: { id: "b", name: "b", command: "x" }, status: "pending", retries: 0 },
    ] as Run["steps"],
  };
}

function eventsOf(run: Run, type: string) {
  return readRunEvents(run.run_dir).filter((event) => event.type === type);
}

test("cost stop: a gate stopping on the ledger journals the ceiling and latches nothing", () => {
  // The ledger of closed attempts is the fact: a resume reaches the same decision
  // from the same figures, so no durable flag is needed and none is written.
  const run = makeRun(1);
  const budget: RunBudget = { cumulative: 1.2 };

  recordCostStop(run, budget, "exceeded", { kind: "gate", stepId: "b" });

  expect(budget.exceeded).toBeUndefined();
  expect(run.budget_exceeded).toBeUndefined();
  expect(budget.unaccountedStop).toBeUndefined();
  const events = eventsOf(run, "run.budget.exceeded");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    stepId: "b",
    cumulativeUsd: 1.2,
    maxCostUsd: 1,
    estimated: false,
    remainingSteps: 1,
  });
});

test("cost stop: a gate stopping on a restored guard flag journals an estimate", () => {
  // The flag a previous generation's kill left behind is what stops this gate; the
  // ledger sits under the ceiling, so the event must say the figure is unconfirmed.
  const run = makeRun(1);
  run.budget_exceeded = true;
  const budget: RunBudget = { cumulative: 0.3, exceeded: true };

  recordCostStop(run, budget, "exceeded", { kind: "gate", stepId: "b" });

  const events = eventsOf(run, "run.budget.exceeded");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ estimated: true, cumulativeUsd: 0.3 });
});

test("cost stop: a live guard kill latches the ledger and the run, and journals an estimate", () => {
  // The guard fired on its own running total; the settled figure ($0.30) lands
  // under the $1 ceiling. The latches, not the ledger, are what stop the retry
  // loops and the next resume; the event says so with `estimated: true`.
  const run = makeRun(1);
  const budget: RunBudget = { cumulative: 0.3 };

  recordCostStop(run, budget, "exceeded", { kind: "live-guard", stepId: "a" });

  expect(budget.exceeded).toBe(true);
  expect(run.budget_exceeded).toBe(true);
  const events = eventsOf(run, "run.budget.exceeded");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stepId: "a", estimated: true, cumulativeUsd: 0.3 });
});

test("cost stop: an accounting stop latches the withheld work and journals the lower bound", () => {
  // Whatever observed it — a gate or a live accounting guard — the stop says work
  // was WITHHELD, which is more than the `costUnknown` proof accounting wrote.
  for (const kind of ["gate", "live-guard"] as const) {
    const run = makeRun(5);
    const budget: RunBudget = { cumulative: 2, costUnknown: true };

    recordCostStop(run, budget, "unaccounted", { kind, stepId: "a" });

    expect(budget.unaccountedStop).toBe(true);
    // The proof stays what accounting made it, and the ceiling stop is untouched.
    expect(budget.costUnknown).toBe(true);
    expect(budget.exceeded).toBeUndefined();
    expect(run.budget_exceeded).toBeUndefined();
    expect(run.cost_unaccounted).toBeUndefined();
    const events = eventsOf(run, "run.cost.unaccounted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stepId: "a", cumulativeUsd: 2, maxCostUsd: 5, remainingSteps: 1 });
    expect(eventsOf(run, "run.budget.exceeded")).toHaveLength(0);
  }
});

test("cost stop: several sites observing the same stop journal it once per generation", () => {
  // A retry gate, then admission of the next step, then a composed launch: three
  // observers, one stop. The latch lives on the shared ledger, so a new ledger
  // (a resume) records the stop again — that is a new stop, not a duplicate.
  const run = makeRun(1);
  const budget: RunBudget = { cumulative: 1.5 };

  recordCostStop(run, budget, "exceeded", { kind: "gate", stepId: "a" });
  recordCostStop(run, budget, "exceeded", { kind: "gate", stepId: "b" });
  recordCostStop(run, budget, "exceeded", { kind: "gate", stepId: null });
  expect(eventsOf(run, "run.budget.exceeded")).toHaveLength(1);
  expect(eventsOf(run, "run.budget.exceeded")[0]).toMatchObject({ stepId: "a" });

  const resumed: RunBudget = { cumulative: 1.5 };
  recordCostStop(run, resumed, "exceeded", { kind: "gate", stepId: "b" });
  expect(eventsOf(run, "run.budget.exceeded")).toHaveLength(2);
});

test("cost stop: both stops recorded for one attempt are two facts, each journaled once", () => {
  // A guard can establish both on the same kill. They coexist and are not merged
  // into one status; each keeps its own event and its own latch.
  const run = makeRun(1);
  const budget: RunBudget = { cumulative: 0.2, costUnknown: true };
  const origin = { kind: "live-guard", stepId: "a" } as const;

  recordCostStop(run, budget, "exceeded", origin);
  recordCostStop(run, budget, "unaccounted", origin);
  recordCostStop(run, budget, "unaccounted", { kind: "gate", stepId: "b" });

  expect(budget.exceeded).toBe(true);
  expect(budget.unaccountedStop).toBe(true);
  expect(eventsOf(run, "run.budget.exceeded")).toHaveLength(1);
  expect(eventsOf(run, "run.cost.unaccounted")).toHaveLength(1);
});

test("cost stop: a child's guard stop is inherited as latches, without a parent event", () => {
  // The child journaled its own stop; the parent only needs to stop the same
  // durable way on resume. Its journal carries the outcome through `run.finished`.
  const parent = makeRun(10);
  const budget: RunBudget = { cumulative: 4 };

  inheritChildBudgetStop(parent, budget);

  expect(budget.exceeded).toBe(true);
  expect(parent.budget_exceeded).toBe(true);
  expect(readRunEvents(parent.run_dir)).toHaveLength(0);
});
