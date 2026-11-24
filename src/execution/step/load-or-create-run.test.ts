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
import { dirname, join } from "node:path";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import { allocateAttempt, openAttempt, settleAttempt } from "../../run/record/attempt-lifecycle.js";
import { openRunLedger, runSpend } from "../../run/record/cost-accounting.js";
import { writable } from "../../run/record/run.js";
import { readRunEvents } from "../../run/record/run-journal.js";
import { pendingSteps, resumeDecision } from "../../run/record/run-predicates.js";
import { saveRun } from "../../run/record/run-repository.js";
import { selectExplicitRun } from "../../run/record/run-selection.js";
import { readRunSnapshot } from "../../run/record/run-snapshot.js";
import { abortRun, finalizeRun, updateStep } from "../../run/record/run-transitions.js";
import { FileRunStateStore } from "../../run/record/stores/file-run-state-store.js";
import { resolveRunDir } from "../../run/record/stores/run-storage.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { NULL_RUN_OUTPUT } from "../run-output.js";
import { type LoadOrCreateRunOptions, loadOrCreateRun } from "./load-or-create-run.js";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.js";

function pipelineFile(root: string): string {
  const path = join(root, "p.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep, textArtifact }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", output: [textArtifact("a.txt")] }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b", output: [textArtifact("b.txt")] }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c", output: [textArtifact("c.txt")] }))
  .build();`,
  );
  return path;
}

test("resume: a selected snapshot disappearing before the final read does not initialize a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-selection-race-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-race" });
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-explicit" });
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-3" });
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-1" });
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

test("a run records where it executes, so a reader finds its artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-location-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-4" });
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
  const worktreeCtx = buildPipelineContext({ ...builtinRegistries(), cwd: worktree, ticket: "T-4" });
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

/** Leave step `id` as a runner death leaves it: `running`, its attempt started
 *  and never finished. */
function crashDuring(opened: Awaited<ReturnType<typeof loadOrCreateRun>>["run"], id: string): void {
  const run = writable(opened);
  const step = run.steps.find((candidate) => candidate.id === id)!;
  updateStep(run, step, "running");
  openAttempt(run, step, { kind: "step", command: id });
}

test("resume: a step interrupted by a crash stops the run instead of replaying, until --replay-interrupted authorizes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-interrupted-stop-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-6c" });
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
  const first = countingDeps(ctx, []);
  const outcome = await executeRunSteps(resumed, { resuming: true }, first.deps, ctx);
  expect(outcome.stopped).toBe(true);
  expect(first.spawned).toEqual([]);
  finalizeRun(resumed, outcome);
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
  const second = countingDeps(ctx, []);
  expect((await executeRunSteps(again, { resuming: true }, second.deps, ctx)).stopped).toBe(true);
  expect(second.spawned).toEqual([]);

  const { run: authorized } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-6c",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  const third = countingDeps(ctx, []);
  const replayed = await executeRunSteps(authorized, { resuming: true, replayInterrupted: true }, third.deps, ctx);
  expect(replayed.stopped).toBe(false);
  expect(third.spawned).toEqual(["a", "b", "c"]);
  expect(authorized.steps[0]!.status).toBe("done");
});

for (const option of ["replayInterrupted", "rerunOnResume"]) {
  test(`resume: a step declaring ${option} is replayed after a crash without asking`, async () => {
    const root = mkdtempSync(join(tmpdir(), "resume-interrupted-declared-"));
    const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-6d" });
    const path = join(root, "declared.ts");
    writeFileSync(
      path,
      `export default ({ pipeline, actionStep, textArtifact }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", ${option}: true, output: [textArtifact("a.txt")] }))
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
    const loop = countingDeps(ctx, []);
    const outcome = await executeRunSteps(resumed, { resuming: true }, loop.deps, ctx);
    expect(outcome.stopped).toBe(false);
    expect(loop.spawned).toEqual(["a"]);
    expect(resumed.steps[0]!.status).toBe("done");
  });
}

