import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { textArtifact } from "../../definition/dsl/artifact.js";
import type { PersistedAttempt, PersistedRun } from "../../run/persisted.js";
import { closureOf, writeClosureAt } from "../../run/record/closure.js";
import {
  createLogRef,
  type LogRef,
  type RunLogStore,
  type RunStateSnapshot,
  type RunStateStore,
} from "../../run/storage-ports.js";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import { diagnoseRunJournals, inspectTicket, logsForTicket } from "./diagnostics-readers.js";
import { recordApproval, recordRejection } from "../../work-items/store/decisions.js";
import { workItemLayout } from "../../work-items/store/layout.js";

function snapshot(runId: string, pipeline: string, updatedAt: string): PersistedRun {
  return {
    schemaVersion: 2,
    runId,
    name: pipeline,
    pipeline,
    ticket: "PROJ-1",
    updatedAt,
    status: "PASS",
    steps: [
      {
        id: "quality.tests",
        status: "done",
        retries: 0,
      },
    ],
  };
}

class FakeStateStore implements RunStateStore {
  readonly latestCalls: Array<{ pipeline: string; ticket?: string }> = [];

  constructor(readonly snapshots: RunStateSnapshot[]) {}

  load(runId: string): PersistedRun | null {
    return this.snapshots.find((entry) => entry.state.runId === runId)?.state ?? null;
  }

  loadLatest(pipeline: string, ticket?: string): PersistedRun | null {
    this.latestCalls.push({ pipeline, ticket });
    return (
      this.snapshots
        .filter((entry) => entry.state.pipeline === pipeline && entry.state.ticket === ticket)
        .sort((left, right) => (right.state.updatedAt ?? "").localeCompare(left.state.updatedAt ?? ""))[0]?.state ??
      null
    );
  }

  save(): void {}

  listSnapshots(): RunStateSnapshot[] {
    return this.snapshots;
  }
}

class FakeLogStore implements RunLogStore {
  readonly reads: string[] = [];

  allocate(run: Parameters<typeof createLogRef>[0], stepId: string, attempt: number): LogRef {
    return createLogRef(run, stepId, attempt);
  }

  append(): void {}

  findLatest(run: Parameters<typeof createLogRef>[0], stepId: string): LogRef | null {
    return createLogRef(run, stepId, 1);
  }

  read(log: LogRef): string | null {
    this.reads.push(`${log.run.runId}:${log.stepId}:${log.attempt}`);
    return "tests depuis le store\n";
  }
}

const context = buildPipelineContext({ cwd: "/virtual/no-filesystem", ticket: "PROJ-1" });

test("diagnostics: validates the integration contract", async () => {
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-old", "feature", "2026-07-01T00:00:00.000Z") },
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") },
    { state: snapshot("quality-latest", "quality", "2026-07-02T00:00:00.000Z") },
  ]);

  const output = await inspectTicket(context, "PROJ-1", undefined, { stateStore });

  expect(output).toContain("Run feature-latest");
  expect(output).toContain("Run quality-latest");
  expect(output).not.toContain("Run feature-old");
  expect(stateStore.latestCalls.map(({ pipeline }) => pipeline)).toEqual(["feature", "quality"]);
});

test("inspectTicket lists child runs under their parent instead of as standalone latest runs", async () => {
  const child = (runId: string, updatedAt: string, lotId: string, title: string): PersistedRun => ({
    ...snapshot(runId, "implement-lot", updatedAt),
    parentRunId: "plan-latest",
    lot: { id: lotId, title, risk: 0, steps: [], dependsOn: [], acceptanceCriteria: [] },
  });
  const stateStore = new FakeStateStore([
    { state: snapshot("plan-latest", "implement-plan", "2026-07-03T00:00:00.000Z") },
    { state: child("lot-run-1", "2026-07-03T00:10:00.000Z", "lot-1", "Lot 1 — schema") },
    {
      state: {
        ...child("lot-run-2", "2026-07-03T00:20:00.000Z", "lot-2", "Lot 2 — loader"),
        status: "FAIL",
        steps: [{ id: "implement", status: "failed", retries: 0, errors: "boom\nmore" }],
      },
    },
  ]);

  const output = await inspectTicket(context, "PROJ-1", undefined, { stateStore });

  const lines = output.split("\n");
  expect(lines[0]).toBe("Run plan-latest");
  const first = lines.indexOf("  PASS      implement-lot Lot 1 — schema (lot-run-1)");
  const second = lines.indexOf("  FAIL      implement-lot Lot 2 — loader (lot-run-2) — implement: boom");
  expect(first).toBeGreaterThan(0);
  expect(second).toBe(first + 1);
  expect(output).not.toContain("Run lot-run-1");
  expect(stateStore.latestCalls.map(({ pipeline }) => pipeline)).toEqual(["implement-plan"]);
});

