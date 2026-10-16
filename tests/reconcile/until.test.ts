// `--until <step>`, rows U1 to U5 of the reconciliation matrix: a bound that
// belongs to one invocation. The run stops once the named step settled, stays
// resumable, and the bound is never persisted. U1 and U5 run in legacy mode; the
// reconcile half of U1 waits for the mode itself (L2).

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  killDuring,
  latestRunId,
  mark,
  run,
  runRaw,
  type RunSnapshot,
  scratchRoute,
  skipsSince,
  snapshot,
  trace,
  traceSince,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];
const UP_TO_PLAN = ["context", "branch", "triage", "plan"];
const AFTER_PLAN = ["prepare", "implement", "quality", "commit", "publish", "report"];

/** Exit code of a run `--until` stopped with work left, documented in
 *  guide/cli-options.md. A failure exits 1, a completed run 0. */
const UNTIL_EXIT = 3;

/** What admission says when a step's outputs match its inputs. */
const UP_TO_DATE = "outputs up to date with declared inputs";

function statusesOf(state: RunSnapshot): Record<string, string> {
  return Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
}

/** The stop `--until` leaves: its own kind, the bound as the phase, resumable. */
function expectUntilStop(state: RunSnapshot, bound: string): void {
  expect(state.status).toBe("STOPPED");
  expect(state.outcome?.stop?.kind).toBe("until");
  expect(state.outcome?.phase).toBe(bound);
  expect(state.outcome?.resumable).toBe(true);
}

test("U1: --until plan stops after plan with its own kind and exit code, and a plain rerun resumes the same run", () => {
  const cwd = scratchRoute();

  const bounded = run(cwd, "--until", "plan");

  // Neither 0 (a script would read the night as complete) nor 1 (a failure).
  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(trace(cwd)).toEqual(UP_TO_PLAN);
  const stopped = snapshot(cwd);
  expectUntilStop(stopped, "plan");
  // Not skipped: the steps after the bound are owed, which is what keeps the
  // run resumable instead of settled.
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
  // triage and plan are fresh, so not replayed; context declares rerunOnResume
  // and replays on every resume (legacy behavior pinned by S3).
  expect(traceSince(cwd, before)).toEqual(["context", ...AFTER_PLAN]);
  expect(skipsSince(cwd, before).map(({ stepId, reason }) => ({ stepId, reason }))).toEqual([
    { stepId: "triage", reason: UP_TO_DATE },
    { stepId: "plan", reason: UP_TO_DATE },
  ]);
});

test("U2: --until on an unknown step is refused before any step, listing the ids like --start-at", () => {
  const cwd = scratchRoute();
  const ids = FULL.join(", ");

  const refused = run(cwd, "--until", "nope");

  expect(refused.status).toBe(1);
  expect(trace(cwd)).toEqual([]);
  // No run was created: `latest` does not exist.
  expect(mark(cwd).runId).toBeUndefined();
  const message = `step "nope" not found in pipeline "route" (steps: ${ids}).`;
  expect(refused.stdout + refused.stderr).toContain(`--until: ${message}`);
  const startAt = run(cwd, "--start-at", "nope");
  expect(startAt.status).toBe(1);
  expect(startAt.stdout + startAt.stderr).toContain(`--start-at: ${message}`);
});

test("U2 under --scan: an unknown step is refused by the parent, before any child run", () => {
  const tickets = ["T-1", "T-2"];
  const cwd = scratchRoute({ scan: tickets });

  const refused = runRaw(cwd, "--scan", "--pipeline", "route", "--until", "nope");

  expect(refused.status).toBe(1);
  expect(trace(cwd)).toEqual([]);
  expect(refused.stdout + refused.stderr).toContain(`--until: step "nope" not found in pipeline "route"`);
  for (const ticket of tickets) expect(mark(cwd, ticket).runId).toBeUndefined();
});

test("a bound settled by a skip is reached as well: --until branch --skip branch stops after it", () => {
  const cwd = scratchRoute();

  const bounded = run(cwd, "--until", "branch", "--skip", "branch");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(trace(cwd)).toEqual(["context"]);
  const state = snapshot(cwd);
  expectUntilStop(state, "branch");
  expect(statusesOf(state)).toMatchObject({ context: "done", branch: "skipped", triage: "pending" });
});

