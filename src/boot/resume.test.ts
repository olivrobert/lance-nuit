import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../pipeline/context.js";
import { appendRunEvent, readRunEvents } from "../state/run-journal.js";
import { loadOrCreateRun } from "./resume.js";
import { pendingSteps, resumeDecision } from "../state/run-predicates.js";
import { saveRun } from "../state/run-repository.js";
import { readRunSnapshot } from "../state/run-snapshot.js";
import { abortRun, finalizeRun, updateStep } from "../state/run-transitions.js";
import { nextAttemptLogPath } from "../state/run-timeline.js";
import { controlForRun } from "../state/cost-accounting.js";
import { resolveRunDir } from "../state/stores/run-storage.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import { selectExplicitRun } from "../state/run-selection.js";
import { commandRegistries } from "../commands/registries.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { executeRunSteps, type StepLoopDeps } from "../step/step-loop.js";

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
  const initial = await loadOrCreateRun(path, "T-race", undefined, undefined, dir, false, undefined, ctx);
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
    loadOrCreateRun(path, "T-race", undefined, undefined, undefined, false, undefined, ctx, { stateStore }),
  ).rejects.toThrow(/is missing/);
  expect(existsSync(join(dir, "state.json"))).toBe(false);
  expect(existsSync(join(dir, "runner.lock"))).toBe(false);
});

test("resume: an explicit selection whose directory disappears does not recreate it or repoint latest", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-explicit-selection-race-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-explicit" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-explicit", undefined, true, ctx);
  const initial = await loadOrCreateRun(path, "T-explicit", undefined, undefined, dir, false, undefined, ctx);
  updateStep(initial, initial.steps[0]!, "failed", "interrupted");
  if (!initial.runId) throw new Error("fixture run must have an id");
  const runId = initial.runId;
  const selection = selectExplicitRun("p", "T-explicit", runId, ctx);
  rmSync(dir, { recursive: true, force: true });

  await expect(
    loadOrCreateRun(path, "T-explicit", undefined, undefined, selection.dir, false, undefined, ctx, {
      strictSnapshot: selection.strictSnapshot,
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
  const run = await loadOrCreateRun(path, "T-3", undefined, undefined, dir, false, undefined, ctx);
  run.budget_exceeded = true;
  updateStep(run, run.steps[0], "failed", "process killed: budget exceeded");
  expect(readRunSnapshot(join(dir, "state.json"))?.budget_exceeded).toBe(true);

  // A plain resume inherits the stop: the ledger may read the ceiling as free room.
  const resumed = await loadOrCreateRun(path, "T-3", undefined, undefined, dir, false, undefined, ctx);
  expect(resumed.budget_exceeded).toBe(true);

  // `--budget` is the human decision that lifts it.
  const approved = await loadOrCreateRun(path, "T-3", undefined, undefined, dir, false, undefined, ctx, {
    maxCostUsd: 5,
  });
  expect(approved.budget_exceeded).toBeUndefined();
  expect(approved.max_cost_usd).toBe(5);
});

test("resume: SIGINT after the last step but before finalizeRun keeps the same run", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-abort-settled-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-1" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-1", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-1", undefined, undefined, dir, false, undefined, ctx);
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
  const resumed = await loadOrCreateRun(path, "T-1", undefined, undefined, dir, false, undefined, ctx);
  expect(resumed.status).toBe("RUNNING");
  expect(resumed.aborted).toBe(false);
});

test("a run records where it executes, so a reader finds its artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-location-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-4" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-4", undefined, true, ctx);

  await loadOrCreateRun(path, "T-4", undefined, undefined, dir, false, undefined, ctx);
  const created = readRunSnapshot(join(dir, "state.json"))!;
  expect(created.cwd).toBe(root);
  expect(created.worktree).toBe(false);

  // A worktree run reads and writes in the copy it was moved into, not in the
  // main clone: without both facts a reader looks for decisions in the wrong tree.
  const worktree = mkdtempSync(join(tmpdir(), "run-location-wt-"));
  const worktreeCtx = buildPipelineContext({ ...commandRegistries(), cwd: worktree, ticket: "T-4" });
  await loadOrCreateRun(path, "T-4", undefined, undefined, dir, false, undefined, worktreeCtx, { worktree: true });
  const resumed = readRunSnapshot(join(dir, "state.json"))!;
  expect(resumed.cwd).toBe(worktree);
  expect(resumed.worktree).toBe(true);
});

