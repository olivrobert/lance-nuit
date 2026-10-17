// Selectors in reconcile mode, rows K1 to K3 of the reconciliation matrix.
// `--steps`, `--skip` and `--start-at` set steps aside for one invocation: nothing
// is persisted as an exclusion, the journal says why each step was left out, and
// the next invocation reconciles them like any other step. K3 pins that legacy
// mode keeps persisting the exclusion (S4 in legacy.test.ts, unchanged).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  eventsSince,
  failAt,
  heal,
  interruptDuring,
  killDuring,
  latestRunId,
  type Mark,
  mark,
  PIPELINE,
  partialAt,
  provenanceRecords,
  readArtifact,
  type RunSnapshot,
  removeArtifact,
  run,
  runRaw,
  routeSource,
  scratchRoute,
  skipsSince,
  snapshot,
  TICKET,
  trace,
  traceSince,
  writePipelines,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];
const CHEAP = ["context", "prepare", "quality", "report"];
const UP_TO_IMPLEMENT = ["context", "branch", "triage", "plan", "implement"];
const AFTER_IMPLEMENT = ["context", "prepare", "quality", "commit", "publish", "report"];

/** Exit code of a run `--until` stopped with work left (guide/cli-options.md). */
const UNTIL_EXIT = 3;

/** What the journal says of a step this invocation's selectors left out. */
const SELECTION = "operator selection";
const UP_TO_DATE = "outputs up to date with declared inputs";
const PRESENT = "outputs present";

const reconcile = { reconcile: true } as const;

/** A mark naming no run: `skipsSince` then reads the whole journal of the `latest` run. */
const WHOLE_RUN: Mark = { traceLength: 0, journalLength: 0 };

function statusesOf(state: RunSnapshot): Record<string, string> {
  return Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
}

function reasons(cwd: string, since: Mark, ticket?: string): { stepId: string; reason: string }[] {
  return skipsSince(cwd, since, ticket).map(({ stepId, reason }) => ({ stepId, reason }));
}

function setAside(...ids: string[]): { stepId: string; reason: string }[] {
  return ids.map((stepId) => ({ stepId, reason: SELECTION }));
}

function upToDate(...ids: string[]): { stepId: string; reason: string }[] {
  return ids.map((stepId) => ({ stepId, reason: UP_TO_DATE }));
}

/** No step of the snapshot carries an exclusion, not even a `false` one. */
function expectNoExclusion(state: RunSnapshot): void {
  expect(state.steps.filter((step) => "excluded" in step).map((step) => step.id)).toEqual([]);
}

function passedRun(cwd: string): string {
  const first = run(cwd);
  expect(first.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd)).toEqual(FULL);
  return latestRunId(cwd);
}

/** Writes artifact `name` of `T-1` by hand: what a pass cut short may have left behind. */
function writePartialArtifact(cwd: string, name: string): void {
  writeFileSync(join(cwd, ".lance-nuit", "work-items", TICKET, "artifacts", name), "partial\n");
}

