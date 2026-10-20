import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../pipeline/context.js";
import { appendRunEvent, readRunEvents } from "../run-record/run-journal.js";
import { type LoadOrCreateRunOptions, loadOrCreateRun } from "./resume.js";
import { pendingSteps, resumeDecision } from "../run-record/run-predicates.js";
import { saveRun } from "../run-record/run-repository.js";
import { readRunSnapshot } from "../run-record/run-snapshot.js";
import { abortRun, finalizeRun, stopRun, updateStep } from "../run-record/run-transitions.js";
import { allocateAttempt } from "../run-record/attempt-lifecycle.js";
import { controlForRun } from "../run-record/cost-accounting.js";
import { resolveRunDir } from "../run-record/stores/run-storage.js";
import { FileRunStateStore } from "../run-record/stores/file-run-state-store.js";
import { selectExplicitRun } from "../run-record/run-selection.js";
import { commandRegistries } from "../commands/registries.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { executeRunSteps, type StepLoopDeps } from "../step/step-loop.js";
import { writable } from "../run-record/run.js";

function pipelineFile(root: string): string {
  const path = join(root, "p.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c" }))
  .build();`,
  );
  return path;
}

test("resume: a selected snapshot disappearing before the final read does not initialize a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-selection-race-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-race" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-race", undefined, true, ctx);
  const { run: initial } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-race",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(initial, initial.steps[0]!, "failed", "interrupted");
  unlinkSync(join(dir, "runner.lock"));

  const file = new FileRunStateStore({ context: ctx, ticket: "T-race", pipeline: "p" });
  const stateStore = {
    load: file.load.bind(file),
    loadLatest: file.loadLatest.bind(file),
    save: file.save.bind(file),
    resolveRunDirSelection: (...args: Parameters<FileRunStateStore["resolveRunDirSelection"]>) => {
      const selected = file.resolveRunDirSelection(...args);
      if (selected.selectedSnapshot) unlinkSync(join(selected.dir, "state.json"));
      return selected;
    },
  };

  await expect(
    loadOrCreateRun({ pipelinePath: path, ticket: "T-race", fresh: false, context: ctx, stateStore, worktree: false }),
  ).rejects.toThrow(/is missing/);
  expect(existsSync(join(dir, "state.json"))).toBe(false);
  expect(existsSync(join(dir, "runner.lock"))).toBe(false);
});

test("resume: an explicit selection whose directory disappears does not recreate it or repoint latest", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-explicit-selection-race-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-explicit" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-explicit", undefined, true, ctx);
  const { run: initial } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-explicit",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(initial, initial.steps[0]!, "failed", "interrupted");
  if (!initial.runId) throw new Error("fixture run must have an id");
  const runId = initial.runId;
  const selection = selectExplicitRun("p", "T-explicit", runId, ctx);
  rmSync(dir, { recursive: true, force: true });

  await expect(
    loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-explicit",
      runDir: selection.dir,
      fresh: false,
      context: ctx,
      strictSnapshot: selection.strictSnapshot,
      worktree: false,
    }),
  ).rejects.toThrow(/is missing/);
  expect(existsSync(dir)).toBe(false);
  expect(readlinkSync(join(root, ".lance-nuit", "work-items", "T-explicit", "runs", "p", "latest"))).toBe(runId);
});

test("resume: a guard stop is kept until --budget approves more spend", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-budget-stop-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-3" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-3", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-3",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  run.budget_exceeded = true;
  updateStep(run, run.steps[0]!, "failed", "process killed: budget exceeded");
  expect(readRunSnapshot(join(dir, "state.json"))?.budget_exceeded).toBe(true);

  // A plain resume inherits the stop: the ledger may read the ceiling as free room.
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-3",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.budget_exceeded).toBe(true);

  // `--budget` is the human decision that lifts it.
  const { run: approved } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-3",
    runDir: dir,
    fresh: false,
    context: ctx,
    maxCostUsd: 5,
    worktree: false,
  });
  expect(approved.budget_exceeded).toBeUndefined();
  expect(approved.max_cost_usd).toBe(5);
});

test("resume: SIGINT after the last step but before finalizeRun keeps the same run", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-abort-settled-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-1" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-1", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-1",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  for (const step of run.steps) updateStep(run, step, "done");
  abortRun(run, "SIGINT");

  const snapshot = readRunSnapshot(join(dir, "state.json"))!;
  expect(snapshot.status).toBe("ABORTED");
  expect(pendingSteps(snapshot)).toHaveLength(0);

  // Every step is settled but no verdict was ever stamped: the run owes a
  // finalizeRun. Discarding it would replay — and repay — the whole pipeline in
  // a brand new directory, with no warning (nothing remains to report).
  expect(resumeDecision(snapshot)).toEqual({ resume: true });
  expect(resolveRunDir("p", "T-1", undefined, false, ctx)).toBe(dir);

  // Hydrated as a live run, so the next invocation can finalize it. Loaded as
  // terminal, a child run in this state fails its parent on every resume.
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-1",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.status).toBe("RUNNING");
  expect(resumed.aborted).toBe(false);
});

for (const ending of ["STOPPED", "FAIL"] as const) {
  test(`resume: --skip of the step a ${ending} run ended on settles it with a new verdict`, async () => {
    const root = mkdtempSync(join(tmpdir(), "resume-skip-last-"));
    const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-5" });
    const path = pipelineFile(root);
    const dir = resolveRunDir("p", "T-5", undefined, true, ctx);
    const run = writable(
      (
        await loadOrCreateRun({
          pipelinePath: path,
          ticket: "T-5",
          runDir: dir,
          fresh: false,
          context: ctx,
          worktree: false,
        })
      ).run,
    );
    updateStep(run, run.steps[0]!, "done");
    updateStep(run, run.steps[1]!, "done");
    if (ending === "STOPPED") {
      updateStep(run, run.steps[2]!, "failed", "blocked: no credentials");
      stopRun(run, run.steps[2]!, "blocked: no credentials");
      finalizeRun(run, { stopped: true });
    } else {
      run.budget_exceeded = true;
      updateStep(run, run.steps[2]!, "failed", "process killed: budget exceeded");
      finalizeRun(run, { failed: true, budgetExceeded: true });
    }
    expect(readRunSnapshot(join(dir, "state.json"))!.status).toBe(ending);

    // Skipping the last step left settles every step, but the verdict on disk
    // judged the work the selection just took out: the run is live again.
    const { run: resumed } = await loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-5",
      skipFilter: ["c"],
      fresh: false,
      context: ctx,
      worktree: false,
    });
    expect(resumed.run_dir).toBe(dir);
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.stopped_reason).toBeUndefined();

    const { deps, spawned } = countingDeps([]);
    finalizeRun(resumed, await executeRunSteps(resumed, "T-5", undefined, { resuming: true }, deps, ctx));
    expect(spawned).toEqual([]);
    expect(readRunSnapshot(join(dir, "state.json"))!.status).toBe("PASS");
  });
}

test("a run records where it executes, so a reader finds its artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-location-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-4" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-4", undefined, true, ctx);

  await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-4",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const created = readRunSnapshot(join(dir, "state.json"))!;
  expect(created.cwd).toBe(root);
  expect(created.worktree).toBe(false);

  // A worktree run reads and writes in the copy it was moved into, not in the
  // main clone: without both facts a reader looks for decisions in the wrong tree.
  const worktree = mkdtempSync(join(tmpdir(), "run-location-wt-"));
  const worktreeCtx = buildPipelineContext({ ...commandRegistries(), cwd: worktree, ticket: "T-4" });
  await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-4",
    runDir: dir,
    fresh: false,
    context: worktreeCtx,
    worktree: true,
  });
  const resumed = readRunSnapshot(join(dir, "state.json"))!;
  expect(resumed.cwd).toBe(worktree);
  expect(resumed.worktree).toBe(true);
});

test("a caller must say whether the run it opens is in a worktree", () => {
  // Checked by tsc: the option used to default to false, so a caller that forgot
  // it recorded a worktree run as one in the main clone.
  // @ts-expect-error worktree is required
  const missing: LoadOrCreateRunOptions = { pipelinePath: "p.ts" };
  const given: LoadOrCreateRunOptions = { pipelinePath: "p.ts", worktree: false };
  expect(missing.worktree).toBeUndefined();
  expect(given.worktree).toBe(false);
});

test("resume selectors apply to an aborted step, not only to pending ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-selectors-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-2" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-2", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-2",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "done");
  updateStep(run, run.steps[1]!, "running");
  abortRun(run, "SIGINT");
  expect(readRunSnapshot(join(dir, "state.json"))!.steps[1]!.status).toBe("aborted");

  // An aborted step is replayed on resume, so it still holds executable work: a
  // selector that excludes it must take it out, or `--step c` runs `b` anyway.
  const { run: onlyC } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-2",
    stepFilter: ["c"],
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(onlyC.steps[1]!.status).toBe("skipped");

  const { run: skipB } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-2",
    skipFilter: ["b"],
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(skipB.steps[1]!.status).toBe("skipped");
});

test("resume selectors leave a step the journal finished as done, even when the snapshot still calls it running", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-selectors-journal-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-journal" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-journal", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-journal",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "done");
  updateStep(run, run.steps[1]!, "running");
  // A hard death between `updateStep`'s journal append and its snapshot write.
  appendRunEvent(run, "step.status.changed", { stepId: "b", status: "done" });
  expect(readRunSnapshot(join(dir, "state.json"))!.steps[1]!.status).toBe("running");

  for (const [stepFilter, skipFilter] of [
    [undefined, ["b"]],
    [["c"], undefined],
  ] as const) {
    const { run: resumed } = await loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-journal",
      stepFilter: stepFilter?.slice(),
      skipFilter: skipFilter?.slice(),
      runDir: dir,
      fresh: false,
      context: ctx,
      worktree: false,
    });
    expect(resumed.steps[1]!.status).toBe("done");
    expect(resumed.steps[1]!.excluded).toBeUndefined();
  }
});

test("resume: an attempt priced in the journal but missing from the snapshot still counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-journal-cost-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-4" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-4", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-4",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "running");
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  // `finishAttempt` appends the finish event, then writes the snapshot. Die in between.
  appendRunEvent(run, "step.attempt.finished", {
    stepId: "a",
    attempt: 1,
    kind: "step",
    status: "done",
    control: { duration_ms: 1, total_cost_usd: 1 },
    usage: { input_tokens: 10 },
    logPath: "steps/a/1.log",
  });

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-4",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.steps[0]!.attempts?.[0]?.control?.total_cost_usd).toBe(1);
  // The budget ledger seeds from step totals: the journaled spend must reach them.
  expect(resumed.steps[0]!.control?.total_cost_usd).toBe(1);
  expect(resumed.steps[0]!.usage?.input_tokens).toBe(10);
  expect(controlForRun(resumed).total_cost_usd).toBe(1);
});

test("resume: the snapshot total wins when it already covers the journaled attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-snapshot-cost-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-5" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-5", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-5",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  appendRunEvent(run, "step.attempt.finished", {
    stepId: "a",
    attempt: 1,
    kind: "step",
    status: "done",
    control: { duration_ms: 1, total_cost_usd: 1 },
    logPath: "steps/a/1.log",
  });
  run.steps[0]!.control = { duration_ms: 5, total_cost_usd: 1.5, model: "m" };
  updateStep(run, run.steps[0]!, "done");

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-5",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.steps[0]!.control).toEqual({ duration_ms: 5, total_cost_usd: 1.5, model: "m" });
});

test("resume: a fix pass left running by a crash is closed as failed and unpriced, down to the step total", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-crashed-attempt-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-6",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  updateStep(run, run.steps[0]!, "running");
  // A priced step attempt, then a fix pass that never reported: the runner died.
  run.steps[0]!.control = { duration_ms: 5, total_cost_usd: 1, model: "m" };
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  appendRunEvent(run, "step.attempt.finished", {
    stepId: "a",
    attempt: 1,
    kind: "step",
    status: "failed",
    control: { duration_ms: 5, total_cost_usd: 1, model: "m" },
    logPath: "steps/a/1.log",
  });
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 2, kind: "fix", logPath: "steps/a/2.log" });
  saveRun(run);

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const step = resumed.steps[0]!;
  expect(step.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
  expect(step.attempts[1]).toMatchObject({
    kind: "fix",
    control: { cost_estimated: true, cost_unknown: true },
    errors: "runner died before the attempt reported its result (crash, OOM, or SIGKILL)",
  });
  expect(step.attempts[1]?.finished_at).toBeDefined();
  // The uncertainty reaches the step total that seeds the ledger; the priced part stays.
  expect(step.control).toMatchObject({ total_cost_usd: 1, model: "m", cost_unknown: true });

  // The decision is durable: the journal carries the finish with the flag.
  const finished = readRunEvents(dir).filter((event) => event.type === "step.attempt.finished" && event.attempt === 2);
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({
    stepId: "a",
    kind: "fix",
    status: "failed",
    control: { cost_unknown: true },
    logPath: "steps/a/2.log",
    reason: "runner died before the attempt reported its result (crash, OOM, or SIGKILL)",
  });

  // Settled once: a second resume finds nothing left running and writes no new finish.
  const { run: again } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(again.steps[0]!.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
  expect(readRunEvents(dir).filter((event) => event.type === "step.attempt.finished")).toHaveLength(2);
});

test("resume: an attempt left running by a crash is projected as interrupted on every later resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-interrupted-attempt-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6b" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6b", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-6b",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  updateStep(run, run.steps[0]!, "running");
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  saveRun(run);

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6b",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.steps[0]!.attempts[0]).toMatchObject({ status: "failed", interrupted: true });
  const finished = readRunEvents(dir).filter((event) => event.type === "step.attempt.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ stepId: "a", attempt: 1, interrupted: true });

  // Settlement wrote the marker once; the next resume reads it back from the journal.
  const { run: again } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6b",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(again.steps[0]!.attempts[0]).toMatchObject({ status: "failed", interrupted: true });
});

test("resume: an attempt the loop opened is read back and settled after a crash during its spawn", async () => {
  // The state the other crash tests fabricate, produced here by the loop itself:
  // what `openAttempt` persisted before spawn is all a killed runner leaves.
  const root = mkdtempSync(join(tmpdir(), "resume-crash-in-spawn-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6f" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6f", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6f",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const { deps } = countingDeps([]);
  const spawn = deps.executeStep;
  let onDisk: { state: string; events: string } | undefined;
  deps.executeStep = async (...args) => {
    if (args[0].id === "b") {
      onDisk = {
        state: readFileSync(join(dir, "state.json"), "utf8"),
        events: readFileSync(join(dir, "events.jsonl"), "utf8"),
      };
    }
    return spawn(...args);
  };
  await executeRunSteps(run, "T-6f", undefined, { resuming: false }, deps, ctx);
  if (!onDisk) throw new Error("step b never spawned");
  // The runner dies while b's process runs: the disk keeps what it held then.
  writeFileSync(join(dir, "state.json"), onDisk.state);
  writeFileSync(join(dir, "events.jsonl"), onDisk.events);

  const snapshot = readRunSnapshot(join(dir, "state.json"));
  expect(snapshot?.steps.map((step) => [step.id, step.status, step.last_attempt])).toEqual([
    ["a", "done", 1],
    ["b", "running", 1],
    ["c", "pending", undefined],
  ]);

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6f",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const b = resumed.steps[1]!;
  expect(b.attempts).toHaveLength(1);
  expect(b.attempts[0]).toMatchObject({
    attempt: 1,
    kind: "step",
    status: "failed",
    interrupted: true,
    errors: "runner died before the attempt reported its result (crash, OOM, or SIGKILL)",
  });
  expect(b.last_attempt).toBe(1);
  const finished = readRunEvents(dir).filter((event) => event.type === "step.attempt.finished" && event.stepId === "b");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ attempt: 1, status: "failed", interrupted: true });

  // Settled as an interrupted pass: the next execution asks before replaying it.
  const next = countingDeps([]);
  expect((await executeRunSteps(resumed, "T-6f", undefined, { resuming: true }, next.deps, ctx)).stopped).toBe(true);
  expect(next.spawned).toEqual([]);
});

/** Leave step `id` as a runner death leaves it: `running`, its attempt started
 *  and never finished. */
function crashDuring(opened: Awaited<ReturnType<typeof loadOrCreateRun>>["run"], id: string): void {
  const run = writable(opened);
  const step = run.steps.find((candidate) => candidate.id === id)!;
  updateStep(run, step, "running");
  const attempt = step.attempts.length + 1;
  appendRunEvent(run, "step.attempt.started", {
    stepId: id,
    attempt,
    kind: "step",
    logPath: `steps/${id}/${attempt}.log`,
  });
  saveRun(run);
}

test("resume: a step interrupted by a crash stops the run instead of replaying, until --replay-interrupted authorizes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-interrupted-stop-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6c" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6c", undefined, true, ctx);
  crashDuring(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-6c",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
    "a",
  );

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6c",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const first = countingDeps([]);
  const outcome = await executeRunSteps(resumed, "T-6c", undefined, { resuming: true }, first.deps, ctx);
  expect(outcome.stopped).toBe(true);
  expect(first.spawned).toEqual([]);
  const snapshot = readRunSnapshot(join(dir, "state.json"))!;
  expect(snapshot.status).toBe("STOPPED");
  expect(snapshot.outcome).toMatchObject({ phase: "a", resumable: true, stop: { kind: "needs-decision" } });
  expect(snapshot.outcome?.reason).toMatch(/\ba\b.*--replay-interrupted/s);

  // The stop wrote no attempt: the next plain resume asks again.
  const { run: again } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6c",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const second = countingDeps([]);
  expect((await executeRunSteps(again, "T-6c", undefined, { resuming: true }, second.deps, ctx)).stopped).toBe(true);
  expect(second.spawned).toEqual([]);

  const { run: authorized } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6c",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const third = countingDeps([]);
  const replayed = await executeRunSteps(
    authorized,
    "T-6c",
    undefined,
    { resuming: true, replayInterrupted: true },
    third.deps,
    ctx,
  );
  expect(replayed.stopped).toBe(false);
  expect(third.spawned).toEqual(["a", "b", "c"]);
  expect(authorized.steps[0]!.status).toBe("done");
});

for (const option of ["replayInterrupted", "rerunOnResume"]) {
  test(`resume: a step declaring ${option} is replayed after a crash without asking`, async () => {
    const root = mkdtempSync(join(tmpdir(), "resume-interrupted-declared-"));
    const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6d" });
    const path = join(root, "declared.ts");
    writeFileSync(
      path,
      `export default ({ pipeline, actionStep }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", ${option}: true }))
  .build();`,
    );
    const dir = resolveRunDir("p", "T-6d", undefined, true, ctx);
    crashDuring(
      (
        await loadOrCreateRun({
          pipelinePath: path,
          ticket: "T-6d",
          runDir: dir,
          fresh: false,
          context: ctx,
          worktree: false,
        })
      ).run,
      "a",
    );

    const { run: resumed } = await loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-6d",
      runDir: dir,
      fresh: false,
      context: ctx,
      worktree: false,
    });
    const loop = countingDeps([]);
    const outcome = await executeRunSteps(resumed, "T-6d", undefined, { resuming: true }, loop.deps, ctx);
    expect(outcome.stopped).toBe(false);
    expect(loop.spawned).toEqual(["a"]);
    expect(resumed.steps[0]!.status).toBe("done");
  });
}

test("resume: a --start-at replay interrupted by a second crash stops the next resume that does not name it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-interrupted-start-at-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6e" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6e", undefined, true, ctx);
  const initial = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-6e",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  for (const step of initial.steps) updateStep(initial, step, "done");
  saveRun(initial);

  crashDuring(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-6e",
        runDir: dir,
        fresh: false,
        startAt: "b",
        context: ctx,
        worktree: false,
      })
    ).run,
    "b",
  );

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6e",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  // The persisted requeue outlives the invocation that asked for it.
  expect(resumed.steps[1]!.replay).toBe(true);
  const loop = countingDeps([]);
  const outcome = await executeRunSteps(resumed, "T-6e", undefined, { resuming: true }, loop.deps, ctx);
  expect(outcome.stopped).toBe(true);
  expect(loop.spawned).toEqual([]);
});

/** Same three steps, under a `.maxCost()` ceiling declared by the pipeline
 *  itself rather than approved on the command line. */
/** The same three-step pipeline with or without a declared ceiling: `usd`
 *  omitted writes no `.maxCost()` at all, which is how a run reaches the
 *  "uncapped when it spent, capped on the next invocation" case. */
function budgetedPipelineFile(root: string, usd?: number): string {
  const path = join(root, "budgeted.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep }) => pipeline("p")
  ${usd === undefined ? "" : `.maxCost(${usd})`}
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c" }))
  .build();`,
  );
  return path;
}

