import { expect, test } from "bun:test";
import type { PersistedRun, PersistedStepState, RunStatus } from "../persisted.js";
import { remainingWork, resumeDecision } from "./run-predicates.js";

// A `forEachPipeline` node set aside by `--skip` after its first item: its own
// status says nothing is owed, its orchestration state still lists an item it
// never launched.
function skippedFanOut(): PersistedRun {
  const node: PersistedStepState = {
    id: "fan-out",
    status: "skipped",
    retries: 0,
    orchestration: {
      kind: "forEachPipeline",
      items: ["A-1", "A-2"],
      children: [{ key: "main:0", kind: "main", pipeline: "child", status: "done", accountedCostUsd: 0 }],
    },
  };
  return {
    name: "parent",
    pipeline: "parent",
    status: "STOPPED",
    steps: [{ id: "plan", status: "done", retries: 0 }, node],
  };
}

function settledRun(status: RunStatus, resumable?: boolean): PersistedRun {
  return {
    name: "p",
    pipeline: "p",
    status,
    ...(resumable === undefined ? {} : { outcome: { phase: null, reason: null, logPath: null, resumable } }),
    steps: [{ id: "a", status: "done", retries: 0 }],
  };
}

// The step loop and the resume used to answer this run differently: the loop
// counted the unlaunched item as work, the resume read the skipped node as a
// decision. A node is `done` only once its last child settled, so its status
// already says what it owes; a skip is the operator's word on it.
test("remaining work: a skipped fan-out owes nothing, to the step loop and to the resume alike", () => {
  const run = skippedFanOut();
  expect(remainingWork(run)).toMatchObject({ steps: [], settled: true, owed: false });
  expect(resumeDecision(run)).toEqual({ resume: false, rejection: "settled" });
});

test("remaining work: a crash or a resumable interruption still owes a verdict", () => {
  expect(remainingWork(settledRun("RUNNING"))).toMatchObject({ verdictOwed: true, owed: true });
  expect(remainingWork(settledRun("ABORTED"))).toMatchObject({ verdictOwed: true, owed: true });
  expect(remainingWork(settledRun("ABORTED", false))).toMatchObject({ discarded: true, owed: false });
  for (const status of ["PASS", "FAIL", "STOPPED", "UNKNOWN"] as const)
    expect(remainingWork(settledRun(status))).toMatchObject({ verdictOwed: false, owed: false });
});

test("remaining work: a step not yet settled is owed whatever the status says", () => {
  const run: PersistedRun = {
    name: "p",
    pipeline: "p",
    status: "STOPPED",
    steps: [
      { id: "a", status: "done", retries: 0 },
      { id: "b", status: "pending", retries: 0 },
    ],
  };
  expect(remainingWork(run).steps.map((step) => step.id)).toEqual(["b"]);
  expect(remainingWork(run).owed).toBe(true);
  expect(resumeDecision(run)).toMatchObject({ resume: true });
});