/** Rewrites the pipeline in place, as an author switching its mode between two invocations. */
function switchMode(cwd: string, options: { reconcile: boolean }): void {
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${PIPELINE}.ts`), routeSource(options));
}

test("K1: --skip on a first run sets the step aside for that run only, and the next run reconciles it", () => {
  const cwd = scratchRoute(reconcile);
  const before = mark(cwd);

  const skipped = run(cwd, "--skip", "quality");

  expect(skipped.status).toBe(0);
  expect(trace(cwd)).toEqual(FULL.filter((id) => id !== "quality"));
  const state = snapshot(cwd);
  // Nothing is left to do once the selection is honored, and a rerun is free.
  expect(state.status).toBe("PASS");
  expect(statusesOf(state).quality).toBe("skipped");
  expectNoExclusion(state);
  expect(reasons(cwd, before)).toEqual(setAside("quality"));
  expect(skipped.stderr).toContain("1 step set aside by operator selection: quality");
  const firstRun = latestRunId(cwd);
  const beforeRerun = mark(cwd);

  const rerun = run(cwd);

  expect(rerun.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  // Same trace as R2: quality runs again because it is rerunOnResume, not because it owes anything.
  expect(traceSince(cwd, beforeRerun)).toEqual(CHEAP);
  expect(reasons(cwd, beforeRerun)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement", "commit", "publish"),
  ]);
  expect(rerun.stderr).not.toContain("set aside");
});

test("K1: a step set aside on a run left unfinished is re-admitted by the next invocation of that run", () => {
  const cwd = scratchRoute(reconcile);

  const bounded = run(cwd, "--skip", "prepare", "--until", "implement");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(trace(cwd)).toEqual(UP_TO_IMPLEMENT);
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.stop?.kind).toBe("until");
  expect(statusesOf(stopped).prepare).toBe("skipped");
  expectNoExclusion(stopped);
  expect(reasons(cwd, WHOLE_RUN)).toEqual(setAside("prepare"));
  const stoppedRun = latestRunId(cwd);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(AFTER_IMPLEMENT);
  expect(reasons(cwd, before)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement"),
  ]);
  expectNoExclusion(snapshot(cwd));
});

test("K1: an exclusion a legacy invocation persisted no longer binds once the pipeline reconciles", () => {
  const cwd = scratchRoute();
  expect(run(cwd, "--skip", "prepare", "--until", "implement").status).toBe(UNTIL_EXIT);
  expect(snapshot(cwd).steps.find((step) => step.id === "prepare")).toMatchObject({
    status: "skipped",
    excluded: true,
  });
  const stoppedRun = latestRunId(cwd);
  switchMode(cwd, reconcile);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(AFTER_IMPLEMENT);
  expectNoExclusion(snapshot(cwd));
});

test("K2: --steps after a PASS admits only the named step, which a fresh deliverable skips", () => {
  const cwd = scratchRoute(reconcile);
  const firstRun = passedRun(cwd);
  const before = mark(cwd);

  const selected = run(cwd, "--steps", "implement");

  expect(selected.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  // Not even the rerunOnResume steps run: the selection decides what is admitted.
  expect(traceSince(cwd, before)).toEqual([]);
  expect(reasons(cwd, before)).toEqual([
    ...setAside("context", "branch", "triage", "plan", "prepare"),
    ...upToDate("implement"),
    ...setAside("quality", "commit", "publish", "report"),
  ]);
  expectNoExclusion(state);
  expect(selected.stderr).toContain(
    "9 steps set aside by operator selection: context, branch, triage, plan, prepare, quality, commit, publish, report",
  );
});

test("K2: --steps runs a step that owes its deliverable, and the next run reconciles what it left stale", () => {
  const cwd = scratchRoute(reconcile);
  passedRun(cwd);
  removeArtifact(cwd, "impl.md");
  const before = mark(cwd);

  const selected = run(cwd, "--steps", "implement");

  expect(selected.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(["implement"]);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  expectNoExclusion(state);
  // commit and publish read the new impl.md: stale, yet left out by the selection.
  expect(reasons(cwd, before)).toEqual(
    setAside("context", "branch", "triage", "plan", "prepare", "quality", "commit", "publish", "report"),
  );
  const beforeRerun = mark(cwd);

  const rerun = run(cwd);

  expect(rerun.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeRerun)).toEqual(["context", "prepare", "quality", "commit", "publish", "report"]);
  expect(reasons(cwd, beforeRerun)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement"),
  ]);
});

test("K2: on a resumed run, --steps sets aside settled steps too, keeping their status", () => {
  const cwd = scratchRoute(reconcile);
  expect(run(cwd, "--until", "plan").status).toBe(UNTIL_EXIT);
  const stoppedRun = latestRunId(cwd);
  const before = mark(cwd);

  const selected = run(cwd, "--steps", "implement");

  expect(selected.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  // context is done and rerunOnResume, yet the selection keeps it out.
  expect(traceSince(cwd, before)).toEqual(["implement"]);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  expect(statusesOf(state)).toEqual({
    context: "done",
    branch: "done",
    triage: "done",
    plan: "done",
    prepare: "skipped",
    implement: "done",
    quality: "skipped",
    commit: "skipped",
    publish: "skipped",
    report: "skipped",
  });
  expectNoExclusion(state);
  expect(reasons(cwd, before)).toEqual(
    setAside("context", "branch", "triage", "plan", "prepare", "quality", "commit", "publish", "report"),
  );
});

test("--start-at on a first run sets the steps before it aside, and the next run reconciles them", () => {
  const cwd = scratchRoute(reconcile);

  const started = run(cwd, "--start-at", "implement");

  expect(started.status).toBe(0);
  expect(trace(cwd)).toEqual(["implement", "quality", "commit", "publish", "report"]);
  const state = snapshot(cwd);
  expect(state.status).toBe("PASS");
  expectNoExclusion(state);
  expect(reasons(cwd, WHOLE_RUN)).toEqual(setAside("context", "branch", "triage", "plan", "prepare"));
  const firstRun = latestRunId(cwd);
  const before = mark(cwd);

  const rerun = run(cwd);

  expect(rerun.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  // branch, triage and plan never ran; implement reads the plan.md they now write.
  expect(traceSince(cwd, before)).toEqual(FULL);
});

test("--skip under --scan sets the step aside in every ticket's run, and a later scan reconciles it", () => {
  const tickets = ["T-1", "T-2"];
  const cwd = scratchRoute({ ...reconcile, scan: tickets });

  const scan = runRaw(cwd, "--scan", "--pipeline", PIPELINE, "--skip", "prepare", "--until", "implement");

  expect(scan.status).toBe(0);
  expect(trace(cwd)).toEqual([...UP_TO_IMPLEMENT, ...UP_TO_IMPLEMENT]);
  for (const ticket of tickets) {
    const state = snapshot(cwd, ticket);
    expect(state.outcome?.stop?.kind).toBe("until");
    expect(statusesOf(state).prepare).toBe("skipped");
    expectNoExclusion(state);
    expect(reasons(cwd, WHOLE_RUN, ticket)).toContainEqual({ stepId: "prepare", reason: SELECTION });
  }
  const before = mark(cwd);

  const finish = runRaw(cwd, "--scan", "--pipeline", PIPELINE);

  expect(finish.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual([...AFTER_IMPLEMENT, ...AFTER_IMPLEMENT]);
  for (const ticket of tickets) expect(snapshot(cwd, ticket).status).toBe("PASS");
});

// A pass left unfinished keeps its status under an ephemeral selection, and the
// run stops for a decision: the interruption guard and the rerun a failed pass is
// owed are run facts the next invocation reads from that status. Adopting what
// the pass wrote is a separate question, which the in-flight mark answers on
// every invocation (inflight.test.ts), whatever the status.

test("a step killed mid-pass and left out by --skip still needs the replay authorized on the next resume", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");
  const killedRun = latestRunId(cwd);
  failAt(cwd, "report");
  const beforeSkip = mark(cwd);

  const skipped = run(cwd, "--skip", "publish");

  expect(skipped.status).toBe(1);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(traceSince(cwd, beforeSkip)).toEqual(["context", "prepare", "quality", "report"]);
  expect(snapshot(cwd).status).toBe("FAIL");
  expect(statusesOf(snapshot(cwd)).publish).toBe("running");
  expect(reasons(cwd, beforeSkip)).toContainEqual({ stepId: "publish", reason: SELECTION });
  heal(cwd, "report");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(latestRunId(cwd)).toBe(killedRun);
  const state = snapshot(cwd);
  expect(state.status).toBe("STOPPED");
  expect(state.outcome?.stop?.kind).toBe("needs-decision");
  expect(state.outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(traceSince(cwd, before)).not.toContain("publish");
  expect(resumed.stderr + resumed.stdout).not.toContain("replaying after an interrupted attempt");
});

test("a partial output of a killed pass left out by --skip is never adopted, and the run does not pass", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");
  writePartialArtifact(cwd, "mr-url.txt");
  const beforeSkip = mark(cwd);

  const skipped = run(cwd, "--skip", "publish");

  // Everything else ran; publish still owes the decision about its interrupted pass.
  expect(skipped.status).toBe(0);
  expect(traceSince(cwd, beforeSkip)).toEqual(["context", "prepare", "quality", "report"]);
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.stop?.kind).toBe("needs-decision");
  expect(stopped.outcome?.phase).toBe("publish");
  expect(statusesOf(stopped).publish).toBe("running");
  expect(skipped.stderr).toContain("1 step set aside by operator selection: publish");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(snapshot(cwd).status).toBe("STOPPED");
  expect(snapshot(cwd).outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(traceSince(cwd, before)).not.toContain("publish");
  expect(reasons(cwd, before).map(({ stepId }) => stepId)).not.toContain("publish");
  const beforeReplay = mark(cwd);

  const replayed = run(cwd, "--replay-interrupted");

  expect(replayed.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeReplay)).toEqual(["context", "prepare", "quality", "publish", "report"]);
});

test("a failed step left out by --skip stays failed, so the next resume reruns it over its partial output", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  expect(run(cwd).status).toBe(1);
  writePartialArtifact(cwd, "impl.md");
  const failedRun = latestRunId(cwd);
  const beforeSkip = mark(cwd);

  const skipped = run(cwd, "--skip", "implement");

  expect(skipped.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(traceSince(cwd, beforeSkip)).not.toContain("implement");
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.phase).toBe("implement");
  expect(statusesOf(stopped).implement).toBe("failed");
  heal(cwd, "implement");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toContain("implement");
  expect(reasons(cwd, before).map(({ stepId }) => stepId)).not.toContain("implement");
});

test("an --until bound left out while its last pass failed still stops the run after it", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "plan");
  expect(run(cwd).status).toBe(1);
  heal(cwd, "plan");
  const failedRun = latestRunId(cwd);
  const before = mark(cwd);

  const bounded = run(cwd, "--skip", "plan", "--until", "plan");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(traceSince(cwd, before)).toEqual(["context"]);
  const state = snapshot(cwd);
  expect(state.outcome?.stop?.kind).toBe("until");
  expect(statusesOf(state)).toMatchObject({
    plan: "failed",
    prepare: "pending",
    implement: "pending",
    publish: "pending",
    report: "pending",
  });
});

test("an --until bound left out while it was killed mid-pass still stops the run after it", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "plan");
  const before = mark(cwd);

  const bounded = run(cwd, "--skip", "plan", "--until", "plan");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(traceSince(cwd, before)).toEqual(["context"]);
  const state = snapshot(cwd);
  expect(state.outcome?.stop?.kind).toBe("until");
  expect(statusesOf(state)).toMatchObject({ plan: "running", prepare: "pending", report: "pending" });
});

test("an --until stop reached after a step left out unfinished keeps its own kind and names its own step", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  expect(run(cwd).status).toBe(1);
  const before = mark(cwd);

  const bounded = run(cwd, "--skip", "implement", "--until", "commit");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(traceSince(cwd, before)).toEqual(["context", "prepare", "quality", "commit"]);
  const state = snapshot(cwd);
  expect(state.outcome?.stop?.kind).toBe("until");
  // The failed step was set aside: it did not end this invocation.
  expect(state.outcome?.phase).toBe("commit");
  expect(statusesOf(state).implement).toBe("failed");
});

test("a failure after a step left out unfinished is reported as that failure, not as the step set aside", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  expect(run(cwd).status).toBe(1);
  heal(cwd, "implement");
  failAt(cwd, "report");

  const failed = run(cwd, "--skip", "implement");

  expect(failed.status).toBe(1);
  const state = snapshot(cwd);
  expect(state.status).toBe("FAIL");
  expect(state.outcome?.phase).toBe("report");
  expect(state.outcome?.reason).toContain("report: forced failure");
  expect(statusesOf(state)).toMatchObject({ implement: "failed", report: "failed" });
});

test("the interruption guard's stop is kept when the selection also left an unfinished step out", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");
  failAt(cwd, "implement");
  // The replay requeues publish as pending, its last attempt still interrupted.
  expect(run(cwd, "--start-at", "implement").status).toBe(1);
  expect(statusesOf(snapshot(cwd))).toMatchObject({ implement: "failed", publish: "pending" });
  const before = mark(cwd);

  const skipped = run(cwd, "--skip", "implement");

  expect(skipped.status).toBe(0);
  expect(traceSince(cwd, before)).not.toContain("publish");
  const state = snapshot(cwd);
  expect(state.outcome?.stop?.kind).toBe("needs-decision");
  expect(state.outcome?.stop?.detail).toContain("rerun with --replay-interrupted");
  expect(state.outcome?.stop?.detail).not.toContain("operator selection");
});

// The third FAIL of L3. `--start-at` requeues the failed step as `pending`, so its
// status no longer says that its last pass failed, and `--skip` then settles it:
// a requeued step whose last attempt failed without the runner dying owes no
// decision, and the run passes. The relaunch still never adopts what the failed
// pass left, because the mark posted before that attempt is still beside it.

/** The partial output is still there, beside the mark of the attempt that failed. */
function expectMarkedPartial(cwd: string, content: string): void {
  expect(readArtifact(cwd, "impl.md")).toBe(content);
  expect(provenanceRecords(cwd)["impl.md.json"]?.inFlight).toMatchObject({ stepId: "implement" });
}

/** Steps 3 to 5 of the repro: requeue, set aside (the run passes), relaunch (implement runs). */
function requeueSetAsideRelaunch(cwd: string, partial: string): void {
  expect(run(cwd, "--start-at", "plan", "--until", "plan").status).toBe(UNTIL_EXIT);
  expect(snapshot(cwd).steps.find((step) => step.id === "implement")).toMatchObject({
    status: "pending",
    replay: true,
  });
  const beforeSkip = mark(cwd);

  const skipped = run(cwd, "--skip", "implement");

  expect(skipped.status).toBe(0);
  const passed = snapshot(cwd);
  expect(passed.status).toBe("PASS");
  expect(statusesOf(passed).implement).toBe("skipped");
  expect(reasons(cwd, beforeSkip)).toContainEqual({ stepId: "implement", reason: SELECTION });
  expect(skipped.stderr).toContain("1 step set aside by operator selection: implement");
  expectMarkedPartial(cwd, partial);
  const passedRun = latestRunId(cwd);
  const before = mark(cwd);

  const relaunch = run(cwd);

  expect(relaunch.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(passedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual([
    "context",
    "prepare",
    "implement",
    "quality",
    "commit",
    "publish",
    "report",
  ]);
  expect(skipsSince(cwd, before).filter(({ stepId }) => stepId === "implement")).toEqual([]);
  expect(eventsSince(cwd, before, "step.outputs.unfinished")).toEqual([
    expect.objectContaining({ stepId: "implement", outputs: ["impl.md"] }),
  ]);
  expect(readArtifact(cwd, "impl.md")).toStartWith("implement ");
}

test("third FAIL: a step whose attempt wrote then failed, requeued by --start-at and set aside, is never adopted by the next run", () => {
  const cwd = scratchRoute(reconcile);
  partialAt(cwd, "implement");
  expect(run(cwd).status).toBe(1);
  expectMarkedPartial(cwd, "partial implement\n");
  heal(cwd, "implement");

  requeueSetAsideRelaunch(cwd, "partial implement\n");
});

// The repro as the third FAIL wrote it: the attempt failed before writing, and the
// partial file appears afterwards. It lies beside the mark of that attempt, which
// says nothing succeeded since, so it is unfinished too, whoever wrote it. Keeping
// such a file means deleting its record (W11 in inflight.test.ts).
test("third FAIL: a file written by hand after a failed attempt, requeued and set aside, is never adopted either", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  expect(run(cwd).status).toBe(1);
  writePartialArtifact(cwd, "impl.md");
  heal(cwd, "implement");

  requeueSetAsideRelaunch(cwd, "partial\n");
});

test("third FAIL: an attempt the operator interrupted after a partial write, requeued and set aside, is never adopted", async () => {
  const cwd = scratchRoute(reconcile);
  partialAt(cwd, "implement");
  await interruptDuring(cwd, "implement");
  const aborted = snapshot(cwd);
  expect(aborted.status).toBe("ABORTED");
  expect(statusesOf(aborted).implement).toBe("aborted");
  expectMarkedPartial(cwd, "partial implement\n");
  heal(cwd, "implement");

  requeueSetAsideRelaunch(cwd, "partial implement\n");
});

// The second FAIL's variant: a requeued step whose last attempt the runner died
// in keeps `pending` when set aside, and the interruption still needs authorizing.
test("a requeued step killed mid-pass and left out by --skip still needs the replay authorized", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");
  const killedRun = latestRunId(cwd);
  expect(run(cwd, "--start-at", "implement", "--until", "implement").status).toBe(UNTIL_EXIT);
  expect(snapshot(cwd).steps.find((step) => step.id === "publish")).toMatchObject({ status: "pending", replay: true });
  const beforeSkip = mark(cwd);

  const skipped = run(cwd, "--skip", "publish");

  expect(skipped.status).toBe(0);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(traceSince(cwd, beforeSkip)).toEqual(["context", "prepare", "quality", "commit", "report"]);
  const stopped = snapshot(cwd);
  expect(stopped.status).toBe("STOPPED");
  expect(stopped.outcome?.stop?.kind).toBe("needs-decision");
  expect(stopped.outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(statusesOf(stopped).publish).toBe("pending");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(snapshot(cwd).outcome?.stop?.kind).toBe("needs-decision");
  expect(traceSince(cwd, before)).not.toContain("publish");
  expect(resumed.stderr + resumed.stdout).not.toContain("replaying after an interrupted attempt");
  const beforeReplay = mark(cwd);

  expect(run(cwd, "--replay-interrupted").status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, beforeReplay)).toContain("publish");
});

// A pass the runner died in stays `running` once set aside, while later steps
// run: a signal during one of those must abort that one, not the dead pass.
test("an interruption during a later step aborts that step, not the killed pass the selection left running", async () => {
  const cwd = scratchRoute(reconcile);
  await killDuring(cwd, "publish");

  await interruptDuring(cwd, "report", "--skip", "publish");

  const aborted = snapshot(cwd);
  expect(aborted.status).toBe("ABORTED");
  expect(aborted.outcome?.phase).toBe("report");
  expect(statusesOf(aborted)).toMatchObject({ publish: "running", report: "aborted" });
  const before = mark(cwd);

  run(cwd);

  // publish's interruption still asks for an authorization, before report replays.
  expect(snapshot(cwd).outcome?.reason).toContain("--replay-interrupted");
  expect(traceSince(cwd, before)).not.toContain("publish");
});

/** An action step tracing its id (with `extra` options), that hangs while `hang-<id>` exists (`killDuring`). */
const TRACED_STEP = `const step = (id: string, extra: object = {}) =>
  actionStep({
    id,
    name: id,
    describe: id,
    rerunOnResume: true,
    ...extra,
    run: async (ctx: any) => {
      appendFileSync(join(ctx.cwd, "trace.log"), id + "\\n");
      if (existsSync(join(ctx.cwd, "hang-" + id))) await new Promise(() => setInterval(() => {}, 1_000));
    },
  });`;

const IMPORTS = `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";`;

/** `route` composing `child` through the node `sub`; both reconcile. */
const NODE_PIPELINES = {
  "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep, runPipeline }: any) => {
  ${TRACED_STEP}
  return pipeline("route").reconcile()
    .add(step("context"), runPipeline({ id: "sub", name: "sub", pipeline: "./child.ts" }), step("report"))
    .build();
};
`,
  "child.ts": `${IMPORTS}
export default ({ pipeline, actionStep }: any) => {
  ${TRACED_STEP}
  return pipeline("child").reconcile().add(step("inner")).build();
};
`,
};

// An orchestration node has no attempt of its own, so nothing in the snapshot
// tells a node killed mid-child from one that runs: only the process knows which
// step it put in `running`.
test("an interruption during a later step aborts that step, not the orchestration node killed mid-child and set aside", async () => {
  const cwd = scratchRoute(reconcile);
  writePipelines(cwd, NODE_PIPELINES);
  await killDuring(cwd, "inner");
  expect(statusesOf(snapshot(cwd)).sub).toBe("running");

  await interruptDuring(cwd, "report", "--skip", "sub");

  const aborted = snapshot(cwd);
  expect(aborted.status).toBe("ABORTED");
  expect(aborted.outcome?.phase).toBe("report");
  expect(aborted.outcome?.logPath).toContain("report");
  expect(statusesOf(aborted)).toMatchObject({ sub: "running", report: "aborted" });
});

/** `NODE_PIPELINES` whose node `sub` declares `rerunOnResume`, in reconcile mode or the default one. */
function rerunNodePipelines(mode: "reconcile" | "default"): Record<string, string> {
  return {
    ...NODE_PIPELINES,
    "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep, runPipeline }: any) => {
  ${TRACED_STEP}
  const sub = runPipeline({ id: "sub", name: "sub", pipeline: "./child.ts" }).rerunOnResume();
  return pipeline("route")${mode === "reconcile" ? ".reconcile()" : ""}.add(step("context"), sub, step("report")).build();
};
`,
  };
}

