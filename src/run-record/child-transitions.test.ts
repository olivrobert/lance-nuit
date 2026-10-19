// The persisted child reference has one writer. These scenarios pin what each
// operation writes — fields, journal event, parent snapshot — and what a settled
// reference refuses.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedPipelineOrchestrationState } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import {
  bindChildRun,
  commitChildCall,
  completedSuccessfully,
  declareChild,
  failChildLaunch,
  hasJournaledChildStart,
  isChildSettled,
  recordChildStarted,
  settleChild,
  skipChild,
} from "./child-transitions.js";
import { readRunEvents } from "./run-journal.js";
import { makeRunStep } from "./run-step.js";

function makeParent(): { parent: Run; step: RunStep; state: PersistedPipelineOrchestrationState } {
  const state: PersistedPipelineOrchestrationState = { kind: "runPipeline", children: [] };
  const step = makeRunStep({ id: "compose", name: "Compose", command: "", runner: "pipeline" }, { status: "running" });
  step.orchestration = state;
  const parent: Run = {
    name: "parent",
    pipeline: "parent",
    pipeline_path: "parent.ts",
    run_dir: mkdtempSync(join(tmpdir(), "child-transitions-")),
    runId: "parent-run",
    steps: [step],
  };
  return { parent, step, state };
}

function snapshotChildren(parent: Run) {
  const saved = JSON.parse(readFileSync(join(parent.run_dir, "state.json"), "utf8"));
  return saved.steps[0].orchestration.children;
}

function makeChild(overrides: Partial<Run> = {}): Run {
  return {
    name: "child",
    pipeline: "child",
    pipeline_path: "child.ts",
    run_dir: mkdtempSync(join(tmpdir(), "child-transitions-child-")),
    runId: "child-run",
    ticket: "T-1",
    status: "PASS",
    steps: [],
    ...overrides,
  };
}