test("inspectTicket keeps an orphan child run (parent snapshot gone) as a top-level run", async () => {
  const stateStore = new FakeStateStore([
    { state: { ...snapshot("lot-orphan", "implement-lot", "2026-07-03T00:00:00.000Z"), parentRunId: "vanished" } },
  ]);
  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("Run lot-orphan");
});

test("logsForTicket reads logs through the fake store: validates the contract", () => {
  const stateStore = new FakeStateStore([{ state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") }]);
  const logStore = new FakeLogStore();

  const output = logsForTicket(context, "PROJ-1", "quality.tests", undefined, { stateStore, logStore });

  expect(output).toContain("tests depuis le store");
  expect(logStore.reads).toEqual(["feature-latest:quality.tests:1"]);
});

test("logsForTicket rejects symlinks outside the run directory: validates the contract", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-symlink-"));
  const runDir = join(root, "run");
  const attemptDir = join(runDir, "steps", "quality.tests", "attempt-001");
  mkdirSync(attemptDir, { recursive: true });
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "secret hors run\n");
  symlinkSync(secret, join(attemptDir, "output.log"));

  const stateStore = new FakeStateStore([
    {
      state: snapshot("feature-symlink", "feature", "2026-07-03T00:00:00.000Z"),
      runDir,
    },
  ]);
  const output = logsForTicket(context, "PROJ-1", "quality.tests", undefined, { stateStore });

  expect(output).toBe("No logs found for quality.tests.");
  expect(output).not.toContain("secret hors run");
});

test("diagnoseRunJournals reports what the journal contract kept, refused and ignored", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "diagnose-journal-"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "PROJ-1" }),
      // The live feed writes into the same file: outside the contract, kept.
      JSON.stringify({ ts: "2026-07-01T00:00:01.000Z", type: "step.started", index: 1, total: 1 }),
      // A contracted type with no step id: an attempt the projection cannot key.
      JSON.stringify({ ts: "2026-07-01T00:00:02.000Z", type: "step.attempt.started", attempt: 1 }),
      "{broken",
      "",
    ].join("\n"),
  );
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z"), runDir },
  ]);

  const [diagnostic] = diagnoseRunJournals(context, "PROJ-1", { stateStore });

  expect(diagnostic).toMatchObject({
    pipeline: "feature",
    runId: "feature-latest",
    runDir,
    known: 1,
    unknown: 1,
    invalid: 1,
    skipped: 1,
  });
  expect(Object.keys(diagnostic?.invalidByType ?? {})).toEqual(["step.attempt.started"]);
  expect(diagnostic?.invalidByType["step.attempt.started"]).toMatchObject({ count: 1 });

  // The counters are reachable from `--inspect`, not only from the API: a reader
  // told about them in the guide must have a command that prints them.
  const inspected = await inspectTicket(context, "PROJ-1", undefined, { stateStore });
  expect(inspected).toContain("journal: 1 event, 1 invalid, 1 skipped (1 uncontracted line ignored)");
  expect(inspected).toContain("refused: step.attempt.started ×1 —");
});

test("inspectTicket reports a healthy journal as ok, with the live feed as ignored lines", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "diagnose-journal-healthy-"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "PROJ-1" }),
      JSON.stringify({ ts: "2026-07-01T00:00:00.500Z", type: "run.started", pipeline: "feature", ticket: "PROJ-1" }),
      JSON.stringify({ ts: "2026-07-01T00:00:01.000Z", type: "step.started", index: 1, total: 1 }),
      JSON.stringify({ ts: "2026-07-01T00:00:02.000Z", type: "step.started", index: 1, total: 1 }),
      "",
    ].join("\n"),
  );
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z"), runDir },
  ]);

  const inspected = await inspectTicket(context, "PROJ-1", undefined, { stateStore });
  expect(inspected).toContain("journal: 2 events (2 uncontracted lines ignored)\n");
  expect(inspected).not.toContain("refused:");
});

