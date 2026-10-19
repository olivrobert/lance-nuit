// The meaning of a run status, and the one precedence a run's ending is read
// from. The readers that apply these rules are tested in
// `tests/runner/run-status-readers.test.ts`.

import { expect, test } from "bun:test";
import type { RunStatus } from "../model/persisted.js";
import { costIsLowerBound } from "./cost-accounting.js";
import {
  awaitsFinalization,
  awaitsHuman,
  effectiveStatus,
  hasVerdict,
  isCompleted,
  isFailure,
  isHalted,
  isProvisionalStatus,
  isResumableStatus,
  type RunEndingFacts,
  runEnding,
  VERDICT_STATUSES,
} from "./run-status.js";

const STATUSES: readonly RunStatus[] = ["RUNNING", "PASS", "FAIL", "STOPPED", "ABORTED", "UNKNOWN"];

function holding(statuses: readonly RunStatus[], predicate: (status: RunStatus) => boolean): RunStatus[] {
  return statuses.filter(predicate);
}

test("meaning: each question about a status has one answer per status", () => {
  expect(holding(STATUSES, hasVerdict)).toEqual(["PASS", "FAIL", "STOPPED", "ABORTED"]);
  expect(holding(STATUSES, isCompleted)).toEqual(["PASS"]);
  expect(holding(STATUSES, isFailure)).toEqual(["FAIL", "ABORTED"]);
  expect(holding(STATUSES, isHalted)).toEqual(["STOPPED", "ABORTED"]);
  expect(holding(STATUSES, awaitsHuman)).toEqual(["FAIL", "STOPPED", "ABORTED"]);
  expect(holding(STATUSES, isProvisionalStatus)).toEqual(["RUNNING", "ABORTED"]);
  expect(holding(STATUSES, (status) => status !== "RUNNING" && isResumableStatus(status))).toEqual([
    "FAIL",
    "STOPPED",
    "ABORTED",
    "UNKNOWN",
  ]);
  expect(VERDICT_STATUSES).toEqual(["PASS", "FAIL", "STOPPED", "ABORTED"]);
});

test("meaning: a missing status, or one a newer runner wrote, means nothing", () => {
  for (const status of [undefined, "LATER" as RunStatus, "toString" as RunStatus]) {
    expect(hasVerdict(status)).toBe(false);
    expect(isCompleted(status)).toBe(false);
    expect(isFailure(status)).toBe(false);
    expect(awaitsHuman(status)).toBe(false);
  }
});

test("effective status: a verdict stands, and the lock is not even asked", () => {
  for (const status of ["PASS", "FAIL", "STOPPED", "ABORTED"] as const) {
    expect(
      effectiveStatus({ status }, () => {
        throw new Error("asked");
      }),
    ).toEqual({ status, interrupted: false });
  }
});

test("effective status: a snapshot without a verdict runs only while a live process holds it", () => {
  for (const status of ["RUNNING", "UNKNOWN", undefined, "LATER"] as Array<RunStatus | undefined>) {
    expect(effectiveStatus({ status }, () => true)).toEqual({ status: "RUNNING", interrupted: false });
    expect(effectiveStatus({ status }, () => false)).toEqual({ status: "ABORTED", interrupted: true });
  }
});

test("finalization: a crash or a resumable interruption still owes a verdict", () => {
  expect(awaitsFinalization({ status: "RUNNING" })).toBe(true);
  expect(awaitsFinalization({ status: "ABORTED" })).toBe(true);
  expect(
    awaitsFinalization({ status: "ABORTED", outcome: { phase: null, reason: null, logPath: null, resumable: false } }),
  ).toBe(false);
  for (const status of ["PASS", "FAIL", "STOPPED", "UNKNOWN"] as const)
    expect(awaitsFinalization({ status })).toBe(false);
});

// One row per ending: the status the snapshot keeps, the headline of the report
// and the exit class are read from the same row, so they cannot disagree.
const ENDINGS: Array<[string, RunEndingFacts, ReturnType<typeof runEnding>]> = [
  ["interrupted", { aborted: true, failed: true }, { kind: "aborted", status: "ABORTED", exit: "interrupted" }],
  ["budget stop", { budgetExceeded: true, failed: true }, { kind: "budget", status: "FAIL", exit: "failure" }],
  [
    "budget stop of a halted child",
    { budgetExceeded: true, stopped: true },
    { kind: "budget", status: "STOPPED", exit: "failure" },
  ],
  [
    "a judgment on the work",
    { failed: true, verdictFailure: true },
    { kind: "verdict", status: "FAIL", exit: "failure" },
  ],
  ["an incident", { failed: true }, { kind: "failure", status: "FAIL", exit: "failure" }],
  [
    "a blocked step stops the run",
    { failed: true, stopped: true },
    { kind: "failure", status: "STOPPED", exit: "failure" },
  ],
  [
    "the accounting gate withheld the work",
    { failed: true, costUnaccounted: true, costUnaccountedStop: true },
    { kind: "cost", status: "FAIL", exit: "failure" },
  ],
  ["a clean stop", { stopped: true }, { kind: "stopped", status: "STOPPED", exit: "success" }],
  ["the --until bound", { stopped: true, untilStop: true }, { kind: "stopped", status: "STOPPED", exit: "until" }],
  [
    "a clean stop over an unpriced ledger",
    { stopped: true, costUnaccounted: true },
    { kind: "stopped", status: "STOPPED", exit: "failure" },
  ],
  [
    "an unpriced ledger alone",
    { costUnaccounted: true, settled: true },
    { kind: "unknown", status: "FAIL", exit: "failure" },
  ],
  ["success", { settled: true }, { kind: "success", status: "PASS", exit: "success" }],
  ["unsettled, nothing known", {}, { kind: "unknown", status: "UNKNOWN", exit: "success" }],
];

for (const [label, facts, ending] of ENDINGS) {
  test(`ending: ${label}`, () => {
    expect(runEnding(facts)).toEqual(ending);
  });
}

test("lower bound: the latch, the totals, a step or an attempt each make the total partial", () => {
  expect(costIsLowerBound({ steps: [{ control: { duration_ms: 1, total_cost_usd: 1 } }] })).toBe(false);
  expect(costIsLowerBound({ cost_unaccounted: true })).toBe(true);
  expect(costIsLowerBound({ total_control: { duration_ms: 1, cost_unknown: true } })).toBe(true);
  // An attempt closed before it measured anything proves no unpriced spend to
  // the stop, but its total is still partial.
  expect(costIsLowerBound({ steps: [{ control: { duration_ms: 1, cost_unknown: true } }] })).toBe(true);
  expect(costIsLowerBound({ steps: [{ attempts: [{ control: { duration_ms: 1, cost_unknown: true } }] }] })).toBe(true);
});
