import { expect, test } from "bun:test";
import type { PersistedRun } from "../../run/index.js";
import { failureOf, stopOf } from "./run-facts.ts";

/** A snapshot reduced to what the facts read. */
function snapshot(fields: Partial<PersistedRun>): PersistedRun {
  return { steps: [], ...fields } as PersistedRun;
}

test("run facts: a failure keeps the runner's words for its kind and cause", () => {
  const state = snapshot({
    outcome: {
      phase: "tests",
      reason: "the database is down",
      logPath: null,
      resumable: true,
      failKind: "technical",
      failCause: "blocked",
    },
  });

  expect(failureOf(state, "FAIL", false)).toEqual({
    phase: "tests",
    reason: "the database is down",
    kind: "technical",
    cause: "blocked",
  });
});

test("run facts: an interrupted run fails in the step it was in, whatever its outcome says", () => {
  const state = snapshot({
    steps: [
      { id: "plan", status: "done" },
      { id: "coder", status: "running" },
    ] as PersistedRun["steps"],
    outcome: { phase: "plan", reason: "stale", logPath: null, resumable: true, failKind: "verdict" },
  });

  const failure = failureOf(state, "ABORTED", true);

  expect(failure?.phase).toBe("coder");
  expect(failure?.kind).toBeUndefined();
  expect(failure?.reason).toContain("died without recording a verdict");
});

test("run facts: only a failed or interrupted run has a failure, only a stopped run a stop", () => {
  const state = snapshot({ outcome: { phase: "plan", reason: "done", logPath: null, resumable: false } });

  expect(failureOf(state, "PASS", false)).toBeUndefined();
  expect(failureOf(state, "STOPPED", false)).toBeUndefined();
  expect(failureOf(state, "RUNNING", false)).toBeUndefined();
  expect(stopOf(state, "FAIL")).toBeUndefined();
  expect(stopOf(state, "PASS")).toBeUndefined();
});

test("run facts: a stop written before outcome.stop existed keeps its console sentence as detail", () => {
  const state = snapshot({ stopped_reason: "escalated: plan needs approval" });

  expect(stopOf(state, "STOPPED")).toEqual({ detail: "escalated: plan needs approval" });
});