test("resume selectors apply to an aborted step, not only to pending ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-selectors-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-2" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-2", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-2", undefined, undefined, dir, false, undefined, ctx);
  updateStep(run, run.steps[0]!, "done");
  updateStep(run, run.steps[1]!, "running");
  abortRun(run, "SIGINT");
  expect(readRunSnapshot(join(dir, "state.json"))!.steps[1]!.status).toBe("aborted");

  // An aborted step is replayed on resume, so it still holds executable work: a
  // selector that excludes it must take it out, or `--step c` runs `b` anyway.
  const onlyC = await loadOrCreateRun(path, "T-2", ["c"], undefined, dir, false, undefined, ctx);
  expect(onlyC.steps[1]!.status).toBe("skipped");

  const skipB = await loadOrCreateRun(path, "T-2", undefined, ["b"], dir, false, undefined, ctx);
  expect(skipB.steps[1]!.status).toBe("skipped");
});

test("resume: an attempt priced in the journal but missing from the snapshot still counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-journal-cost-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-4" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-4", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-4", undefined, undefined, dir, false, undefined, ctx);
  updateStep(run, run.steps[0], "running");
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

  const resumed = await loadOrCreateRun(path, "T-4", undefined, undefined, dir, false, undefined, ctx);
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
  const run = await loadOrCreateRun(path, "T-5", undefined, undefined, dir, false, undefined, ctx);
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
  updateStep(run, run.steps[0], "done");

  const resumed = await loadOrCreateRun(path, "T-5", undefined, undefined, dir, false, undefined, ctx);
  expect(resumed.steps[0]!.control).toEqual({ duration_ms: 5, total_cost_usd: 1.5, model: "m" });
});

