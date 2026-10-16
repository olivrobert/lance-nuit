// Reconcile mode, rows R1 to R7 of the reconciliation matrix and the reconcile
// half of U1. A pipeline declaring `.reconcile()` no longer lets a `done` status
// stand for its work: every settled step is re-admitted, and its declared outputs
// decide. R8 is legacy.test.ts and until.test.ts, unchanged.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  failAt,
  heal,
  killDuring,
  latestRunId,
  mark,
  type RunSnapshot,
  removeArtifact,
  run,
  scratchRoute,
  skipsSince,
  snapshot,
  touchTicket,
  trace,
  traceSince,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];
const CHEAP = ["context", "prepare", "quality", "report"];
const UP_TO_PLAN = ["context", "branch", "triage", "plan"];
const AFTER_PLAN = ["prepare", "implement", "quality", "commit", "publish", "report"];

/** Exit code of a run `--until` stopped with work left (guide/cli-options.md). */
const UNTIL_EXIT = 3;

/** What admission says when a step's outputs match its inputs. */
const UP_TO_DATE = "outputs up to date with declared inputs";
/** What admission says, in reconcile mode, when a step without input finds every output it declares. */
const PRESENT = "outputs present";

const reconcile = { reconcile: true } as const;

function statusesOf(state: RunSnapshot): Record<string, string> {
  return Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
}

function reasons(cwd: string, since: ReturnType<typeof mark>): { stepId: string; reason: string }[] {
  return skipsSince(cwd, since).map(({ stepId, reason }) => ({ stepId, reason }));
}

function upToDate(...ids: string[]): { stepId: string; reason: string }[] {
  return ids.map((stepId) => ({ stepId, reason: UP_TO_DATE }));
}

function passedRun(cwd: string): string {
  const first = run(cwd);
  expect(first.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd)).toEqual(FULL);
  return latestRunId(cwd);
}

test("R1: a step with neither output nor rerunOnResume is a build error naming it and both ways out", () => {
  const cwd = scratchRoute({ ...reconcile, unclassified: true });

  const refused = run(cwd);

  expect(refused.status).toBe(1);
  expect(trace(cwd)).toEqual([]);
  expect(mark(cwd).runId).toBeUndefined();
  const message = refused.stdout + refused.stderr;
  expect(message).toContain(`step "comment"`);
  expect(message).toContain("or a receipt of its side effect, as output");
  expect(message).toContain("rerunOnResume: true");
  // Only the unclassified step is named: every other step of `route` declares one or the other.
  expect(message).not.toMatch(/"(context|branch|report)"/);
});

test("R2: a run after a PASS starts a new run that skips branch too, its output being present", () => {
  const cwd = scratchRoute(reconcile);
  const firstRun = passedRun(cwd);
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(CHEAP);
  expect(reasons(cwd, before)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement", "commit", "publish"),
  ]);
  expect(statusesOf(state).branch).toBe("skipped");
});

test("R3: a failure healed and resumed continues the same run from the failed step", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  const failed = run(cwd);
  expect(failed.status).not.toBe(0);
  expect(snapshot(cwd).status).toBe("FAIL");
  expect(statusesOf(snapshot(cwd)).implement).toBe("failed");
  const failedRun = latestRunId(cwd);
  expect(trace(cwd)).toEqual(["context", "branch", "triage", "plan", "prepare", "implement"]);
  heal(cwd, "implement");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  // Same trace as S3: context and prepare replay as on every resume.
  expect(traceSince(cwd, before)).toEqual([
    "context",
    "prepare",
    "implement",
    "quality",
    "commit",
    "publish",
    "report",
  ]);
  // branch is re-admitted rather than trusted on its status, and stays done.
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
  expect(statusesOf(state).branch).toBe("done");
  // The resume header tells the same story: branch is re-checked, nothing is trusted as done.
  const header = resumed.stdout + resumed.stderr;
  expect(header).toContain("Re-checked on resume: branch, triage, plan");
  expect(header).not.toContain("Resumed — already done");
});