/** Loop dependencies whose spawn is programmable and counted. */
function countingDeps(results: Array<Partial<Awaited<ReturnType<StepLoopDeps["executeStep"]>>>>): {
  deps: StepLoopDeps;
  spawned: string[];
} {
  const spawned: string[] = [];
  let index = 0;
  return {
    spawned,
    deps: {
      executeStep: async (step) => {
        spawned.push(step.id);
        const result = results[index++] ?? { ok: true };
        return { output: "", ok: true, stats: { duration_ms: 1 }, ...result };
      },
      extractErrors: async () => ({ hasErrors: false, errors: "" }),
      runFixLoop: async () => ({ failed: false }),
      output: NULL_RUN_OUTPUT,
    },
  };
}

test("resume: a mid-step .maxCost() kill stops the run, and its cost is read back on the next invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-maxcost-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-8" });
  const path = budgetedPipelineFile(root, 1);
  const dir = resolveRunDir("p", "T-8", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-8",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(run.max_cost_usd).toBe(1);

  // The live guard killed step `a` mid-flight on an estimate above the ceiling.
  // The figure the backend settled on afterwards ($0.90) lands under it, so the
  // ledger alone would read the ceiling as affordable.
  const first = countingDeps([
    {
      ok: false,
      budgetExceeded: true,
      failReason: "process killed: budget exceeded ($1.20 estimated > $1.00 remaining)",
      stats: { duration_ms: 1, total_cost_usd: 0.9, cost_estimated: true },
    },
  ]);
  const outcome = await executeRunSteps(run, "T-8", undefined, { resuming: false }, first.deps, ctx);

  // A hard stop: nothing after the killed step was launched.
  expect(outcome.budgetExceeded).toBe(true);
  expect(first.spawned).toEqual(["a"]);
  expect(run.steps.map((step) => step.status)).toEqual(["failed", "pending", "pending"]);

  const snapshot = readRunSnapshot(join(dir, "state.json"))!;
  expect(snapshot.budget_exceeded).toBe(true);
  expect(snapshot.max_cost_usd).toBe(1);
  expect(snapshot.steps[0]?.control?.total_cost_usd).toBe(0.9);

  // The next invocation reads the spend back rather than restarting from zero,
  // and keeps the stop: without the flag the $0.90 ledger would fund a replay of
  // the very step the guard killed.
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-8",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.max_cost_usd).toBe(1);
  expect(resumed.budget_exceeded).toBe(true);
  expect(controlForRun(resumed).total_cost_usd).toBe(0.9);

  const second = countingDeps([{ ok: true }, { ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, "T-8", undefined, { resuming: true }, second.deps, ctx);
  expect(again.budgetExceeded).toBe(true);
  expect(second.spawned).toEqual([]);
  expect(again.cumulativeCost).toBe(0.9);
}, 20_000);

test("resume: an accounting stop resists a plain resume and --budget, and only --allow-unmetered lifts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-9" });
  const path = budgetedPipelineFile(root, 5);
  const dir = resolveRunDir("p", "T-9", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });

  // Step `a` completes, spends $1 the runner could price, and consumes tokens it
  // could not: the $5 ceiling is no longer enforceable against the remainder.
  const first = countingDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } }]);
  const outcome = await executeRunSteps(run, "T-9", undefined, { resuming: false }, first.deps, ctx);
  expect(outcome.costUnaccounted).toBe(true);
  expect(outcome.budgetExceeded).toBe(false);
  expect(first.spawned).toEqual(["a"]);
  expect(run.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);

  const stopped = readRunSnapshot(join(dir, "state.json"))!;
  expect(stopped.cost_unaccounted).toBe(true);
  expect(stopped.allow_unmetered).toBeUndefined();

  // A plain resume inherits the stop; missing authorization means strict.
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.cost_unaccounted).toBe(true);
  expect(resumed.allow_unmetered).toBeUndefined();
  const second = countingDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, "T-9", undefined, { resuming: true }, second.deps, ctx);
  expect(again.costUnaccounted).toBe(true);
  expect(second.spawned).toEqual([]);

  // `--budget` changes the amount only: a bigger ceiling is still a ceiling
  // nobody can enforce against the unpriced attempt.
  const { run: raised } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    maxCostUsd: 50,
    budgetApproved: true,
    worktree: false,
  });
  expect(raised.max_cost_usd).toBe(50);
  expect(raised.cost_unaccounted).toBe(true);
  expect(raised.allow_unmetered).toBeUndefined();
  const third = countingDeps([{ ok: true }, { ok: true }]);
  const withBudget = await executeRunSteps(raised, "T-9", undefined, { resuming: true }, third.deps, ctx);
  expect(withBudget.costUnaccounted).toBe(true);
  expect(third.spawned).toEqual([]);

  // `--allow-unmetered` is the authorization. It is persisted and journaled once.
  const { run: authorized } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    allowUnmetered: true,
    worktree: false,
  });
  expect(authorized.allow_unmetered).toBe(true);
  expect(readRunSnapshot(join(dir, "state.json"))?.allow_unmetered).toBe(true);
  // The authorization never launders the uncertainty: the latch stays set and the
  // totals stay a lower bound.
  expect(authorized.cost_unaccounted).toBe(true);
  expect(readRunEvents(dir).filter((event) => event.type === "run.unmetered.authorized")).toHaveLength(1);

  const fourth = countingDeps([{ ok: true }, { ok: true }]);
  const allowed = await executeRunSteps(authorized, "T-9", undefined, { resuming: true }, fourth.deps, ctx);
  expect(allowed.costUnaccounted).toBe(false);
  expect(allowed.failed).toBe(false);
  expect(fourth.spawned).toEqual(["b", "c"]);

  // A later resume of the same run inherits the authorization without the flag,
  // and does not journal it a second time.
  const { run: inherited } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(inherited.allow_unmetered).toBe(true);
  expect(readRunEvents(dir).filter((event) => event.type === "run.unmetered.authorized")).toHaveLength(1);
}, 30_000);