/** Kills `route` during `report`, after `sub` settled, then resumes it: the statuses `sub` went through on that resume, and its header. */
async function resumeAfterSettledNode(cwd: string): Promise<{ sub: unknown[]; header: string }> {
  await killDuring(cwd, "report");
  expect(statusesOf(snapshot(cwd))).toMatchObject({ sub: "done", report: "running" });
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  const sub = eventsSince(cwd, before, "step.status.changed")
    .filter((event) => event.stepId === "sub")
    .map((event) => event.status);
  return { sub, header: resumed.stdout + resumed.stderr };
}

// D3: rerunOnResume does not take an orchestration node's status from it in
// reconcile mode. The default mode keeps re-admitting it, as it always has.
test("reconcile: a settled orchestration node declaring rerunOnResume is not re-admitted on resume", async () => {
  const cwd = scratchRoute(reconcile);
  writePipelines(cwd, rerunNodePipelines("reconcile"));

  const { sub, header } = await resumeAfterSettledNode(cwd);

  expect(sub).toEqual([]);
  expect(header).toContain("Resumed — already done: sub\n");
  expect(header).not.toMatch(/Re-run on resume: .*sub/);
});

test("default mode: a settled orchestration node declaring rerunOnResume is re-admitted on resume", async () => {
  const cwd = scratchRoute();
  writePipelines(cwd, rerunNodePipelines("default"));

  const { sub, header } = await resumeAfterSettledNode(cwd);

  expect(sub).toEqual(["running", "done"]);
  expect(header).toContain("Re-run on resume: context, sub\n");
});