test("resume: a fix pass left running by a crash is closed as failed and unpriced, down to the step total", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-crashed-attempt-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-6" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-6", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-6", undefined, undefined, dir, false, undefined, ctx);
  updateStep(run, run.steps[0], "running");
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

  const resumed = await loadOrCreateRun(path, "T-6", undefined, undefined, dir, false, undefined, ctx);
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
  const again = await loadOrCreateRun(path, "T-6", undefined, undefined, dir, false, undefined, ctx);
  expect(again.steps[0]!.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
  expect(readRunEvents(dir).filter((event) => event.type === "step.attempt.finished")).toHaveLength(2);
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
  const run = await loadOrCreateRun(path, "T-8", undefined, undefined, dir, false, undefined, ctx);
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
  const resumed = await loadOrCreateRun(path, "T-8", undefined, undefined, dir, false, undefined, ctx);
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
  const run = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx);

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
  const resumed = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx);
  expect(resumed.cost_unaccounted).toBe(true);
  expect(resumed.allow_unmetered).toBeUndefined();
  const second = countingDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, "T-9", undefined, { resuming: true }, second.deps, ctx);
  expect(again.costUnaccounted).toBe(true);
  expect(second.spawned).toEqual([]);

  // `--budget` changes the amount only: a bigger ceiling is still a ceiling
  // nobody can enforce against the unpriced attempt.
  const raised = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx, {
    maxCostUsd: 50,
    budgetApproved: true,
  });
  expect(raised.max_cost_usd).toBe(50);
  expect(raised.cost_unaccounted).toBe(true);
  expect(raised.allow_unmetered).toBeUndefined();
  const third = countingDeps([{ ok: true }, { ok: true }]);
  const withBudget = await executeRunSteps(raised, "T-9", undefined, { resuming: true }, third.deps, ctx);
  expect(withBudget.costUnaccounted).toBe(true);
  expect(third.spawned).toEqual([]);

  // `--allow-unmetered` is the authorization. It is persisted and journaled once.
  const authorized = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx, {
    allowUnmetered: true,
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
  const inherited = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx);
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
  const run = await loadOrCreateRun(path, "T-12", undefined, undefined, dir, false, undefined, ctx);
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
  const capped = await loadOrCreateRun(path, "T-12", undefined, undefined, dir, false, undefined, ctx, {
    maxCostUsd: 10,
    budgetApproved: true,
  });
  expect(capped.max_cost_usd).toBe(10);
  expect(capped.cost_unaccounted).toBe(true);
  const second = countingDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(capped, "T-12", undefined, { resuming: true }, second.deps, ctx);
  expect(again.costUnaccounted).toBe(true);
  expect(again.costUnaccountedStop).toBe(true);
  expect(second.spawned).toEqual([]);

  // And the way out is the authorization, alongside the ceiling it just gained.
  const authorized = await loadOrCreateRun(path, "T-12", undefined, undefined, dir, false, undefined, ctx, {
    allowUnmetered: true,
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
  const authorized = await loadOrCreateRun(path, "T-10", undefined, undefined, dir, false, undefined, ctx, {
    allowUnmetered: true,
  });
  expect(authorized.allow_unmetered).toBe(true);
  const first = countingDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } }]);
  await executeRunSteps(authorized, "T-10", undefined, { resuming: false }, first.deps, ctx);
  expect(readRunSnapshot(join(dir, "state.json"))?.cost_unaccounted).toBe(true);

  // `--fresh` is a new run, not a continuation: it starts strict, with no spend
  // and no authorization to inherit from the run it replaces.
  const fresh = await loadOrCreateRun(path, "T-10", undefined, undefined, undefined, true, undefined, ctx);
  expect(fresh.run_dir).not.toBe(dir);
  expect(fresh.allow_unmetered).toBeUndefined();
  expect(fresh.cost_unaccounted).toBeUndefined();
}, 20_000);

test("resume: an authorized run still stops when the spend it could price reaches the ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-ceiling-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-11" });
  const path = budgetedPipelineFile(root, 1);
  const dir = resolveRunDir("p", "T-11", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-11", undefined, undefined, dir, false, undefined, ctx, {
    allowUnmetered: true,
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
  await loadOrCreateRun(before, "T-new", undefined, undefined, selected, false, undefined, ctx);
  const skipped = resolveRunDir("p", "T-new", undefined, true, ctx);
  await loadOrCreateRun(before, "T-new", undefined, undefined, skipped, false, undefined, ctx);

  // A step added afterwards has no persisted state, so hydration would default it
  // to pending: it must still answer to the resume selectors.
  const after = definition("after.ts", ["a", "b", "deploy"]);

  const onlyA = await loadOrCreateRun(after, "T-new", ["a"], undefined, selected, false, undefined, ctx);
  const outsideSelection = onlyA.steps.find((entry) => entry.id === "deploy")!;
  expect(outsideSelection.status).toBe("skipped");
  expect(outsideSelection.excluded).toBe(true);

  const withoutDeploy = await loadOrCreateRun(after, "T-new", undefined, ["deploy"], skipped, false, undefined, ctx);
  const explicitlySkipped = withoutDeploy.steps.find((entry) => entry.id === "deploy")!;
  expect(explicitlySkipped.status).toBe("skipped");
  expect(explicitlySkipped.excluded).toBe(true);
});