test("resume: --budget on a run that was uncapped when it spent unpriced tokens stops it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-late-cap-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-12" });
  const path = budgetedPipelineFile(root);
  const dir = resolveRunDir("p", "T-12", undefined, true, ctx);

  // No ceiling: the unpriced attempt is warned about, latched, and the run goes
  // on. There is nothing for the uncertainty to invalidate.
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-12",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(run.max_cost_usd).toBeUndefined();
  const first = countingDeps([
    { ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
    { ok: false, failReason: "step b failed" },
  ]);
  const outcome = await executeRunSteps(run, "T-12", undefined, { resuming: false }, first.deps, ctx);
  expect(outcome.costUnaccounted).toBe(false);
  expect(first.spawned).toEqual(["a", "b"]);
  expect(readRunSnapshot(join(dir, "state.json"))?.cost_unaccounted).toBe(true);

  // `--budget 10` introduces the ceiling the run never had. The latch describes
  // the SPEND, not the previous verdict, so it applies to the new ceiling at
  // once: the amount is enforceable against nothing. The operator who wants both
  // has to say so with `--allow-unmetered`; `--budget` authorizes nothing.
  const { run: capped } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-12",
    runDir: dir,
    fresh: false,
    context: ctx,
    maxCostUsd: 10,
    budgetApproved: true,
    worktree: false,
  });
  expect(capped.max_cost_usd).toBe(10);
  expect(capped.cost_unaccounted).toBe(true);
  const second = countingDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(capped, "T-12", undefined, { resuming: true }, second.deps, ctx);
  expect(again.costUnaccounted).toBe(true);
  expect(again.costUnaccountedStop).toBe(true);
  expect(second.spawned).toEqual([]);

  // And the way out is the authorization, alongside the ceiling it just gained.
  const { run: authorized } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-12",
    runDir: dir,
    fresh: false,
    context: ctx,
    allowUnmetered: true,
    worktree: false,
  });
  const third = countingDeps([{ ok: true }, { ok: true }]);
  const allowed = await executeRunSteps(authorized, "T-12", undefined, { resuming: true }, third.deps, ctx);
  expect(allowed.costUnaccounted).toBe(false);
  expect(third.spawned).toEqual(["b", "c"]);
}, 30_000);