test("inspectTicket omits the ignored lines when the journal holds no live feed", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "diagnose-journal-no-feed-"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", type: "run.started", pipeline: "feature", ticket: "PROJ-1" }) +
      "\n",
  );
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z"), runDir },
  ]);

  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("journal: 1 event\n");
});

test("inspectTicket says so when a run has no readable journal", async () => {
  const stateStore = new FakeStateStore([{ state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") }]);

  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("journal: —");
});

test("inspectTicket reads an unreadable journal as an empty one", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "diagnose-journal-unreadable-"));
  mkdirSync(join(runDir, "events.jsonl"));
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z"), runDir },
  ]);

  const [diagnostic] = diagnoseRunJournals(context, "PROJ-1", { stateStore });
  expect(diagnostic?.readError).toBeUndefined();
  expect(diagnostic).toMatchObject({ known: 0, unknown: 0, invalid: 0, skipped: 0 });

  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("journal: —");
});

test("inspectTicket tells whether the gate a stopped run waits on is already approved", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "inspect-approval-"));
  const base = buildPipelineContext();
  const ctx = buildPipelineContext({
    cwd,
    ticket: "PROJ-1",
    config: { ...base.config, specPath: ".lance-nuit/work-items" },
  });
  const plan = textArtifact("plan.md");
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  writeFileSync(ctx.paths.artifact("plan.md"), "# Plan\n");
  const stopped: PersistedRun = {
    ...snapshot("feature-stopped", "feature", "2026-07-03T00:00:00.000Z"),
    status: "STOPPED",
    outcome: {
      phase: "plan-gate",
      reason: "escalated: plan",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", detail: "plan" },
    },
  };
  const stateStore = new FakeStateStore([{ state: stopped }]);
  const inspect = () => inspectTicket(ctx, "PROJ-1", undefined, { stateStore });

  expect(await inspect()).toContain("approval: plan — none recorded\n");

  await recordApproval(ctx, "plan", plan);
  expect(await inspect()).toMatch(/approval: plan — current, by human on .+; resume the run without --approve\n/);

  writeFileSync(ctx.paths.artifact("plan.md"), "# Plan v2\n");
  expect(await inspect()).toMatch(/approval: plan — stale, the artifact changed since human on .+ approved it\n/);
});

test("inspectTicket tells whether a rejection still waits on its rework", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "inspect-rejection-"));
  const base = buildPipelineContext();
  const ctx = buildPipelineContext({
    cwd,
    ticket: "PROJ-1",
    config: { ...base.config, specPath: ".lance-nuit/work-items" },
  });
  const plan = textArtifact("plan.md");
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  writeFileSync(ctx.paths.artifact("plan.md"), "# Plan\n");
  const stopped: PersistedRun = {
    ...snapshot("feature-stopped", "feature", "2026-07-03T00:00:00.000Z"),
    status: "STOPPED",
    outcome: {
      phase: "plan-gate",
      reason: "escalated: plan",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", detail: "plan", reworkable: true },
    },
  };
  const stateStore = new FakeStateStore([{ state: stopped }]);
  const inspect = () => inspectTicket(ctx, "PROJ-1", undefined, { stateStore });

  await recordRejection(ctx, "plan", plan, "split step 2", 3);
  expect(await inspect()).toMatch(
    /approval: plan — rejected in round 1 by human on .+: split step 2; resume the run to rework it\n/,
  );

  writeFileSync(ctx.paths.artifact("plan.md"), "# Plan v2\n");
  expect(await inspect()).toContain(
    "approval: plan — reworked after rejection round 1; approve it or reject it again\n",
  );
});

function workItemContext(prefix: string) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const base = buildPipelineContext();
  return buildPipelineContext({
    cwd,
    ticket: "PROJ-1",
    config: { ...base.config, specPath: ".lance-nuit/work-items" },
  });
}

function attempt(n: number, kind: "step" | "fix" | "review", status: "done" | "failed"): PersistedAttempt {
  return { attempt: n, kind, status, started_at: "2026-07-03T00:00:00.000Z", log_path: "" };
}