test("R4: a receipt deleted by hand after a PASS replays its step and what depends on it, nothing before", () => {
  const cwd = scratchRoute(reconcile);
  passedRun(cwd);
  removeArtifact(cwd, "commit.sha");
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(["context", "prepare", "quality", "commit", "publish", "report"]);
  // implement is fresh; publish is not skipped: the new commit.sha it reads moved.
  expect(reasons(cwd, before)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement"),
  ]);
});

test("R5: a runner killed during publish stops the resume until the replay is authorized", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");
  const killedRun = latestRunId(cwd);
  expect(trace(cwd)).toEqual(FULL.slice(0, -1));
  const beforeStop = mark(cwd);

  const stopped = run(cwd);

  expect(stopped.status).toBe(0);
  expect(latestRunId(cwd)).toBe(killedRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("STOPPED");
  expect(state.outcome?.stop?.kind).toBe("needs-decision");
  expect(state.outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(state.outcome?.phase).toBe("publish");
  expect(statusesOf(state).publish).toBe("running");
  // Same pinned defect as S5: the rerunOnResume steps before publish replay before the guard stops.
  expect(traceSince(cwd, beforeStop)).toEqual(["context", "prepare", "quality"]);
  // The interrupted publish is not among the skips: freshness never vouches for a pass left unfinished.
  expect(reasons(cwd, beforeStop)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement", "commit"),
  ]);
  const beforeReplay = mark(cwd);

  const replayed = run(cwd, "--replay-interrupted");

  expect(replayed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeReplay)).toEqual(["context", "prepare", "quality", "publish", "report"]);
});

test("R6: a ticket edited after a PASS replays every step downstream of it, branch excepted", () => {
  const cwd = scratchRoute(reconcile);
  const firstRun = passedRun(cwd);
  touchTicket(cwd);
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FULL.filter((id) => id !== "branch"));
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }]);
});

test("R7: --run on a PASS run with --start-at replays the target and every later step in that run", () => {
  const cwd = scratchRoute(reconcile);
  const firstRun = passedRun(cwd);
  const before = mark(cwd);

  const replay = run(cwd, "--run", firstRun, "--start-at", "implement");

  expect(replay.status).toBe(0);
  expect(latestRunId(cwd)).toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  // Same trace as S7: --start-at outranks freshness from implement on.
  expect(traceSince(cwd, before)).toEqual([
    "context",
    "prepare",
    "implement",
    "quality",
    "commit",
    "publish",
    "report",
  ]);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
});

test("U1-R: --until plan stops after plan, and a plain rerun resumes the same run without repaying it", () => {
  const cwd = scratchRoute(reconcile);

  const bounded = run(cwd, "--until", "plan");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(trace(cwd)).toEqual(UP_TO_PLAN);
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.stop?.kind).toBe("until");
  expect(stopped.outcome?.phase).toBe("plan");
  expect(stopped.outcome?.resumable).toBe(true);
  expect(statusesOf(stopped)).toEqual({
    ...Object.fromEntries(UP_TO_PLAN.map((id) => [id, "done"])),
    ...Object.fromEntries(AFTER_PLAN.map((id) => [id, "pending"])),
  });
  const stoppedRun = latestRunId(cwd);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(["context", ...AFTER_PLAN]);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
});

test("--until after a PASS: the new run reaches the bound for free, and the rerun pays only CHEAP steps", () => {
  const cwd = scratchRoute(reconcile);
  passedRun(cwd);
  const before = mark(cwd);

  const bounded = run(cwd, "--until", "plan");

  // Every step up to the bound is settled by a skip, which reaches the bound like a run would.
  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(traceSince(cwd, before)).toEqual(["context"]);
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.stop?.kind).toBe("until");
  expect(statusesOf(stopped)).toMatchObject({
    branch: "skipped",
    triage: "skipped",
    plan: "skipped",
    prepare: "pending",
  });
  const stoppedRun = latestRunId(cwd);
  const beforeEnd = mark(cwd);

  const finished = run(cwd);

  expect(finished.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeEnd)).toEqual(CHEAP);
  // Skipped steps are re-admitted too: their outputs, not their status, decide.
  expect(reasons(cwd, beforeEnd)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement", "commit", "publish"),
  ]);
});