test("resume: a fresh run inherits neither the authorization nor the accounting stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-fresh-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-10" });
  const path = budgetedPipelineFile(root, 5);
  const dir = resolveRunDir("p", "T-10", undefined, true, ctx);
  const { run: authorized } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-10",
    runDir: dir,
    fresh: false,
    context: ctx,
    allowUnmetered: true,
    worktree: false,
  });
  expect(authorized.allow_unmetered).toBe(true);
  const first = countingDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } }]);
  await executeRunSteps(authorized, "T-10", undefined, { resuming: false }, first.deps, ctx);
  expect(readRunSnapshot(join(dir, "state.json"))?.cost_unaccounted).toBe(true);

  // `--fresh` is a new run, not a continuation: it starts strict, with no spend
  // and no authorization to inherit from the run it replaces.
  const { run: fresh } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-10",
    fresh: true,
    context: ctx,
    worktree: false,
  });
  expect(fresh.run_dir).not.toBe(dir);
  expect(fresh.allow_unmetered).toBeUndefined();
  expect(fresh.cost_unaccounted).toBeUndefined();
}, 20_000);

test("resume: an authorized run still stops when the spend it could price reaches the ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-ceiling-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-11" });
  const path = budgetedPipelineFile(root, 1);
  const dir = resolveRunDir("p", "T-11", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-11",
    runDir: dir,
    fresh: false,
    context: ctx,
    allowUnmetered: true,
    worktree: false,
  });
  expect(run.allow_unmetered).toBe(true);

  // $2 of PRICED spend under a $1 ceiling, plus tokens nobody could price. The
  // authorization covers the unknown portion; the known lower bound does not
  // stop being a fact, so the run reports an exceeded budget, not an accounting
  // stop, and stops all the same.
  const deps = countingDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 2, cost_unknown: true } }]);
  const outcome = await executeRunSteps(run, "T-11", undefined, { resuming: false }, deps.deps, ctx);
  expect(outcome.budgetExceeded).toBe(true);
  expect(outcome.costUnaccounted).toBe(false);
  expect(deps.spawned).toEqual(["a"]);
  expect(run.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);
}, 20_000);