/** Legacy `route`: `gate` admits itself through a `when` that traces
 *  `gate-when` and hangs while `hang-gate-when` exists, before `work`, the one
 *  step whose interrupted pass needs an authorization to replay. */
const GATED_PIPELINE = {
  "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep }: any) => {
  ${TRACED_STEP}
  const when = async (ctx: any) => {
    appendFileSync(join(ctx.cwd, "trace.log"), "gate-when\\n");
    if (existsSync(join(ctx.cwd, "hang-gate-when"))) await new Promise(() => setInterval(() => {}, 1_000));
    return true;
  };
  return pipeline("route").add(step("gate", { when }), step("work", { rerunOnResume: false }), step("report")).build();
};
`,
};

// Legacy change: a signal landing while no step executes, here during an
// admission, used to mark the first `running` step `aborted`. That step was a
// pass the runner had died in, and its replay then went through unauthorized.
test("legacy: a signal during an admission does not abort the pass a dead runner left running", async () => {
  const cwd = scratchRoute();
  writePipelines(cwd, GATED_PIPELINE);
  await killDuring(cwd, "work");
  const killedRun = latestRunId(cwd);

  await interruptDuring(cwd, "gate-when");

  const aborted = snapshot(cwd);
  expect(latestRunId(cwd)).toBe(killedRun);
  expect(aborted.status).toBe("ABORTED");
  expect(statusesOf(aborted)).toMatchObject({ gate: "done", work: "running", report: "pending" });
  // Nothing executed, so the outcome points at no step and no log.
  expect(aborted.outcome?.phase).toBeNull();
  expect(aborted.outcome?.logPath).toBeNull();
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(snapshot(cwd).outcome?.stop?.kind).toBe("needs-decision");
  expect(snapshot(cwd).outcome?.stop?.detail).toContain("--replay-interrupted");
  expect(traceSince(cwd, before)).not.toContain("work");
  expect(resumed.stderr + resumed.stdout).not.toContain("replaying after an interrupted attempt");
});

// K3: legacy mode keeps the persisted exclusion (S4), on the resume too, and its
// report says nothing about a selection that is not ephemeral.
test("K3: legacy --skip persists the exclusion, which the next invocation of the run still obeys", () => {
  const cwd = scratchRoute();

  const bounded = run(cwd, "--skip", "prepare", "--until", "implement");

  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(trace(cwd)).toEqual(UP_TO_IMPLEMENT);
  expect(snapshot(cwd).steps.find((step) => step.id === "prepare")).toMatchObject({
    status: "skipped",
    excluded: true,
  });
  expect(reasons(cwd, WHOLE_RUN)).toEqual([]);
  expect(bounded.stderr).not.toContain("set aside");
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(["context", "quality", "commit", "publish", "report"]);
  expect(
    snapshot(cwd)
      .steps.filter((step) => step.excluded)
      .map((step) => step.id),
  ).toEqual(["prepare"]);
});