test("declareChild: creates the reference pending, persists it, and finds it again", () => {
  const { parent, state } = makeParent();
  const ref = declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1" });
  expect(ref).toMatchObject({ key: "main", status: "pending", accountedCostUsd: 0 });
  expect(snapshotChildren(parent)).toEqual([
    { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1", status: "pending", accountedCostUsd: 0 },
  ]);

  const again = declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1" });
  expect(again).toBe(ref);
  expect(state.children).toHaveLength(1);
});

test("declareChild: refuses a persisted call the definition no longer matches", () => {
  const { parent, state } = makeParent();
  declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1", lot: undefined });
  expect(() =>
    declareChild(parent, state, { key: "main", kind: "main", pipeline: "./other.ts", ticket: "T-1" }),
  ).toThrow(/incompatible with the persisted definition/);
  expect(() =>
    declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-2" }),
  ).toThrow(/incompatible/);
});

test("commitChildCall then bindChildRun: the call is durable before the identity, the identity before the boot", () => {
  const { parent, state } = makeParent();
  const ref = declareChild(parent, state, { key: "afterAll", kind: "afterAll", pipeline: "./after.ts", ticket: "T" });

  commitChildCall(parent, ref);
  expect(snapshotChildren(parent)[0]).toMatchObject({ status: "running" });
  expect(snapshotChildren(parent)[0].runId).toBeUndefined();
  expect(hasJournaledChildStart(parent, ref)).toBe(false);

  bindChildRun(parent, ref, "after-run");
  expect(snapshotChildren(parent)[0]).toMatchObject({ status: "running", runId: "after-run" });
  // Bound, but not started: nothing in the journal yet, so a retry may reuse the id.
  expect(hasJournaledChildStart(parent, ref)).toBe(false);
  expect(readRunEvents(parent)).toEqual([]);

  // Rebinding to the same id is the resume path; another id is a defect.
  bindChildRun(parent, ref, "after-run");
  expect(() => bindChildRun(parent, ref, "other-run")).toThrow(/bound to run after-run, not other-run/);
});

test("recordChildStarted: the start fact is the journal's, and it spends the identity", () => {
  const { parent, step, state } = makeParent();
  const ref = declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1" });
  bindChildRun(parent, ref, "child-run");
  const child = makeChild({ rootRunId: "parent-run", budgetScopeId: "parent-run", max_cost_usd: 2 });

  recordChildStarted(parent, step, child);

  expect(readRunEvents(parent)).toEqual([
    expect.objectContaining({
      type: "pipeline.child.started",
      parentNodeId: "compose",
      childRunId: "child-run",
      childPipeline: "child",
      childTicket: "T-1",
      rootRunId: "parent-run",
      budgetScopeId: "parent-run",
      maxCostUsd: 2,
    }),
  ]);
  expect(hasJournaledChildStart(parent, ref)).toBe(true);
  // Another identity under the same node is not started by this fact.
  expect(hasJournaledChildStart(parent, { ...ref, runId: "another" })).toBe(false);
});

test("skipChild: a decision not to call is final and carries its reason", () => {
  const { parent, state } = makeParent();
  const ref = declareChild(parent, state, { key: "afterEach:0", kind: "afterEach", pipeline: "./a.ts", ticket: "T" });

  skipChild(parent, ref, "compose", "condition not met");

  expect(isChildSettled(ref)).toBe(true);
  expect(snapshotChildren(parent)[0]).toMatchObject({
    status: "skipped",
    outcome: { phase: "compose", reason: "condition not met", logPath: null, resumable: false },
  });
  expect(() => commitChildCall(parent, ref)).toThrow(/already skipped/);
  expect(() => bindChildRun(parent, ref, "x")).toThrow(/already skipped/);
});

test("failChildLaunch: the child never ran, the reference stays resumable under its identity", () => {
  const { parent, state } = makeParent();
  const ref = declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1" });
  bindChildRun(parent, ref, "child-run");

  failChildLaunch(parent, ref, "compose", "Cannot resume selected snapshot");

  expect(isChildSettled(ref)).toBe(false);
  expect(snapshotChildren(parent)[0]).toMatchObject({
    status: "failed",
    runId: "child-run",
    outcome: { phase: "compose", reason: "Cannot resume selected snapshot", logPath: null, resumable: true },
  });
  // No child event: nothing of the child happened.
  expect(readRunEvents(parent)).toEqual([]);
  // The next generation re-enters it and binds the same id again.
  bindChildRun(parent, ref, "child-run");
  expect(ref.status).toBe("running");
});

test("settleChild: done from a PASS, failed otherwise, journaled then persisted", () => {
  const { parent, step, state } = makeParent();
  const ref = declareChild(parent, state, { key: "main", kind: "main", pipeline: "./child.ts", ticket: "T-1" });
  bindChildRun(parent, ref, "child-run");
  ref.accountedCostUsd = 1.5;
  const child = makeChild({ outcome: { phase: null, reason: null, logPath: null, resumable: false } });

  expect(settleChild(parent, ref, step, child, 1.5)).toBe(true);
  expect(snapshotChildren(parent)[0]).toMatchObject({ status: "done", accountedCostUsd: 1.5, outcome: child.outcome });
  expect(readRunEvents(parent)).toEqual([
    expect.objectContaining({
      type: "pipeline.child.finished",
      parentNodeId: "compose",
      childRunId: "child-run",
      childKey: "main",
      status: "done",
      accountedCostUsd: 1.5,
      deltaCostUsd: 1.5,
    }),
  ]);
  expect(() => settleChild(parent, ref, step, child, 0)).toThrow(/already done/);

  const { parent: other, step: otherStep, state: otherState } = makeParent();
  const failedRef = declareChild(other, otherState, { key: "main", kind: "main", pipeline: "./c.ts", ticket: "T" });
  const failedChild = makeChild({
    status: "FAIL",
    outcome: { phase: "a", reason: "boom", logPath: null, resumable: true, failKind: "technical" },
  });
  expect(settleChild(other, failedRef, otherStep, failedChild, 0)).toBe(false);
  expect(snapshotChildren(other)[0]).toMatchObject({ status: "failed", outcome: failedChild.outcome });
  // A failed reference is re-entered by the next generation.
  expect(isChildSettled(failedRef)).toBe(false);
});

test("completedSuccessfully: a PASS the interruption settled is not a success", () => {
  expect(completedSuccessfully(makeChild({ status: "PASS" }))).toBe(true);
  expect(completedSuccessfully(makeChild({ status: "PASS", aborted: true }))).toBe(false);
  expect(completedSuccessfully(makeChild({ status: "STOPPED" }))).toBe(false);
  expect(completedSuccessfully(makeChild({ status: "ABORTED" }))).toBe(false);
});