/** Same three steps, under a `.maxCost()` ceiling declared by the pipeline
 *  itself rather than approved on the command line. */
/** The same three-step pipeline with or without a declared ceiling: `usd`
 *  omitted writes no `.maxCost()` at all, which is how a run reaches the
 *  "uncapped when it spent, capped on the next invocation" case. */
function budgetedPipelineFile(root: string, usd?: number): string {
  const path = join(root, "budgeted.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep, textArtifact }) => pipeline("p")
  ${usd === undefined ? "" : `.maxCost(${usd})`}
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", output: [textArtifact("a.txt")] }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b", output: [textArtifact("b.txt")] }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c", output: [textArtifact("c.txt")] }))
  .build();`,
  );
  return path;
}

/** Loop dependencies whose spawn is programmable and counted. */
function countingDeps(
  ctx: PipelineContext,
  results: Array<Partial<Awaited<ReturnType<StepLoopDeps["executeStep"]>>>>,
): {
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
        const result = { output: "", ok: true, stats: { duration_ms: 1 }, ...(results[index++] ?? {}) };
        // A successful spawn leaves the outputs its step declares, as a real one would.
        if (result.ok) {
          for (const output of step.def.outputs ?? []) {
            const path = ctx.paths.artifact(output.name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, step.id);
          }
        }
        return result;
      },
      extractErrors: async () => ({ hasErrors: false, errors: "" }),
      runFixLoop: async () => ({ kind: "done" }),
      output: NULL_RUN_OUTPUT,
    },
  };
}

test("resume: a mid-step .maxCost() kill stops the run, and its cost is read back on the next invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-maxcost-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-8" });
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
  const first = countingDeps(ctx, [
    {
      ok: false,
      budgetExceeded: true,
      failReason: "process killed: budget exceeded ($1.20 estimated > $1.00 remaining)",
      stats: { duration_ms: 1, total_cost_usd: 0.9, cost_estimated: true },
    },
  ]);
  const outcome = await executeRunSteps(run, { resuming: false }, first.deps, ctx);

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
  expect(runSpend(resumed).usd).toBe(0.9);

  const second = countingDeps(ctx, [{ ok: true }, { ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, { resuming: true }, second.deps, ctx);
  expect(again.budgetExceeded).toBe(true);
  expect(second.spawned).toEqual([]);
  expect(runSpend(resumed).usd).toBe(0.9);
}, 20_000);

test("resume: an accounting stop resists a plain resume and --budget, and only --allow-unmetered lifts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-9" });
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
  const first = countingDeps(ctx, [{ ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } }]);
  const outcome = await executeRunSteps(run, { resuming: false }, first.deps, ctx);
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
  const second = countingDeps(ctx, [{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, { resuming: true }, second.deps, ctx);
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
  const third = countingDeps(ctx, [{ ok: true }, { ok: true }]);
  const withBudget = await executeRunSteps(raised, { resuming: true }, third.deps, ctx);
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

  const fourth = countingDeps(ctx, [{ ok: true }, { ok: true }]);
  const allowed = await executeRunSteps(authorized, { resuming: true }, fourth.deps, ctx);
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-12" });
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
  const first = countingDeps(ctx, [
    { ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
    { ok: false, failReason: "step b failed" },
  ]);
  const outcome = await executeRunSteps(run, { resuming: false }, first.deps, ctx);
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
  const second = countingDeps(ctx, [{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(capped, { resuming: true }, second.deps, ctx);
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
  const third = countingDeps(ctx, [{ ok: true }, { ok: true }]);
  const allowed = await executeRunSteps(authorized, { resuming: true }, third.deps, ctx);
  expect(allowed.costUnaccounted).toBe(false);
  expect(third.spawned).toEqual(["b", "c"]);
}, 30_000);

test("resume: a fresh run inherits neither the authorization nor the accounting stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-unmetered-fresh-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-10" });
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
  const first = countingDeps(ctx, [{ ok: true, stats: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } }]);
  await executeRunSteps(authorized, { resuming: false }, first.deps, ctx);
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-11" });
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
  const deps = countingDeps(ctx, [{ ok: true, stats: { duration_ms: 1, total_cost_usd: 2, cost_unknown: true } }]);
  const outcome = await executeRunSteps(run, { resuming: false }, deps.deps, ctx);
  expect(outcome.budgetExceeded).toBe(true);
  expect(outcome.costUnaccounted).toBe(false);
  expect(deps.spawned).toEqual(["a"]);
  expect(run.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);
}, 20_000);

// Resuming is idempotent: a second load of the same run reads the same spend and
// allocates the same next attempt, and the journal grows by the resume marker only.
test("resume: loading the same run twice neither adds spend nor reuses an attempt number", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-repeated-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-twice" });
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
  const opened = openAttempt(run, run.steps[0]!, { kind: "step", command: "a" });
  settleAttempt(
    run,
    run.steps[0]!,
    opened,
    { ok: false, stats: { duration_ms: 1, total_cost_usd: 1, input_tokens: 10 } },
    openRunLedger(run),
  );

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
    expect(runSpend(resumed).usd).toBe(1);
    expect(allocateAttempt(resumed, resumed.steps[0]!, "step").logPath).toContain("attempt-002");
  }
  const events = readRunEvents(dir);
  expect(events.filter((event) => event.type === "step.attempt.finished")).toHaveLength(1);
  expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(2);
});

test("resume: a definition that dropped a persisted step refuses and gives the run lock back", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-removed-step-lock-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-removed" });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", "T-removed", undefined, true, ctx);
  const { run } = await loadOrCreateRun({
    pipelinePath: path,
    ticket: "T-removed",
    runDir: dir,
    fresh: false,
    context: ctx,
    worktree: false,
  });
  updateStep(run, run.steps[0]!, "failed", "interrupted");
  unlinkSync(join(dir, "runner.lock"));
  const trimmed = join(root, "p-trimmed.ts");
  writeFileSync(
    trimmed,
    `export default ({ pipeline, actionStep, textArtifact }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", output: [textArtifact("a.txt")] }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b", output: [textArtifact("b.txt")] }))
  .build();`,
  );

  await expect(
    loadOrCreateRun({ pipelinePath: trimmed, ticket: "T-removed", fresh: false, context: ctx, worktree: false }),
  ).rejects.toThrow(/removed or renamed persisted step\(s\): c/);
  expect(existsSync(join(dir, "runner.lock"))).toBe(false);
});

test("selectors persist nothing: a resume drops the exclusion an older runner left in the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-dropped-exclusion-"));
  try {
    const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-inh" });
    const path = pipelineFile(root);
    const dir = resolveRunDir("p", "T-inh", undefined, true, ctx);
    const { run } = await loadOrCreateRun({
      pipelinePath: path,
      ticket: "T-inh",
      runDir: dir,
      fresh: false,
      context: ctx,
      worktree: false,
    });
    expect(run.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    const statePath = join(dir, "state.json");
    const legacy = JSON.parse(readFileSync(statePath, "utf8"));
    legacy.steps[1] = { ...legacy.steps[1], status: "skipped", excluded: true };
    writeFileSync(statePath, JSON.stringify(legacy));

    const resumed = writable(
      (
        await loadOrCreateRun({
          pipelinePath: path,
          ticket: "T-inh",
          runDir: dir,
          fresh: false,
          context: ctx,
          worktree: false,
        })
      ).run,
    );
    // b stays skipped, which the loop re-admits like any settled step.
    expect(resumed.steps.map((step) => step.status)).toEqual(["pending", "skipped", "pending"]);
    saveRun(resumed);
    const persisted = readRunSnapshot(statePath)!;
    expect(persisted.steps.some((step) => "excluded" in step)).toBe(false);
    expect("reconcile" in persisted).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