test("B7: inspect shows spend, duration, place, lineage and each step's attempts from state.json", async () => {
  const fork: PersistedRun = {
    ...snapshot("feature-fork", "feature", "2026-07-03T00:00:00.000Z"),
    status: "FAIL",
    max_cost_usd: 15,
    inheritedSpendUsd: 3.42,
    forkedFrom: "feature-source",
    startAt: "plan",
    cwd: "/work/tree",
    worktree: true,
    steps: [
      {
        id: "plan",
        status: "done",
        retries: 0,
        control: { duration_ms: 90_000, total_cost_usd: 1.25 },
        attempts: [attempt(1, "step", "done"), attempt(2, "review", "done"), attempt(3, "fix", "failed")],
      },
      { id: "implement", status: "pending", retries: 0 },
    ],
  };
  const output = await inspectTicket(context, "PROJ-1", {}, { stateStore: new FakeStateStore([{ state: fork }]) });

  expect(output).toContain("forked from: feature-source at plan\n");
  expect(output).toContain("spend: $1.25 own, inherited $3.42; budget $15.00\n");
  expect(output).toContain("duration: 1m30s of attempts\n");
  expect(output).toContain("cwd: /work/tree (worktree)\n");
  expect(output).toContain("  done     plan (3 attempts, last fix failed)\n");
  expect(output).toContain("  pending  implement");
  expect(output).toContain("closed: no\n");
});

test("B7: inspect shows a superseded run and the fork that replaced it", async () => {
  const source: PersistedRun = {
    ...snapshot("feature-source", "feature", "2026-07-03T00:00:00.000Z"),
    status: "SUPERSEDED",
    supersededBy: "feature-fork",
  };
  const output = await inspectTicket(context, "PROJ-1", {}, { stateStore: new FakeStateStore([{ state: source }]) });
  expect(output).toContain("status: SUPERSEDED\n");
  expect(output).toContain("superseded by: feature-fork\n");
});

test("B7: inspect shows a dead RUNNING run as interrupted, and a current closure", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "inspect-dead-"));
  const dead: PersistedRun = { ...snapshot("feature-dead", "feature", "2026-07-03T00:00:00.000Z"), status: "RUNNING" };
  const closed: PersistedRun = { ...snapshot("quality-closed", "quality", "2026-07-03T00:00:00.000Z"), status: "FAIL" };
  const closedDir = mkdtempSync(join(tmpdir(), "inspect-closed-"));
  writeClosureAt(closedDir, closureOf(closed, "olivier", new Date("2026-07-04T00:00:00.000Z")));
  const stateStore = new FakeStateStore([
    { state: dead, runDir },
    { state: closed, runDir: closedDir },
  ]);

  const output = await inspectTicket(context, "PROJ-1", {}, { stateStore });

  expect(output).toContain("status: ABORTED (interrupted: the runner died without a verdict)\n");
  expect(output).not.toContain("status: RUNNING");
  expect(output).toContain("closed: by olivier on 2026-07-04T00:00:00.000Z\n");
});

test("B7: inspect marks a step whose stamp absorbed a failure, read from the work item's lock", async () => {
  const ctx = workItemContext("inspect-lock-");
  const lockPath = workItemLayout(ctx.paths.workItemDir!).lockPath;
  mkdirSync(dirname(lockPath), { recursive: true });
  const stamp = { pipeline: "feature", runId: "feature-latest", stampedAt: "2026-07-03T00:00:00.000Z", inputs: {} };
  writeFileSync(
    lockPath,
    JSON.stringify({ schemaVersion: 1, steps: { "quality.tests": { ...stamp, outputs: {}, absorbed: true } } }),
  );
  const stateStore = new FakeStateStore([{ state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") }]);

  expect(await inspectTicket(ctx, "PROJ-1", {}, { stateStore })).toContain("  done     quality.tests [absorbed]");

  writeFileSync(lockPath, "{ not json");
  expect(await inspectTicket(ctx, "PROJ-1", {}, { stateStore })).toContain("lock: unreadable — ");
});

test("B7: --pipeline keeps the runs of that pipeline, children whose parent runs another one included", async () => {
  const child: PersistedRun = {
    ...snapshot("lot-run", "implement-lot", "2026-07-03T00:10:00.000Z"),
    parentRunId: "feature-latest",
  };
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") },
    { state: snapshot("quality-latest", "quality", "2026-07-02T00:00:00.000Z") },
    { state: child },
  ]);
  const inspect = (selection: { runId?: string; pipeline: string }) =>
    inspectTicket(context, "PROJ-1", selection, { stateStore });

  const quality = await inspect({ pipeline: "quality" });
  expect(quality).toContain("Run quality-latest");
  expect(quality).not.toContain("Run feature-latest");
  expect(await inspect({ pipeline: "implement-lot" })).toContain("Run lot-run");
  expect(await inspect({ pipeline: "deploy" })).toBe("No run of pipeline deploy found for PROJ-1.");
  expect(await inspect({ runId: "feature-latest", pipeline: "quality" })).toBe(
    "Run feature-latest of pipeline quality not found for PROJ-1.",
  );
});

test("B7: --pipeline takes the path of the pipeline's file, as -p does", async () => {
  const quality: PersistedRun = {
    ...snapshot("quality-latest", "quality", "2026-07-02T00:00:00.000Z"),
    pipeline_path: ".lance-nuit/pipelines/quality.ts",
  };
  const renamed: PersistedRun = {
    ...snapshot("checks-latest", "checks", "2026-07-03T00:00:00.000Z"),
    pipeline_path: "pipelines/local-checks.ts",
  };
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") },
    { state: quality },
    { state: renamed },
  ]);
  const inspect = (pipeline: string) => inspectTicket(context, "PROJ-1", { pipeline }, { stateStore });

  const byStem = await inspect("./elsewhere/quality.ts");
  expect(byStem).toContain("Run quality-latest");
  expect(byStem).not.toContain("Run feature-latest");
  const byPath = await inspect(join(context.cwd, "pipelines/local-checks.ts"));
  expect(byPath).toContain("Run checks-latest");
  expect(byPath).not.toContain("Run quality-latest");
});

