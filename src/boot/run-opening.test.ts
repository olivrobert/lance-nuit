// What opening a run writes, in order: the snapshots and the journal events a
// new run, a resumed run, a run a crash left behind and a composed child resumed
// on its own leave on disk before the first step runs. A resume reads these two
// files back, so the order is part of the contract, not an implementation
// detail.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { commandRegistries } from "../commands/registries.js";
import type { PipelineContext } from "../model/context.js";
import type { PersistedRun } from "../model/persisted.js";
import type { RunJournalEvent } from "../model/journal.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { appendRunEvent, readRunEvents } from "../run-record/run-journal.js";
import { saveRun } from "../run-record/run-repository.js";
import { selectExplicitRun } from "../run-record/run-selection.js";
import { readRunSnapshot } from "../run-record/run-snapshot.js";
import { abortRun, finalizeRun, updateStep } from "../run-record/run-transitions.js";
import { FileRunEventStore } from "../run-record/stores/file-run-event-store.js";
import { FileRunStateStore } from "../run-record/stores/file-run-state-store.js";
import { pipelineRunsDir, resolveRunDir } from "../run-record/stores/run-storage.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { executeRunSteps, stepLoopDeps } from "../step/step-loop.js";
import { loadOrCreateRun } from "./resume.js";

/** Every snapshot and journal write a store receives, interleaved. */
type Write = string;

class RecordingStateStore extends FileRunStateStore {
  readonly writes: Write[];

  constructor(context: PipelineContext, ticket: string, pipeline: string, writes: Write[]) {
    super({ context, ticket, pipeline });
    this.writes = writes;
  }

  override saveAt(run: PersistedRun, runDir: string): void {
    this.writes.push(`snapshot ${run.status}`);
    super.saveAt(run, runDir);
  }
}

class RecordingEventStore extends FileRunEventStore {
  readonly writes: Write[];

  constructor(runDir: string, writes: Write[]) {
    super({ runDir });
    this.writes = writes;
  }

  override append(runId: string, event: RunJournalEvent): void {
    this.writes.push(event.type);
    super.append(runId, event);
  }
}

