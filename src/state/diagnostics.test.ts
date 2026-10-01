import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textArtifact } from "../dsl/artifact.js";
import type { PersistedRun } from "../model/persisted.js";
import {
  createLogRef,
  type LogRef,
  type RunLogStore,
  type RunStateSnapshot,
  type RunStateStore,
} from "../model/storage-ports.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { diagnoseRunJournals, inspectTicket, logsForTicket } from "./diagnostics.js";
import { recordApproval } from "./decisions.js";

function snapshot(runId: string, pipeline: string, updatedAt: string): PersistedRun {
  return {
    schemaVersion: 1,
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
  expect(inspected).toContain("journal: 1 event, 1 invalid, 1 skipped (1 live-feed line ignored)");
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
  expect(inspected).toContain("journal: 2 events, ok (2 live-feed lines ignored)\n");
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

  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("journal: 1 event, ok\n");
});

test("inspectTicket says so when a run has no readable journal", async () => {
  const stateStore = new FakeStateStore([{ state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z") }]);

  expect(await inspectTicket(context, "PROJ-1", undefined, { stateStore })).toContain("journal: —");
});

test("inspectTicket names an unreadable journal instead of counting it as empty", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "diagnose-journal-unreadable-"));
  mkdirSync(join(runDir, "events.jsonl"));
  const stateStore = new FakeStateStore([
    { state: snapshot("feature-latest", "feature", "2026-07-03T00:00:00.000Z"), runDir },
  ]);

  const [diagnostic] = diagnoseRunJournals(context, "PROJ-1", { stateStore });
  expect(diagnostic?.readError).toMatch(/EISDIR/);
  expect(diagnostic).toMatchObject({ known: 0, unknown: 0, invalid: 0, skipped: 0 });

  const inspected = await inspectTicket(context, "PROJ-1", undefined, { stateStore });
  expect(inspected).toContain("journal: unreadable — ");
  expect(inspected).not.toContain("journal: —");
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
