// `--start-at X` forks a run (spec §5): the source selected and checked before any
// write, the fork written field by field, the source superseded, and the budget
// that counts what the source spent.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import { loadPipelineDefinition } from "../../definition/index.js";
import { openAttempt } from "../../run/record/attempt-lifecycle.js";
import { openRunLedger, runSpend } from "../../run/record/cost-accounting.js";
import { type Run, writable } from "../../run/record/run.js";
import { readRunEvents } from "../../run/record/run-journal.js";
import { saveRun } from "../../run/record/run-repository.js";
import { selectForkSource } from "../../run/record/run-selection.js";
import { readRunSnapshot } from "../../run/record/run-snapshot.js";
import { finalizeRun, updateStep } from "../../run/record/run-transitions.js";
import { releaseRunDir, resolveRunDir } from "../../run/record/stores/run-storage.js";
import { projectRunStatsEntry } from "../../run/stats/run-stats-projector.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { sha256Text } from "../../work-items/store/hash.js";
import { commitPass } from "../../work-items/store/step-lock.js";
import { NULL_RUN_OUTPUT } from "../run-output.js";
import { checkForkSource, loadOrCreateRun } from "./load-or-create-run.js";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.js";

function pipelineFile(root: string, maxCost?: number, aOptions = ""): string {
  const path = join(root, "p.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep, textArtifact }) => pipeline("p")
  ${maxCost === undefined ? "" : `.maxCost(${maxCost})`}
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", output: [textArtifact("a.txt")]${aOptions} }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b", output: [textArtifact("b.txt")] }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c", output: [textArtifact("c.txt")] }))
  .build();`,
  );
  return path;
}

/** Leave the outputs of the fixture steps and their stamps, as their passes would have. */
function writeOutputs(ctx: PipelineContext, ...ids: string[]): void {
  for (const id of ids) {
    const path = ctx.paths.artifact(`${id}.txt`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id);
    const stamp = { pipeline: "p", runId: "r", stampedAt: "2026-01-01T00:00:00.000Z", inputs: {} };
    commitPass(ctx, id, { ...stamp, outputs: { [`artifacts/${id}.txt`]: sha256Text(id) } }, []);
  }
}

interface Fixture {
  root: string;
  ctx: PipelineContext;
  path: string;
  dir: string;
  source: Run;
}

/** A source run whose first steps are done and paid for, its lock released. */
async function sourceRun(ticket: string, done: string[], maxCost?: number, aOptions?: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "fork-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket });
  const path = pipelineFile(root, maxCost, aOptions);
  const dir = resolveRunDir("p", ticket, undefined, true, ctx);
  const opened = await loadOrCreateRun({ pipelinePath: path, ticket, runDir: dir, context: ctx, worktree: false });
  const source = writable(opened.run);
  for (const step of source.steps.filter((candidate) => done.includes(candidate.id))) {
    step.control = { duration_ms: 1, total_cost_usd: 1 };
    step.session = { provider: "claude", id: `session-${step.id}`, resumable: true };
    step.retries = 1;
    step.errors = "an earlier failure";
    updateStep(source, step, "done");
  }
  writeOutputs(ctx, ...done);
  saveRun(source);
  releaseRunDir(dir);
  return { root, ctx, path, dir, source };
}

async function fork(fixture: Fixture, startAt: string, options: { maxCostUsd?: number; runId?: string } = {}) {
  const { ctx, path } = fixture;
  const forkSource = selectForkSource("p", ctx.ticket, options.runId, ctx);
  const opened = await loadOrCreateRun({
    pipelinePath: path,
    ticket: ctx.ticket,
    startAt,
    forkSource,
    context: ctx,
    worktree: false,
    ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd, budgetApproved: true } : {}),
  });
  return writable(opened.run);
}

function countingDeps(): { deps: StepLoopDeps; spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    deps: {
      executeStep: async (step) => {
        spawned.push(step.id);
        return { output: "", ok: true, stats: { duration_ms: 1 } };
      },
      extractErrors: async () => ({ hasErrors: false, errors: "" }),
      runFixLoop: async () => ({ kind: "done" }),
      output: NULL_RUN_OUTPUT,
    },
  };
}

test("fork: the new run follows §5.2 step 5 field by field, and becomes latest (F2)", async () => {
  const fixture = await sourceRun("T-F2", ["a", "b"]);
  finalizeRun(fixture.source, { failed: false, stopped: false, setAside: [] } as never);
  releaseRunDir(fixture.dir);

  const forked = await fork(fixture, "b");

  expect(forked.run_dir).not.toBe(fixture.dir);
  expect(forked).toMatchObject({
    status: "RUNNING",
    forkedFrom: fixture.source.runId,
    startAt: "b",
    inheritedSpendUsd: 2,
    rootRunId: forked.runId,
    budgetScopeId: forked.runId,
  });
  expect(forked.budget_exceeded).toBeUndefined();
  expect(forked.budget_approved).toBeUndefined();
  expect(forked.allow_unmetered).toBeUndefined();
  const [a, b, c] = forked.steps;
  expect(a).toMatchObject({ status: "done", session: { id: "session-a" }, retries: 0, attempts: [] });
  expect(a!.control).toBeUndefined();
  expect(a!.errors).toBeUndefined();
  for (const blank of [b!, c!]) {
    expect(blank).toMatchObject({ status: "pending", retries: 0, attempts: [] });
    expect(blank.session).toBeUndefined();
    expect(blank.control).toBeUndefined();
  }
  expect(readlinkSync(join(dirname(fixture.dir), "latest"))).toBe(forked.runId!);
  expect(readRunSnapshot(join(forked.run_dir, "state.json"))).toMatchObject({ forkedFrom: fixture.source.runId });
  expect(readRunEvents(forked.run_dir).map((event) => event.type)).toContain("run.forked");
});

test("fork: a PASS source keeps its bytes; an unfinished one is superseded with its crashed attempts settled (F1)", async () => {
  const passed = await sourceRun("T-F1a", ["a", "b", "c"]);
  finalizeRun(passed.source, { failed: false, stopped: false, setAside: [] } as never);
  releaseRunDir(passed.dir);
  const passedBytes = readFileSync(join(passed.dir, "state.json"), "utf8");
  await fork(passed, "c");
  expect(readFileSync(join(passed.dir, "state.json"), "utf8")).toBe(passedBytes);

  const crashed = await sourceRun("T-F1b", ["a"]);
  const step = crashed.source.steps[1]!;
  updateStep(crashed.source, step, "running");
  openAttempt(crashed.source, step, { kind: "step", command: "b" });
  step.attempts.at(-1)!.control = { duration_ms: 1, total_cost_usd: 0.5 };
  saveRun(crashed.source);
  releaseRunDir(crashed.dir);
  const before = readRunSnapshot(join(crashed.dir, "state.json"))!;

  const forked = await fork(crashed, "b");

  const after = readRunSnapshot(join(crashed.dir, "state.json"))!;
  expect(after).toMatchObject({ status: "SUPERSEDED", supersededBy: forked.runId });
  expect(after.steps[1]!.attempts![0]).toMatchObject({ status: "failed", interrupted: true });
  const unchanged = (snapshot: typeof before) => ({
    ...snapshot,
    status: undefined,
    supersededBy: undefined,
    updatedAt: undefined,
    steps: [snapshot.steps[0], snapshot.steps[2]],
  });
  expect(unchanged(after)).toEqual(unchanged(before));
  expect(readRunEvents(crashed.dir).map((event) => event.type)).toEqual(
    expect.arrayContaining(["step.attempt.finished", "run.superseded"]),
  );
  // The settlement reached the spend the fork inherits (F3).
  expect(forked.inheritedSpendUsd).toBe(1.5);
});

test("fork: the supersession cascades to the unfinished runs the source composed", async () => {
  const fixture = await sourceRun("T-cascade", ["a"]);
  const childDir = join(dirname(dirname(fixture.dir)), "child", "child-run");
  mkdirSync(childDir, { recursive: true });
  const child = { schemaVersion: 2, runId: "child-run", name: "child", pipeline: "child", ticket: "T-cascade" };
  writeFileSync(
    join(childDir, "state.json"),
    JSON.stringify({ ...child, status: "FAIL", parentRunId: fixture.source.runId, steps: [] }),
  );
  fixture.source.steps[2]!.orchestration = {
    kind: "runPipeline",
    children: [
      {
        key: "main",
        kind: "main",
        pipeline: "child",
        ticket: "T-cascade",
        runId: "child-run",
        status: "failed",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(fixture.source);
  releaseRunDir(fixture.dir);

  const forked = await fork(fixture, "b");

  expect(readRunSnapshot(join(childDir, "state.json"))).toMatchObject({
    status: "SUPERSEDED",
    supersededBy: forked.runId,
  });
});

test("fork: a child still out when the source died hands down the spend its node never received", async () => {
  const fixture = await sourceRun("T-child-out", ["a"]);
  const childDir = join(dirname(dirname(fixture.dir)), "child", "child-run");
  mkdirSync(childDir, { recursive: true });
  const child = { schemaVersion: 2, runId: "child-run", name: "child", pipeline: "child", ticket: "T-child-out" };
  writeFileSync(
    join(childDir, "state.json"),
    JSON.stringify({
      ...child,
      status: "RUNNING",
      parentRunId: fixture.source.runId,
      steps: [
        { id: "x", status: "done", retries: 0, control: { duration_ms: 1, total_cost_usd: 8 } },
        {
          id: "y",
          status: "running",
          retries: 0,
          attempts: [
            { attempt: 1, kind: "step", status: "running", started_at: "2026-01-01T00:00:00.000Z", log_path: "y.log" },
          ],
        },
      ],
    }),
  );
  const node = fixture.source.steps[1]!;
  updateStep(fixture.source, node, "running");
  node.orchestration = {
    kind: "runPipeline",
    children: [
      {
        key: "main",
        kind: "main",
        pipeline: "child",
        ticket: "T-child-out",
        runId: "child-run",
        status: "running",
        accountedCostUsd: 3,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  saveRun(fixture.source);
  releaseRunDir(fixture.dir);

  const forked = await fork(fixture, "b");

  expect(forked.inheritedSpendUsd).toBe(1 + (8 - 3));
  expect(forked.cost_unaccounted).toBe(true);
});

test("fork: the ledger counts the inherited spend, stops at the first gate when it reaches the ceiling, and the statistics do not (F3)", async () => {
  const fixture = await sourceRun("T-F3", ["a", "b"]);
  releaseRunDir(fixture.dir);

  const forked = await fork(fixture, "c", { maxCostUsd: 2 });

  expect(openRunLedger(forked).cumulative).toBe(2);
  expect(runSpend(forked).usd).toBeUndefined();
  const { deps, spawned } = countingDeps();
  const outcome = await executeRunSteps(forked, { resuming: true }, deps, fixture.ctx);
  expect(outcome.budgetExceeded).toBe(true);
  expect(spawned).toEqual([]);
  expect(projectRunStatsEntry(forked).costUsd ?? 0).toBe(0);
});

test("fork pre-check: every offending step before the start is listed, and nothing is written (F4)", async () => {
  const fixture = await sourceRun("T-F4", ["a"]);
  const def = await loadPipelineDefinition(fixture.path, fixture.ctx);
  const source = () => selectForkSource("p", fixture.ctx.ticket, undefined, fixture.ctx);

  expect(await checkForkSource(def, source(), "b", fixture.ctx)).toEqual([]);
  expect(await checkForkSource(def, source(), "c", fixture.ctx)).toEqual([
    'step "b" is pending: every step before "c" must be done or skipped',
  ]);

  writeFileSync(fixture.ctx.paths.artifact("a.txt"), "edited");
  const b = fixture.source.steps[1]!;
  updateStep(fixture.source, b, "done");
  releaseRunDir(fixture.dir);
  expect(await checkForkSource(def, source(), "c", fixture.ctx)).toEqual([
    'step "a" is stale: its artifacts changed since it succeeded',
    'step "b" is done but has no stamp in the freshness lock',
  ]);
});

test("fork pre-check: a step left out by --skip is refused, a skip by its when and an absorbed non-blocking failure are not", async () => {
  const left = await sourceRun("T-left", []);
  const a = left.source.steps[0]!;
  updateStep(left.source, a, "skipped");
  saveRun(left.source);
  releaseRunDir(left.dir);
  const leftDef = await loadPipelineDefinition(left.path, left.ctx);
  expect(await checkForkSource(leftDef, selectForkSource("p", "T-left", undefined, left.ctx), "b", left.ctx)).toEqual([
    'step "a" was left out by --steps or --skip and never ran',
  ]);

  const when = await sourceRun("T-when", [], undefined, ", when: () => false");
  updateStep(when.source, when.source.steps[0]!, "skipped");
  saveRun(when.source);
  releaseRunDir(when.dir);
  const whenDef = await loadPipelineDefinition(when.path, when.ctx);
  expect(await checkForkSource(whenDef, selectForkSource("p", "T-when", undefined, when.ctx), "b", when.ctx)).toEqual(
    [],
  );

  const absorbed = await sourceRun("T-absorbed", [], undefined, ", blocking: false");
  updateStep(absorbed.source, absorbed.source.steps[0]!, "done");
  saveRun(absorbed.source);
  releaseRunDir(absorbed.dir);
  const absorbedDef = await loadPipelineDefinition(absorbed.path, absorbed.ctx);
  const absorbedSource = selectForkSource("p", "T-absorbed", undefined, absorbed.ctx);
  expect(await checkForkSource(absorbedDef, absorbedSource, "b", absorbed.ctx)).toEqual([]);
});

test("fork source: no run, a composed child, and an older run behind an unfinished latest are refused (F4)", async () => {
  const root = mkdtempSync(join(tmpdir(), "fork-none-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-none" });
  expect(() => selectForkSource("p", "T-none", undefined, ctx)).toThrow(/has no run to fork/);

  const held = await sourceRun("T-held", ["a"]);
  // `process.ppid` is alive and is not us: the shape of a second runner.
  writeFileSync(join(held.dir, "runner.lock"), String(process.ppid));
  expect(() => selectForkSource("p", "T-held", undefined, held.ctx)).toThrow(/held by another runner process/);

  const fixture = await sourceRun("T-src", ["a"]);
  fixture.source.parentRunId = "parent-run";
  saveRun(fixture.source);
  releaseRunDir(fixture.dir);
  expect(() => selectForkSource("p", "T-src", undefined, fixture.ctx)).toThrow(/composed by run parent-run/);

  const older = await sourceRun("T-older", ["a"]);
  const latest = writable(
    (
      await loadOrCreateRun({
        pipelinePath: older.path,
        ticket: "T-older",
        fresh: true,
        context: older.ctx,
        worktree: false,
      })
    ).run,
  );
  releaseRunDir(latest.run_dir);
  expect(() => selectForkSource("p", "T-older", older.source.runId, older.ctx)).toThrow(
    new RegExp(`run ${latest.runId} is the latest run`),
  );
});

test("resume: run.resumed carries the invocation's selectors (A5)", async () => {
  const fixture = await sourceRun("T-A5", ["a"]);
  await loadOrCreateRun({
    pipelinePath: fixture.path,
    ticket: "T-A5",
    runDir: fixture.dir,
    context: fixture.ctx,
    worktree: false,
    selection: { skip: ["b"], until: "c" },
  });

  const resumed = readRunEvents(fixture.dir).find((event) => event.type === "run.resumed");
  expect(resumed).toMatchObject({ steps: null, skip: ["b"], until: "c" });
});
