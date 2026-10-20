import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunStep } from "../model/run.js";
import { freezeOrchestrationItems, openOrchestration } from "./child-transitions.js";
import { readRunEvents } from "./run-journal.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { makeRunStep } from "./run-step.js";
import {
  bindSession,
  consumeRetry,
  recordDecision,
  recordLastCommand,
  recordUnavailableSource,
  refundRetry,
} from "./step-bookkeeping.js";

function makeRun(step: RunStep): Run {
  const dir = mkdtempSync(join(tmpdir(), "step-bookkeeping-"));
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, steps: [step] };
}

const ROOT_LINEAGE = [{ pipelinePath: "/pipelines/p.ts", ticket: "T-1" }];

function runningStep(): RunStep {
  return makeRunStep({ id: "a", name: "a", command: "work", runner: "bash" }, { status: "running" });
}

function savedStep(run: Run) {
  return readRunSnapshot(join(run.run_dir, "state.json"))?.steps[0];
}

test("retry quota: each attempt is counted and persisted before it runs, each quota on its own", () => {
  const step = runningStep();
  const run = makeRun(step);

  expect(consumeRetry(run, step, "retries")).toBe(1);
  expect(consumeRetry(run, step, "timeout_retries")).toBe(1);
  expect(consumeRetry(run, step, "retries")).toBe(2);

  expect(savedStep(run)).toMatchObject({ retries: 2, timeout_retries: 1 });
});

test("retry quota: only an attempt the cost guard cut short gives its quota back", () => {
  const step = runningStep();
  const run = makeRun(step);
  consumeRetry(run, step, "retries");
  consumeRetry(run, step, "retries");

  expect(refundRetry(run, step, "retries", {})).toBe(false);
  expect(refundRetry(run, step, "retries", { budgetExceeded: false, costUnaccounted: false })).toBe(false);
  expect(step.retries).toBe(2);

  expect(refundRetry(run, step, "retries", { budgetExceeded: true })).toBe(true);
  expect(refundRetry(run, step, "retries", { costUnaccounted: true })).toBe(true);
  expect(step.retries).toBe(0);
  expect(savedStep(run)?.retries).toBe(0);
});

test("session: the session a step continues is persisted at once", () => {
  const step = runningStep();
  const run = makeRun(step);
  const session = { provider: "claude", id: "sess-1", resumable: true };

  bindSession(run, step, session);

  expect(step.session).toEqual(session);
  expect(savedStep(run)?.session).toEqual(session);
});

test("last command: kept in memory, the snapshot never carries it", () => {
  const step = runningStep();
  const run = makeRun(step);

  recordLastCommand(step, "make test");

  expect(step.last_command).toBe("make test");
  expect(existsSync(join(run.run_dir, "state.json"))).toBe(false);
});

test("unavailable source: journaled for the step, the snapshot untouched", () => {
  const step = runningStep();
  const run = makeRun(step);

  recordUnavailableSource(run, step, { source: "ticket", reason: "tracker unreachable" });

  expect(readRunEvents(run.run_dir)).toMatchObject([
    { type: "step.source.unavailable", stepId: "a", source: "ticket", reason: "tracker unreachable" },
  ]);
  expect(existsSync(join(run.run_dir, "state.json"))).toBe(false);
});

test("decision: journaled as an approval or a rejection, then the run is persisted", () => {
  const run = makeRun(runningStep());

  recordDecision(run, { subject: "plan", decision: "applied" });
  recordDecision(run, { subject: "plan", decision: "rejected", reason: "too broad", round: 2 });

  const events = readRunEvents(run.run_dir);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "decision.recorded", subject: "plan", decision: "approved" });
  expect(events[0]).not.toHaveProperty("reason");
  expect(events[1]).toMatchObject({ decision: "rejected", reason: "too broad", round: 2 });
  expect(existsSync(join(run.run_dir, "state.json"))).toBe(true);
});

test("orchestration node: opened once, persisted, and refused when its kind changed", () => {
  const step = runningStep();
  const run = makeRun(step);

  const state = openOrchestration(run, step, "forEachPipeline", ROOT_LINEAGE);
  expect(state).toEqual({ kind: "forEachPipeline", children: [] });
  expect(openOrchestration(run, step, "forEachPipeline", ROOT_LINEAGE)).toBe(state);
  expect(savedStep(run)?.orchestration).toEqual({ kind: "forEachPipeline", children: [] });

  expect(() => openOrchestration(run, step, "runPipeline", ROOT_LINEAGE)).toThrow(
    /orchestration type changed during resume/,
  );
});

test("orchestration node: the items are frozen as a copy and persisted", () => {
  const step = runningStep();
  const run = makeRun(step);
  const state = openOrchestration(run, step, "forEachPipeline", ROOT_LINEAGE);
  const items = ["T-1", "T-2"];

  const frozen = freezeOrchestrationItems(run, state, items);
  items.push("T-3");

  expect(frozen).toEqual(["T-1", "T-2"]);
  expect(state.items).toBe(frozen);
  expect(savedStep(run)?.orchestration?.items).toEqual(["T-1", "T-2"]);
});

test("orchestration node: the snapshot that opens it carries the run's lineage, recorded once", () => {
  const step = runningStep();
  const run = makeRun(step);

  openOrchestration(run, step, "runPipeline", ROOT_LINEAGE);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.pipelineLineage).toEqual(ROOT_LINEAGE);

  const booted = [...ROOT_LINEAGE, { pipelinePath: "/pipelines/child.ts", ticket: "T-1-01" }];
  const child = makeRun(runningStep());
  child.pipelineLineage = booted;
  openOrchestration(child, child.steps[0]!, "runPipeline", ROOT_LINEAGE);
  expect(readRunSnapshot(join(child.run_dir, "state.json"))?.pipelineLineage).toEqual(booted);
});