test("resume selectors apply to a step added to the definition after the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-new-step-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-new" });
  const step = (id: string) => `  .add(actionStep({ id: "${id}", name: "${id}", run: () => {}, describe: "${id}" }))`;
  // A distinct file per revision: the loader imports the module, and an import is
  // cached for the process.
  const definition = (file: string, ids: string[]) => {
    const path = join(root, file);
    writeFileSync(
      path,
      `export default ({ pipeline, actionStep }) => pipeline("p")\n${ids.map(step).join("\n")}\n  .build();`,
    );
    return path;
  };

  // Two snapshots taken while the definition holds a and b only.
  const before = definition("before.ts", ["a", "b"]);
  const selected = resolveRunDir("p", "T-new", undefined, true, ctx);
  await loadOrCreateRun({
    pipelinePath: before,
    ticket: "T-new",
    runDir: selected,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const skipped = resolveRunDir("p", "T-new", undefined, true, ctx);
  await loadOrCreateRun({
    pipelinePath: before,
    ticket: "T-new",
    runDir: skipped,
    fresh: false,
    context: ctx,
    worktree: false,
  });

  // A step added afterwards has no persisted state, so hydration would default it
  // to pending: it must still answer to the resume selectors.
  const after = definition("after.ts", ["a", "b", "deploy"]);

  const { run: onlyA } = await loadOrCreateRun({
    pipelinePath: after,
    ticket: "T-new",
    stepFilter: ["a"],
    runDir: selected,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const outsideSelection = onlyA.steps.find((entry) => entry.id === "deploy")!;
  expect(outsideSelection.status).toBe("skipped");
  expect(outsideSelection.excluded).toBe(true);

  const { run: withoutDeploy } = await loadOrCreateRun({
    pipelinePath: after,
    ticket: "T-new",
    skipFilter: ["deploy"],
    runDir: skipped,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const explicitlySkipped = withoutDeploy.steps.find((entry) => entry.id === "deploy")!;
  expect(explicitlySkipped.status).toBe("skipped");
  expect(explicitlySkipped.excluded).toBe(true);
});

test("--start-at leaves a done step before it to the resume re-check instead of excluding it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-done-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-start" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-start", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-start",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  updateStep(run, run.steps[0]!, "done");
  saveRun(run);

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-start",
    runDir: dir,
    fresh: false,
    startAt: "c",
    context: ctx,
    worktree: false,
  });
  const [a, b] = resumed.steps;
  // The step loop re-admits a `done` step declaring `input` (step-loop.test.ts):
  // an exclusion here would turn that freshness re-check off.
  expect(a!.status).toBe("done");
  expect(a!.excluded).toBeUndefined();
  expect(b!.status).toBe("skipped");
  expect(b!.excluded).toBe(true);
});

// Invariant: the journal owns the attempts. A resume that cannot read it must
// fail, not come back with zero attempts and a budget that forgot their price.
test("invariant: a resume over an unreadable journal fails instead of forgetting the attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-invariant-unreadable-journal-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-9" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-9", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-9",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "running");
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  appendRunEvent(run, "step.attempt.finished", {
    stepId: "a",
    attempt: 1,
    kind: "step",
    status: "done",
    control: { duration_ms: 1, total_cost_usd: 1 },
    logPath: "steps/a/1.log",
  });
  rmSync(join(dir, "events.jsonl"));
  mkdirSync(join(dir, "events.jsonl"));

  await expect(
    loadOrCreateRun({ pipelinePath: path, ticket: "T-9", runDir: dir, fresh: false, context: ctx, worktree: false }),
  ).rejects.toThrow(/EISDIR/);
  // The snapshot is untouched: restoring the journal makes the run resumable again.
  expect(readRunSnapshot(join(dir, "state.json"))?.steps[0]?.status).toBe("running");
});