// Invariant: the journal owns the attempts. A resume that cannot read it must
// fail, not come back with zero attempts and a budget that forgot their price.
test("invariant: a resume over an unreadable journal fails instead of forgetting the attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-invariant-unreadable-journal-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-9" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-9", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx);
  updateStep(run, run.steps[0], "running");
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

  await expect(loadOrCreateRun(path, "T-9", undefined, undefined, dir, false, undefined, ctx)).rejects.toThrow(
    /EISDIR/,
  );
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
  const passed = await loadOrCreateRun(path, "T-totals", undefined, undefined, passDir, false, undefined, ctx);
  for (const step of passed.steps) {
    step.control = { duration_ms: 1, total_cost_usd: 1 };
    updateStep(passed, step, "done");
  }
  finalizeRun(passed);
  expect(readRunSnapshot(join(passDir, "state.json"))?.total_control?.total_cost_usd).toBe(3);
  const terminal = await loadOrCreateRun(path, "T-totals", undefined, undefined, passDir, false, undefined, ctx);
  expect(terminal.status).toBe("PASS");
  expect(terminal.total_control?.total_cost_usd).toBe(3);

  // A run with work left: a total written by an earlier generation is dropped, and
  // the ledger seed reads the steps, which know of the spend that came after it.
  const liveDir = resolveRunDir("p", "T-totals", undefined, true, ctx);
  const live = await loadOrCreateRun(path, "T-totals", undefined, undefined, liveDir, false, undefined, ctx);
  live.steps[0]!.control = { duration_ms: 1, total_cost_usd: 1 };
  updateStep(live, live.steps[0]!, "done");
  live.total_control = { duration_ms: 1, total_cost_usd: 0.25 };
  live.total_usage = { output_tokens: 1 };
  saveRun(live);
  expect(readRunSnapshot(join(liveDir, "state.json"))?.total_control?.total_cost_usd).toBe(0.25);
  const resumed = await loadOrCreateRun(path, "T-totals", undefined, undefined, liveDir, false, undefined, ctx);
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
  const run = await loadOrCreateRun(path, "T-append", undefined, undefined, dir, false, undefined, ctx, {
    eventStore,
  });
  updateStep(run, run.steps[0]!, "running");
  const first = nextAttemptLogPath(run, run.steps[0]!, "step");
  expect(first).toContain("attempt-001");
  run.steps[0]!.attempts[0]!.status = "failed";
  run.steps[0]!.control = { duration_ms: 1, total_cost_usd: 1 };
  updateStep(run, run.steps[0]!, "failed", "boom");
  expect(readRunSnapshot(join(dir, "state.json"))?.steps[0]?.last_attempt).toBe(1);

  const resumed = await loadOrCreateRun(path, "T-append", undefined, undefined, dir, false, undefined, ctx, {
    eventStore,
  });
  const step = resumed.steps[0]!;
  // The attempt itself is gone with the journal; its number and its spend are not.
  expect(step.attempts).toEqual([]);
  expect(step.last_attempt).toBe(1);
  expect(step.control?.total_cost_usd).toBe(1);
  expect(nextAttemptLogPath(resumed, step, "step")).toContain("attempt-002");
});

// Resuming is idempotent: a second load of the same run reads the same spend and
// allocates the same next attempt, and the journal grows by the resume marker only.
test("resume: loading the same run twice neither adds spend nor reuses an attempt number", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-repeated-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-twice" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-twice", undefined, true, ctx);
  const run = await loadOrCreateRun(path, "T-twice", undefined, undefined, dir, false, undefined, ctx);
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

  const once = await loadOrCreateRun(path, "T-twice", undefined, undefined, dir, false, undefined, ctx);
  const twice = await loadOrCreateRun(path, "T-twice", undefined, undefined, dir, false, undefined, ctx);
  for (const resumed of [once, twice]) {
    expect(resumed.steps[0]!.attempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(resumed.steps[0]!.control?.total_cost_usd).toBe(1);
    expect(resumed.steps[0]!.usage?.input_tokens).toBe(10);
    expect(controlForRun(resumed).total_cost_usd).toBe(1);
    expect(nextAttemptLogPath(resumed, resumed.steps[0]!, "step")).toContain("attempt-002");
  }
  const events = readRunEvents(dir);
  expect(events.filter((event) => event.type === "step.attempt.finished")).toHaveLength(1);
  expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(2);
});
