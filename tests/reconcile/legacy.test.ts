// Characterization of the legacy resume (no reconcile mode), rows S1 to S7 of the
// reconciliation matrix. These pin today's behavior, defects included, so each
// later lot shows exactly what it changes.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  failAt,
  heal,
  killDuring,
  latestRunId,
  run,
  scratchRoute,
  snapshot,
  touchTicket,
  trace,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];

/** Steps that a new run or a resume replays when their inputs did not move. */
const CHEAP_AND_BRANCH = ["context", "branch", "prepare", "quality", "report"];

function statuses(cwd: string): Record<string, string> {
  return Object.fromEntries(snapshot(cwd).steps.map((step) => [step.id, step.status]));
}

function passedRun(cwd: string): string {
  const first = run(cwd);
  expect(first.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  return latestRunId(cwd);
}

test("S1: a run after a PASS starts a new run that replays only CHEAP steps and branch", () => {
  const cwd = scratchRoute();
  const firstRun = passedRun(cwd);
  expect(trace(cwd)).toEqual(FULL);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd).slice(FULL.length)).toEqual(CHEAP_AND_BRANCH);
});

// Pinned defect: `comment` has a side effect and no receipt, so nothing tells a
// later run it already happened, and it happens twice. Decision D2 makes such a
// step a build error in reconcile mode; legacy keeps the duplicate.
test("S2: an unclassified side effect runs again on the run after a PASS", () => {
  const cwd = scratchRoute({ unclassified: true });
  passedRun(cwd);

  expect(run(cwd).status).toBe(0);

  expect(trace(cwd).filter((id) => id === "comment")).toHaveLength(2);
  expect(trace(cwd)).toEqual([
    ...FULL.slice(0, -1),
    "comment",
    "report",
    "context",
    "branch",
    "prepare",
    "quality",
    "comment",
    "report",
  ]);
});

test("S3: a failure healed and resumed continues the same run from the failed step", () => {
  const cwd = scratchRoute();
  failAt(cwd, "implement");
  const failed = run(cwd);
  expect(failed.status).not.toBe(0);
  expect(snapshot(cwd).status).toBe("FAIL");
  expect(statuses(cwd).implement).toBe("failed");
  const failedRun = latestRunId(cwd);
  expect(trace(cwd)).toEqual(["context", "branch", "triage", "plan", "prepare", "implement"]);
  heal(cwd, "implement");

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  // The matrix row only names triage and plan as not replayed; context and
  // prepare declare rerunOnResume, so the resume replays them before implement.
  expect(trace(cwd).slice(6)).toEqual(["context", "prepare", "implement", "quality", "commit", "publish", "report"]);
});

// Pinned defect: `--skip` is persisted as an exclusion, and the run passes
// without `quality` ever running. In reconcile mode, L3 makes selectors last for
// one invocation only.
test("S4: --skip on a first run persists the exclusion and the run passes without the step", () => {
  const cwd = scratchRoute();

  const skipped = run(cwd, "--skip", "quality");

  expect(skipped.status).toBe(0);
  expect(trace(cwd)).toEqual(FULL.filter((id) => id !== "quality"));
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  const quality = state.steps.find((step) => step.id === "quality");
  expect(quality).toMatchObject({ status: "skipped", excluded: true });
  expect(state.steps.filter((step) => step.excluded).map((step) => step.id)).toEqual(["quality"]);
});

test("S5: a runner killed during publish stops the resume until the replay is authorized", async () => {
  const cwd = scratchRoute();
  await killDuring(cwd, "publish");
  const killedRun = latestRunId(cwd);
  expect(trace(cwd)).toEqual(FULL.slice(0, -1));
  expect(snapshot(cwd).status).toBe("RUNNING");

  const stopped = run(cwd);

  expect(latestRunId(cwd)).toBe(killedRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("STOPPED");
  expect(state.outcome?.stop?.kind).toBe("needs-decision");
  expect(state.outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(state.outcome?.phase).toBe("publish");
  // The snapshot keeps the dead attempt's status: the stop does not settle it.
  expect(statuses(cwd).publish).toBe("running");
  // CHEAP steps before publish replay; publish itself does not run.
  expect(trace(cwd).slice(FULL.length - 1)).toEqual(["context", "prepare", "quality"]);
  // A clean stop is not a failure: the process exits 0, only the snapshot says STOPPED.
  expect(stopped.status).toBe(0);

  const replayed = run(cwd, "--replay-interrupted");

  expect(replayed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd).slice(FULL.length + 2)).toEqual(["context", "prepare", "quality", "publish", "report"]);
});

test("S6: a ticket edited after a PASS replays every step downstream of it in a new run", () => {
  const cwd = scratchRoute();
  const firstRun = passedRun(cwd);
  touchTicket(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd).slice(FULL.length)).toEqual(FULL);
});

test("S7: --run on a PASS run with --start-at replays the target and every later step in that run", () => {
  const cwd = scratchRoute();
  const firstRun = passedRun(cwd);

  const replay = run(cwd, "--run", firstRun, "--start-at", "implement");

  expect(replay.status).toBe(0);
  expect(latestRunId(cwd)).toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  // Before the target, only the rerunOnResume steps replay: triage and plan are
  // reconsidered but fresh, branch is done and not reconsidered.
  expect(trace(cwd).slice(FULL.length)).toEqual([
    "context",
    "prepare",
    "implement",
    "quality",
    "commit",
    "publish",
    "report",
  ]);
});