// Authority of the run totals. `total_control` / `total_usage` are materialized by
// a finalization and describe that generation only: a terminal snapshot may hand
// them back, a live resume derives them from the steps.
test("resume: materialized totals are trusted on a terminal snapshot and derived on a live one", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-run-totals-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-totals" });
  const path = pipelineFile(root);

  // A PASS run: nothing left to execute, so the finalized totals are the record.
  const passDir = resolveRunDir("p", "T-totals", undefined, true, ctx);
  const passed = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-totals",
        runDir: passDir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  for (const step of passed.steps) {
    step.control = { duration_ms: 1, total_cost_usd: 1 };
    updateStep(passed, step, "done");
  }
  finalizeRun(passed);
  expect(readRunSnapshot(join(passDir, "state.json"))?.total_control?.total_cost_usd).toBe(3);
  const { run: terminal } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-totals",
    runDir: passDir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(terminal.status).toBe("PASS");
  expect(terminal.total_control?.total_cost_usd).toBe(3);

  // A run with work left: a total written by an earlier generation is dropped, and
  // the ledger seed reads the steps, which know of the spend that came after it.
  const liveDir = resolveRunDir("p", "T-totals", undefined, true, ctx);
  const live = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-totals",
        runDir: liveDir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  live.steps[0]!.control = { duration_ms: 1, total_cost_usd: 1 };
  updateStep(live, live.steps[0]!, "done");
  live.total_control = { duration_ms: 1, total_cost_usd: 0.25 };
  live.total_usage = { output_tokens: 1 };
  saveRun(live);
  expect(readRunSnapshot(join(liveDir, "state.json"))?.total_control?.total_cost_usd).toBe(0.25);
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-totals",
    runDir: liveDir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.status).toBe("RUNNING");
  expect(resumed.total_control).toBeUndefined();
  expect(resumed.total_usage).toBeUndefined();
  expect(controlForRun(resumed).total_cost_usd).toBe(1);
});