function pipelineFile(root: string, name = "p"): string {
  const path = join(root, `${name}.ts`);
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep }) => pipeline(${JSON.stringify(name)})
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .build();`,
  );
  return path;
}

interface Fixture {
  root: string;
  ctx: PipelineContext;
  path: string;
  dir: string;
}

function fixture(prefix: string, ticket: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket });
  const path = pipelineFile(root);
  const dir = resolveRunDir("p", ticket, undefined, true, ctx);
  return { root, ctx, path, dir };
}

/** Open the run at `dir` through recording stores; returns the run and its writes. */
async function open(
  f: Fixture,
  ticket: string,
  extra: { allowUnmetered?: boolean; maxCostUsd?: number; budgetApproved?: boolean; ctx?: PipelineContext } = {},
) {
  const writes: Write[] = [];
  const ctx = extra.ctx ?? f.ctx;
  const run = await loadOrCreateRun(f.path, ticket, undefined, undefined, f.dir, false, undefined, ctx, {
    stateStore: new RecordingStateStore(ctx, ticket, "p", writes),
    eventStore: new RecordingEventStore(f.dir, writes),
    allowUnmetered: extra.allowUnmetered,
    maxCostUsd: extra.maxCostUsd,
    budgetApproved: extra.budgetApproved,
  });
  return { run, writes };
}

const snapshotAt = (dir: string) => readRunSnapshot(join(dir, "state.json"))!;
const journalTypes = (dir: string) => readRunEvents(dir).map((event) => event.type);

test("opening a new run writes its snapshot, then journals the start", async () => {
  const f = fixture("open-new-", "T-new");
  const { run, writes } = await open(f, "T-new", { maxCostUsd: 3, budgetApproved: true });

  expect(writes).toEqual(["snapshot RUNNING", "run.started"]);
  const snapshot = snapshotAt(f.dir);
  expect(snapshot).toMatchObject({
    schemaVersion: 1,
    runId: basename(f.dir),
    status: "RUNNING",
    max_cost_usd: 3,
    rootRunId: basename(f.dir),
    budgetScopeId: basename(f.dir),
    worktree: false,
    cwd: f.root,
  });
  // `--budget` on a fresh top-level run only sets its ceiling: no overrun to approve.
  expect(snapshot.budget_approved).toBeUndefined();
  expect(snapshot.allow_unmetered).toBeUndefined();
  expect(snapshot.steps.map((step) => [step.id, step.status])).toEqual([
    ["a", "pending"],
    ["b", "pending"],
  ]);
  expect(run.steps.every((step) => step.attempts.length === 0)).toBe(true);
});

test("opening a new authorized run journals the authorization after the start", async () => {
  const f = fixture("open-new-unmetered-", "T-newu");
  const { run, writes } = await open(f, "T-newu", { allowUnmetered: true });

  expect(writes).toEqual(["snapshot RUNNING", "run.started", "run.unmetered.authorized"]);
  expect(run.allow_unmetered).toBe(true);
  expect(snapshotAt(f.dir).allow_unmetered).toBe(true);
});

test("resuming an interrupted run journals the resume, then rewrites the snapshot as running", async () => {
  const f = fixture("open-interrupted-", "T-int");
  const { run } = await open(f, "T-int");
  updateStep(run, run.steps[0]!, "done");
  abortRun(run, "SIGINT");
  expect(snapshotAt(f.dir).status).toBe("ABORTED");
  const before = journalTypes(f.dir);

  const { run: resumed, writes } = await open(f, "T-int");

  expect(writes).toEqual(["run.resumed", "snapshot RUNNING"]);
  expect(journalTypes(f.dir)).toEqual([...before, "run.resumed"]);
  const snapshot = snapshotAt(f.dir);
  expect(snapshot.status).toBe("RUNNING");
  expect(snapshot.aborted).toBe(false);
  expect(snapshot.outcome).toBeUndefined();
  expect(snapshot.stopped_reason).toBeUndefined();
  expect(resumed.steps.map((step) => step.status)).toEqual(["done", "pending"]);
});

test("resuming after a crash during an attempt settles it, saves, then journals the resume and saves again", async () => {
  const f = fixture("open-crash-", "T-crash");
  const { run } = await open(f, "T-crash");
  const step = run.steps[0]!;
  updateStep(run, step, "running");
  appendRunEvent(run, "step.attempt.started", { stepId: "a", attempt: 1, kind: "step", logPath: "steps/a/1.log" });
  saveRun(run);

  const { run: resumed, writes } = await open(f, "T-crash");

  expect(writes).toEqual(["step.attempt.finished", "snapshot RUNNING", "run.resumed", "snapshot RUNNING"]);
  expect(resumed.steps[0]!.attempts.map((attempt) => [attempt.status, attempt.interrupted])).toEqual([
    ["failed", true],
  ]);
  // Loading it again finds the attempt closed: only the resume marker is added.
  const { writes: again } = await open(f, "T-crash");
  expect(again).toEqual(["run.resumed", "snapshot RUNNING"]);
});

test("reopening a terminal run from the same place writes nothing", async () => {
  const f = fixture("open-terminal-", "T-pass");
  const { run } = await open(f, "T-pass");
  for (const step of run.steps) updateStep(run, step, "done");
  finalizeRun(run, {});
  const bytes = readFileSync(join(f.dir, "state.json"), "utf-8");

  const { run: reopened, writes } = await open(f, "T-pass");

  expect(writes).toEqual([]);
  expect(reopened.status).toBe("PASS");
  expect(readFileSync(join(f.dir, "state.json"), "utf-8")).toBe(bytes);
});

test("reopening a terminal run from another place records the new place without journaling a resume", async () => {
  const f = fixture("open-terminal-moved-", "T-moved");
  const { run } = await open(f, "T-moved");
  for (const step of run.steps) updateStep(run, step, "done");
  finalizeRun(run, {});
  const elsewhere = mkdtempSync(join(tmpdir(), "open-terminal-moved-wt-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: elsewhere, ticket: "T-moved" });

  const { writes } = await open(f, "T-moved", { ctx });

  expect(writes).toEqual(["snapshot PASS"]);
  expect(snapshotAt(f.dir)).toMatchObject({ status: "PASS", cwd: elsewhere });
});

test("resuming with a new authorization journals it before the resume, with one snapshot for each", async () => {
  const f = fixture("open-authorize-", "T-auth");
  const { run } = await open(f, "T-auth");
  abortRun(run, "SIGINT");

  const { run: resumed, writes } = await open(f, "T-auth", { allowUnmetered: true });

  expect(writes).toEqual(["run.unmetered.authorized", "snapshot RUNNING", "run.resumed", "snapshot RUNNING"]);
  expect(resumed.allow_unmetered).toBe(true);
  // Applied once: the next resume finds it persisted and journals nothing new.
  const { writes: again } = await open(f, "T-auth", { allowUnmetered: true });
  expect(again).toEqual(["run.resumed", "snapshot RUNNING"]);
});

test("a composed child resumed on its own with --run keeps its lineage and refuses an authorization its scope withheld", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-child-run-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "C-1" });
  const childPath = pipelineFile(root, "child");
  const dir = resolveRunDir("child", "C-1", undefined, true, ctx);
  const child = await loadOrCreateRun(childPath, "C-1", undefined, undefined, dir, false, undefined, ctx, {
    maxCostUsd: 2,
    parentRunId: "parent-1",
    parentNodeId: "node",
    rootRunId: "root-1",
    budgetScopeId: "root-1",
    budgetApproved: true,
  });
  expect(child.budget_approved).toBe(true);
  updateStep(child, child.steps[0]!, "done");
  abortRun(child, "SIGTERM");

  // What the entry point does for `--run <id>`: a strict selection, then the boot.
  const explicit = selectExplicitRun("child", "C-1", basename(dir), ctx);
  const writes: Write[] = [];
  const resumed = await loadOrCreateRun(childPath, "C-1", undefined, undefined, explicit.dir, false, undefined, ctx, {
    stateStore: new RecordingStateStore(ctx, "C-1", "child", writes),
    eventStore: new RecordingEventStore(explicit.dir, writes),
    allowUnmetered: true,
    strictSnapshot: explicit.strictSnapshot,
  });
  explicit.commit();

  expect(writes).toEqual(["run.resumed", "snapshot RUNNING"]);
  expect(resumed).toMatchObject({
    status: "RUNNING",
    parentRunId: "parent-1",
    parentNodeId: "node",
    rootRunId: "root-1",
    budgetScopeId: "root-1",
    max_cost_usd: 2,
    budget_approved: true,
  });
  expect(resumed.allow_unmetered).toBeUndefined();
  expect(resumed.steps.map((step) => step.status)).toEqual(["done", "pending"]);
});

test("a composed child records the worktree its parent runs in", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-child-worktree-"));
  pipelineFile(root, "child");
  const parentPath = join(root, "parent.ts");
  writeFileSync(
    parentPath,
    `export default ({ pipeline, runPipeline }) => pipeline("parent")
  .add(runPipeline({ id: "call", name: "Call", pipeline: "./child.ts" }))
  .build();`,
  );
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "W-1" });
  const previous = process.env.RUNNER_IN_WORKTREE;
  // The worktree boot step sets the flag after its `chdir`, and the entry point
  // passes the same answer to the parent's boot.
  process.env.RUNNER_IN_WORKTREE = "1";
  try {
    const parent = await loadOrCreateRun(
      parentPath,
      "W-1",
      undefined,
      undefined,
      join(root, "parent-run"),
      true,
      undefined,
      ctx,
      {
        worktree: true,
      },
    );
    finalizeRun(
      parent,
      await executeRunSteps(parent, "W-1", undefined, { resuming: false }, stepLoopDeps(NULL_RUN_OUTPUT), ctx),
    );
    expect(parent.status).toBe("PASS");
    const ref = parent.steps[0]!.orchestration!.children[0]!;
    const child = readRunSnapshot(join(pipelineRunsDir("child", "W-1", ctx), ref.runId!, "state.json"))!;
    expect(child).toMatchObject({ worktree: true, cwd: root, parentRunId: parent.runId });
  } finally {
    if (previous === undefined) delete process.env.RUNNER_IN_WORKTREE;
    else process.env.RUNNER_IN_WORKTREE = previous;
  }
});