test("a runner killed inside the bound step stops the resume until the replay is authorized, then stops at the bound", async () => {
  const cwd = scratchRoute();
  await killDuring(cwd, "plan", "--until", "plan");
  const killedRun = latestRunId(cwd);
  const beforeStop = mark(cwd);

  const stopped = run(cwd, "--until", "plan");

  // The interruption guard decides, not the bound: plan still owes work.
  expect(stopped.status).toBe(0);
  expect(latestRunId(cwd)).toBe(killedRun);
  const guarded = snapshot(cwd);
  expect(guarded.status).toBe("STOPPED");
  expect(guarded.outcome?.stop?.kind).toBe("needs-decision");
  expect(guarded.outcome?.phase).toBe("plan");
  expect(traceSince(cwd, beforeStop)).not.toContain("plan");
  const beforeReplay = mark(cwd);

  const replayed = run(cwd, "--replay-interrupted", "--until", "plan");

  expect(replayed.status).toBe(UNTIL_EXIT);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(traceSince(cwd, beforeReplay)).toEqual(["context", "plan"]);
  const state = snapshot(cwd);
  expectUntilStop(state, "plan");
  expect(statusesOf(state).implement).toBe("pending");
});

test("U3: --until on the last step is a normal PASS, not a stop", () => {
  const cwd = scratchRoute();

  const completed = run(cwd, "--until", "report");

  expect(completed.status).toBe(0);
  expect(trace(cwd)).toEqual(FULL);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  expect(state.outcome?.stop).toBeUndefined();
  expect(state.stopped_reason).toBeUndefined();
});

test("U4: --until under --scan reaches every ticket, each stopping after plan, and a later scan finishes them", () => {
  const tickets = ["T-1", "T-2"];
  const cwd = scratchRoute({ scan: tickets });

  const scan = runRaw(cwd, "--scan", "--pipeline", "route", "--until", "plan");

  // The scan itself completed: a requested stop is no failed ticket.
  expect(scan.status).toBe(0);
  expect(trace(cwd)).toEqual([...UP_TO_PLAN, ...UP_TO_PLAN]);
  for (const ticket of tickets) {
    const state = snapshot(cwd, ticket);
    expectUntilStop(state, "plan");
    expect(statusesOf(state).prepare).toBe("pending");
  }
  expect(scan.stderr).toMatch(/Until\s*: 2 → T-1, T-2/);
  expect(scan.stderr).toMatch(/Failed\s*: 0/);
  expect(scan.stderr).toMatch(/Escalated\s*: 0/);
  const stoppedRuns = tickets.map((ticket) => latestRunId(cwd, ticket));
  const before = mark(cwd);

  const finish = runRaw(cwd, "--scan", "--pipeline", "route");

  expect(finish.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual([...["context", ...AFTER_PLAN], ...["context", ...AFTER_PLAN]]);
  expect(tickets.map((ticket) => latestRunId(cwd, ticket))).toEqual(stoppedRuns);
  for (const ticket of tickets) expect(snapshot(cwd, ticket).status).toBe("PASS");
});

test("U5: the bound is never persisted, so each invocation answers to its own bound only", () => {
  const cwd = scratchRoute();
  expect(run(cwd, "--until", "plan").status).toBe(UNTIL_EXIT);
  const runId = latestRunId(cwd);
  const beforeTriage = mark(cwd);

  const triage = run(cwd, "--start-at", "triage", "--until", "triage");

  expect(triage.status).toBe(UNTIL_EXIT);
  expect(latestRunId(cwd)).toBe(runId);
  // context is done and declares rerunOnResume: --start-at does not exclude it
  // (legacy behavior pinned by S7).
  expect(traceSince(cwd, beforeTriage)).toEqual(["context", "triage"]);
  expectUntilStop(snapshot(cwd), "triage");
  // Nothing on the snapshot carries a bound for a later invocation to obey.
  expect(JSON.stringify(snapshot(cwd))).not.toMatch(/"until[^"]*":/);
  const beforeImplement = mark(cwd);

  // Neither plan nor triage, the earlier bounds, stops this one.
  const implement = run(cwd, "--until", "implement");

  expect(implement.status).toBe(UNTIL_EXIT);
  expect(latestRunId(cwd)).toBe(runId);
  // --start-at requeued plan, so it runs although fresh; triage is fresh and
  // skipped, context replays as on every resume.
  expect(traceSince(cwd, beforeImplement)).toEqual(["context", "plan", "prepare", "implement"]);
  expectUntilStop(snapshot(cwd), "implement");
  const beforeEnd = mark(cwd);

  const unbounded = run(cwd);

  expect(unbounded.status).toBe(0);
  expect(latestRunId(cwd)).toBe(runId);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeEnd)).toEqual(["context", "prepare", "quality", "commit", "publish", "report"]);
});