// Attempt identity when the journal lost the attempt. The snapshot's
// `last_attempt` is the numbering floor: an append that failed, or a journal
// rewritten without its head, must not let a resume reuse an existing number.
test("resume: a failed journal append keeps the attempt numbering through the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-append-failure-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-append" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-append", undefined, true, ctx);
  // A store that can be read but never written: every fact of this generation is lost.
  const journal: unknown[] = [];
  const eventStore = {
    append: () => {
      throw new Error("journal unavailable");
    },
    read: () => journal as never[],
  };
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-append",
        runDir: dir,
        fresh: false,
        context: ctx,
        eventStore,
        worktree: false,
      })
    ).run,
  );
  updateStep(run, run.steps[0]!, "running");
  const first = allocateAttempt(run, run.steps[0]!, "step").logPath;
  expect(first).toContain("attempt-001");
  run.steps[0]!.attempts[0]!.status = "failed";
  run.steps[0]!.control = { duration_ms: 1, total_cost_usd: 1 };
  updateStep(run, run.steps[0]!, "failed", "boom");
  expect(readRunSnapshot(join(dir, "state.json"))?.steps[0]?.last_attempt).toBe(1);

  const resumed = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-append",
        runDir: dir,
        fresh: false,
        context: ctx,
        eventStore,
        worktree: false,
      })
    ).run,
  );
  const step = resumed.steps[0]!;
  // The attempt itself is gone with the journal; its number and its spend are not.
  expect(step.attempts).toEqual([]);
  expect(step.last_attempt).toBe(1);
  expect(step.control?.total_cost_usd).toBe(1);
  expect(allocateAttempt(resumed, step, "step").logPath).toContain("attempt-002");
});

// Resuming is idempotent: a second load of the same run reads the same spend and
// allocates the same next attempt, and the journal grows by the resume marker only.
test("resume: loading the same run twice neither adds spend nor reuses an attempt number", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-repeated-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-twice" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-twice", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-twice",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "running");
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  appendRunEvent(run, "step.attempt.finished", {
    stepId: "a",
    attempt: 1,
    kind: "step",
    status: "failed",
    control: { duration_ms: 1, total_cost_usd: 1 },
    usage: { input_tokens: 10 },
    logPath: "steps/a/1.log",
  });
  // Die before the snapshot: the journal is the only record of the priced attempt.

  const { run: once } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-twice",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const { run: twice } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-twice",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  for (const resumed of [once, twice].map((opened) => writable(opened))) {
    expect(resumed.steps[0]!.attempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(resumed.steps[0]!.control?.total_cost_usd).toBe(1);
    expect(resumed.steps[0]!.usage?.input_tokens).toBe(10);
    expect(controlForRun(resumed).total_cost_usd).toBe(1);
    expect(allocateAttempt(resumed, resumed.steps[0]!, "step").logPath).toContain("attempt-002");
  }
  const events = readRunEvents(dir);
  expect(events.filter((event) => event.type === "step.attempt.finished")).toHaveLength(1);
  expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(2);
});

test("resume: --start-at requeues the target and every later step, keeping their attempts and spend", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-start" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-start", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-start",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  updateStep(run, run.steps[0]!, "done");
  run.steps[1]!.retries = 1;
  run.steps[1]!.last_attempt = 2;
  run.steps[1]!.control = { duration_ms: 1, total_cost_usd: 1 };
  updateStep(run, run.steps[1]!, "done");
  updateStep(run, run.steps[2]!, "failed", "publish refused");

  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-start",
    runDir: dir,
    fresh: false,
    startAt: "b",
    context: ctx,
    worktree: false,
  });
  expect(resumed.status).toBe("RUNNING");
  expect(resumed.steps.map((step) => [step.status, step.replay])).toEqual([
    ["done", undefined],
    ["pending", true],
    ["pending", true],
  ]);
  expect(resumed.steps[1]).toMatchObject({ retries: 1, last_attempt: 2, control: { total_cost_usd: 1 } });
  expect(controlForRun(resumed).total_cost_usd).toBe(1);

  const deps = countingDeps([{ ok: true }, { ok: true }]);
  await executeRunSteps(resumed, "T-start", undefined, { resuming: true }, deps.deps, ctx);
  expect(deps.spawned).toEqual(["b", "c"]);
  // Settled, the replay mark is gone: a later plain resume treats them as history.
  expect(readRunSnapshot(join(dir, "state.json"))!.steps.map((step) => step.replay)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});

test("resume: a step requeued by --start-at stays pending when the next invocation omits it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-durable-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-durable" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-durable", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-durable",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  for (const step of run.steps) updateStep(run, step, "done");

  // Interrupted before the replay ran anything: the journal's last word on each
  // step is still the `done` of the first pass.
  await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-durable",
    runDir: dir,
    fresh: false,
    startAt: "b",
    context: ctx,
    worktree: false,
  });
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-durable",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  expect(resumed.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);

  const deps = countingDeps([{ ok: true }, { ok: true }]);
  await executeRunSteps(resumed, "T-durable", undefined, { resuming: true }, deps.deps, ctx);
  expect(deps.spawned).toEqual(["b", "c"]);
});

test("resume: --start-at replays a target an earlier --start-at excluded", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-excluded-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-excl" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-excl", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-excl",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "failed", "acceptance refused");

  // `--start-at b` takes the failed `a` out of the run, durably.
  const { run: skipping } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-excl",
    runDir: dir,
    fresh: false,
    startAt: "b",
    context: ctx,
    worktree: false,
  });
  expect(skipping.steps[0]).toMatchObject({ status: "skipped", excluded: true });
  await executeRunSteps(skipping, "T-excl", undefined, { resuming: true }, countingDeps([]).deps, ctx);

  // Naming `a` is the newer decision: it supersedes the exclusion.
  const { run: replaying } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-excl",
    runDir: dir,
    fresh: false,
    startAt: "a",
    context: ctx,
    worktree: false,
  });
  expect(replaying.steps[0]!.excluded).toBeUndefined();
  const deps = countingDeps([{ ok: true }, { ok: true }, { ok: true }]);
  await executeRunSteps(replaying, "T-excl", undefined, { resuming: true }, deps.deps, ctx);
  expect(deps.spawned).toEqual(["a", "b", "c"]);
});

