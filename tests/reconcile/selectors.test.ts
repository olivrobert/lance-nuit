// Selectors, rows K1 and K2 of the reconciliation matrix. `--steps`, `--skip`
// and `--start-at` set steps aside for one invocation: nothing is persisted as an
// exclusion, the journal says why each step was left out, and the next
// invocation reconciles them like any other step.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  type RunSnapshot,
  removeArtifact,
  run,
  runRaw,
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
const UP_TO_DATE = "up to date";

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

/** Marks step `id` of the `latest` run as an older runner persisted an operator exclusion. */
function persistLegacyExclusion(cwd: string, id: string): void {
  const path = join(cwd, ".lance-nuit", "work-items", TICKET, "runs", PIPELINE, latestRunId(cwd), "state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as RunSnapshot;
  const step = state.steps.find((candidate) => candidate.id === id)!;
  Object.assign(step, { status: "skipped", excluded: true });
  writeFileSync(path, JSON.stringify(state));
}

test("K1: --skip on a first run sets the step aside for that run only, and the next run reconciles it", () => {
  const cwd = scratchRoute();
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
    { stepId: "branch", reason: UP_TO_DATE },
    ...upToDate("triage", "plan", "implement", "commit", "publish"),
  ]);
  expect(rerun.stderr).not.toContain("set aside");
});

test("K1: a step set aside on a run left unfinished is re-admitted by the next invocation of that run", () => {
  const cwd = scratchRoute();

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
    { stepId: "branch", reason: UP_TO_DATE },
    ...upToDate("triage", "plan", "implement"),
  ]);
  expectNoExclusion(snapshot(cwd));
});

test("K1: an exclusion an older runner persisted no longer binds", () => {
  const cwd = scratchRoute();
  expect(run(cwd, "--until", "implement").status).toBe(UNTIL_EXIT);
  persistLegacyExclusion(cwd, "prepare");
  const stoppedRun = latestRunId(cwd);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(stoppedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(AFTER_IMPLEMENT);
  expectNoExclusion(snapshot(cwd));
});

test("K2: --steps after a PASS admits only the named step, which a fresh deliverable skips", () => {
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
    { stepId: "branch", reason: UP_TO_DATE },
    ...upToDate("triage", "plan", "implement"),
  ]);
});

test("K2: on a resumed run, --steps sets aside settled steps too, keeping their status", () => {
  const cwd = scratchRoute();
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

test("--start-at on a first run is refused: there is no run to fork, and nothing is created", () => {
  const cwd = scratchRoute();

  const started = run(cwd, "--start-at", "implement");

  expect(started.status).toBe(1);
  expect(started.stderr).toContain("has no run to fork");
  expect(existsSync(join(cwd, ".lance-nuit", "work-items", TICKET, "runs"))).toBe(false);
});

test("--skip under --scan sets the step aside in every ticket's run, and a later scan reconciles it", () => {
  const tickets = ["T-1", "T-2"];
  const cwd = scratchRoute({ scan: tickets });

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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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
  const cwd = scratchRoute();
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

// A pass the runner died in stays `running` once set aside, while later steps
// run: a signal during one of those must abort that one, not the dead pass.
test("an interruption during a later step aborts that step, not the killed pass the selection left running", async () => {
  const cwd = scratchRoute();
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
      for (const out of (extra as any).output ?? []) await out.write(ctx, id + "\\n");
    },
  });`;

const IMPORTS = `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";`;

/** `route` composing `child` through the node `sub`. */
const NODE_PIPELINES = {
  "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep, runPipeline }: any) => {
  ${TRACED_STEP}
  return pipeline("route")
    .add(step("context"), runPipeline({ id: "sub", name: "sub", pipeline: "./child.ts" }), step("report"))
    .build();
};
`,
  "child.ts": `${IMPORTS}
export default ({ pipeline, actionStep }: any) => {
  ${TRACED_STEP}
  return pipeline("child").add(step("inner")).build();
};
`,
};

// An orchestration node has no attempt of its own, so nothing in the snapshot
// tells a node killed mid-child from one that runs: only the process knows which
// step it put in `running`.
test("an interruption during a later step aborts that step, not the orchestration node killed mid-child and set aside", async () => {
  const cwd = scratchRoute();
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

/** `NODE_PIPELINES` whose node `sub` declares `rerunOnResume`. */
function rerunNodePipelines(): Record<string, string> {
  return {
    ...NODE_PIPELINES,
    "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep, runPipeline }: any) => {
  ${TRACED_STEP}
  const sub = runPipeline({ id: "sub", name: "sub", pipeline: "./child.ts" }).rerunOnResume();
  return pipeline("route").add(step("context"), sub, step("report")).build();
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

// D3: rerunOnResume does not take an orchestration node's status from it.
test("a settled orchestration node declaring rerunOnResume is not re-admitted on resume", async () => {
  const cwd = scratchRoute();
  writePipelines(cwd, rerunNodePipelines());

  const { sub, header } = await resumeAfterSettledNode(cwd);

  expect(sub).toEqual([]);
  expect(header).toContain("Resumed — already done: sub\n");
  expect(header).not.toMatch(/Re-run on resume: .*sub/);
});

/** `route` where `gate` admits itself through a `when` that traces
 *  `gate-when` and hangs while `hang-gate-when` exists, before `work`, the one
 *  step whose interrupted pass needs an authorization to replay. */
const GATED_PIPELINE = {
  "route.ts": `${IMPORTS}
export default ({ pipeline, actionStep, textArtifact }: any) => {
  ${TRACED_STEP}
  const worked = textArtifact("work.txt");
  const when = async (ctx: any) => {
    appendFileSync(join(ctx.cwd, "trace.log"), "gate-when\\n");
    if (existsSync(join(ctx.cwd, "hang-gate-when"))) await new Promise(() => setInterval(() => {}, 1_000));
    return true;
  };
  return pipeline("route").add(step("gate", { when }), step("work", { rerunOnResume: false, output: [worked] }), step("report")).build();
};
`,
};

// A signal landing while no step executes, here during an admission, used to
// mark the first `running` step `aborted`. That step was a pass the runner had
// died in, and its replay then went through unauthorized.
test("a signal during an admission does not abort the pass a dead runner left running", async () => {
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