test("B7: the absorbed mark belongs to the run that wrote the stamp", async () => {
  const ctx = workItemContext("inspect-lock-other-");
  const lockPath = workItemLayout(ctx.paths.workItemDir!).lockPath;
  mkdirSync(dirname(lockPath), { recursive: true });
  const stamp = { pipeline: "feature", runId: "feature-older", stampedAt: "2026-07-03T00:00:00.000Z", inputs: {} };
  writeFileSync(
    lockPath,
    JSON.stringify({ schemaVersion: 1, steps: { "quality.tests": { ...stamp, outputs: {}, absorbed: true } } }),
  );
  const stateStore = new FakeStateStore([{ state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") }]);

  expect(await inspectTicket(ctx, "PROJ-1", {}, { stateStore })).not.toContain("[absorbed]");
});

test("B7: inspect lists a composed child of another work item from its parent's ref", async () => {
  const ref = { kind: "main" as const, pipeline: "feature", accountedCostUsd: 0 };
  const parent: PersistedRun = {
    ...snapshot("batch-latest", "batch", "2026-07-03T00:00:00.000Z"),
    steps: [
      {
        id: "each-ticket",
        status: "running",
        retries: 0,
        orchestration: {
          kind: "forEachPipeline",
          children: [
            { ...ref, key: "PROJ-2", ticket: "PROJ-2", runId: "r-2", status: "failed" },
            { ...ref, key: "PROJ-3", ticket: "PROJ-3", status: "pending" },
          ],
        },
      },
    ],
  };
  const output = await inspectTicket(context, "PROJ-1", {}, { stateStore: new FakeStateStore([{ state: parent }]) });

  expect(output).toContain("children:\n  failed    feature PROJ-2 (r-2)");
  expect(output).not.toContain("PROJ-3");
});

test("B7: a child on another work item whose runner died reads as interrupted, from its own snapshot", async () => {
  const ref = { kind: "main" as const, pipeline: "feature", accountedCostUsd: 0 };
  const parent: PersistedRun = {
    ...snapshot("batch-latest", "batch", "2026-07-03T00:00:00.000Z"),
    status: "FAIL",
    steps: [
      {
        id: "each-ticket",
        status: "failed",
        retries: 0,
        orchestration: {
          kind: "forEachPipeline",
          children: [{ ...ref, key: "PROJ-2", ticket: "PROJ-2", runId: "r-2", status: "running" }],
        },
      },
    ],
  };
  const child: PersistedRun = {
    ...snapshot("r-2", "feature", "2026-07-03T00:05:00.000Z"),
    ticket: "PROJ-2",
    status: "RUNNING",
    parentRunId: "batch-latest",
  };
  const childDir = mkdtempSync(join(tmpdir(), "inspect-foreign-child-"));
  const stateStore = new FakeStateStore([{ state: parent }, { state: child, runDir: childDir }]);
  stateStore.listSnapshots = (ticket?: string) =>
    stateStore.snapshots.filter((entry) => (entry.state.ticket ?? "PROJ-1") === (ticket ?? "PROJ-1"));

  const output = await inspectTicket(context, "PROJ-1", {}, { stateStore });

  expect(output).toContain("children:\n  ABORTED   feature PROJ-2 (r-2)");
});