test("resume: --start-at on an explicitly selected PASS run replays from the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-pass-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-pass" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-pass", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-pass",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  for (const step of run.steps) {
    step.control = { duration_ms: 1, total_cost_usd: 1 };
    updateStep(run, step, "done");
  }
  finalizeRun(run);
  unlinkSync(join(dir, "runner.lock"));
  expect(readRunSnapshot(join(dir, "state.json"))?.status).toBe("PASS");

  const selection = selectExplicitRun("p", "T-pass", run.runId!, ctx, { replay: true });
  const { run: resumed } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-pass",
    runDir: selection.dir,
    fresh: false,
    startAt: "c",
    context: ctx,
    strictSnapshot: selection.strictSnapshot,
    worktree: false,
  });
  // Loaded live, with totals derived from the steps rather than the PASS verdict.
  expect(resumed.status).toBe("RUNNING");
  expect(resumed.outcome).toBeUndefined();
  expect(resumed.total_control).toBeUndefined();
  expect(controlForRun(resumed).total_cost_usd).toBe(3);

  const deps = countingDeps([{ ok: true }]);
  await executeRunSteps(resumed, "T-pass", undefined, { resuming: true }, deps.deps, ctx);
  expect(deps.spawned).toEqual(["c"]);
  selection.release();
});

test("resume: --start-at refuses to replay a composed step whose children already settled", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-start-at-composed-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-comp" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-comp", undefined, true, ctx);
  const run = writable(
    (
      await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-comp",
        runDir: dir,
        fresh: false,
        context: ctx,
        worktree: false,
      })
    ).run,
  );
  run.steps[1]!.orchestration = {
    kind: "runPipeline",
    children: [{ key: "main", kind: "main", pipeline: "child", status: "done", accountedCostUsd: 0 }],
  };
  for (const step of run.steps) updateStep(run, step, "done");
  unlinkSync(join(dir, "runner.lock"));
  const before = readRunSnapshot(join(dir, "state.json"));

  // Selected through `latest`, which takes the run lock: the refusal must give it back.
  await expect(
    loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-comp",
      fresh: false,
      startAt: "a",
      context: ctx,
      worktree: false,
    }),
  ).rejects.toThrow(/--start-at: step "b" composes pipelines .*--fresh/);
  expect(readRunSnapshot(join(dir, "state.json"))).toEqual(before);
  expect(existsSync(join(dir, "runner.lock"))).toBe(false);
});

test("a new run started with --start-at marks the target and later steps as replays", async () => {
  const root = mkdtempSync(join(tmpdir(), "new-run-start-at-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-new-start" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-new-start", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-new-start",
    runDir: dir,
    fresh: false,
    startAt: "b",
    context: ctx,
    worktree: false,
  });
  expect(run.steps.map((step) => [step.status, step.excluded, step.replay])).toEqual([
    ["skipped", true, undefined],
    ["pending", undefined, true],
    ["pending", undefined, true],
  ]);
});

// Reconcile mode: the selectors last one invocation, so boot persists none of
// them and drops an exclusion an earlier legacy invocation left behind.

function reconcilePipelineFile(root: string, file: string, mode: "reconcile" | "legacy"): string {
  const path = join(root, file);
  const step = (id: string) =>
    `  .add(actionStep({ id: "${id}", name: "${id}", run: () => {}, describe: "${id}", rerunOnResume: true }))`;
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep }) => pipeline("p")${mode === "reconcile" ? ".reconcile()" : ""}
${["a", "b", "c"].map(step).join("\n")}
  .build();`,
  );
  return path;
}

test("reconcile: a new run started with selectors persists no exclusion and leaves every step to the loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-reconcile-new-"));
  try {
    const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-rec" });
    const path = reconcilePipelineFile(root, "p.ts", "reconcile");
    for (const [stepFilter, skipFilter, startAt] of [
      [["c"], undefined, undefined],
      [undefined, ["b"], undefined],
      [undefined, undefined, "c"],
    ] as const) {
      const dir = resolveRunDir("p", "T-rec", undefined, true, ctx);
      const { run } = await loadOrCreateRun({
        pipelinePath: path,
        ticket: "T-rec",
        stepFilter: stepFilter?.slice(),
        skipFilter: skipFilter?.slice(),
        runDir: dir,
        fresh: false,
        startAt,
        context: ctx,
        worktree: false,
      });
      expect(run.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
      expect(run.steps.map((step) => step.excluded)).toEqual([undefined, undefined, undefined]);
      expect(run.reconcile).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile: a resume applies no selector at boot and drops an exclusion a legacy invocation persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-reconcile-inherited-"));
  try {
    const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-inh" });
    const legacy = reconcilePipelineFile(root, "legacy.ts", "legacy");
    const dir = resolveRunDir("p", "T-inh", undefined, true, ctx);
    const run = writable(
      (
        await loadOrCreateRun({
          pipelinePath: legacy,
          ticket: "T-inh",
          skipFilter: ["b"],
          runDir: dir,
          fresh: false,
          context: ctx,
          worktree: false,
        })
      ).run,
    );
    expect(run.steps[1]).toMatchObject({ status: "skipped", excluded: true });
    expect(run.reconcile).toBe(false);
    saveRun(run);

    const reconciled = reconcilePipelineFile(root, "reconciled.ts", "reconcile");
    const resumed = writable(
      (
        await loadOrCreateRun({
          pipelinePath: reconciled,
          ticket: "T-inh",
          skipFilter: ["c"],
          runDir: dir,
          fresh: false,
          context: ctx,
          worktree: false,
        })
      ).run,
    );

    // b stays skipped, which the loop re-admits; c owes work the loop sets aside.
    expect(resumed.steps.map((step) => step.status)).toEqual(["pending", "skipped", "pending"]);
    expect(resumed.steps.map((step) => step.excluded)).toEqual([undefined, undefined, undefined]);
    // The mode comes from the definition boot loaded, never from the snapshot.
    expect(resumed.reconcile).toBe(true);
    saveRun(resumed);
    const persisted = readRunSnapshot(join(dir, "state.json"))!;
    expect(persisted.steps.some((step) => "excluded" in step)).toBe(false);
    expect("reconcile" in persisted).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
