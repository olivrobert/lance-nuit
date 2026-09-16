import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MODEL } from "../../engine/backends/codex/types.js";
import type { Run } from "../../model/run.js";
import { createLogRef, type RunLogStore } from "../../model/storage-ports.js";
import { makeRunStep } from "../run-step.js";
import { appendRunEvent } from "../run-journal.js";
import { buildRunStatsEntry, emitRunStats } from "./run-stats.js";

function fakeRun(overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    runId: "20260711T090000.000Z-bugfix-abcdef",
    name: "bugfix PROJ-238",
    ticket: "PROJ-238",
    pipeline: "bugfix",
    pipeline_path: "pipelines/bugfix.ts",
    run_dir: ".lance-nuit/work-items/PROJ-238/runs/bugfix/20260711T090000.000Z-bugfix-abcdef",
    steps: [
      makeRunStep(
        { id: "implement", name: "Implementation", command: "x", profile: "coder" },
        {
          status: "done",
          started_at: "2026-07-11T09:00:10.000Z",
          finished_at: "2026-07-11T09:10:00.000Z",
          control: { duration_ms: 590_000, total_cost_usd: 2.1, model: "claude-opus-4-8" },
          usage: {
            input_tokens: 50,
            output_tokens: 30_000,
            cache_read_tokens: 400_000,
            cache_creation_tokens: 60_000,
          },
        },
      ),
      makeRunStep(
        { id: "checks", name: "Checks", command: "x", profile: "reviewer" },
        {
          status: "failed",
          retries: 2,
          started_at: "2026-07-11T09:10:00.000Z",
          finished_at: "2026-07-11T09:20:00.000Z",
          control: { duration_ms: 600_000, total_cost_usd: 0.4, model: "claude-sonnet-4-6" },
          usage: {
            input_tokens: 10,
            output_tokens: 5_000,
            cache_read_tokens: 100_000,
            cache_creation_tokens: 10_000,
          },
        },
      ),
      makeRunStep({ id: "commit", name: "Commit", command: "x" }),
    ],
    ...overrides,
  } as Run;
}

test("buildRunStatsEntry: validates the contract", () => {
  const e = buildRunStatsEntry(fakeRun());
  expect(e.runId).toBe("20260711T090000.000Z-bugfix-abcdef");
  expect(e.pipeline).toBe("bugfix");
  expect(e.ticket).toBe("PROJ-238");
  expect(e.ticketDir).toBe("PROJ-238");
  expect(e.status).toBe("FAIL");
  expect(e.failPhase).toBe("checks");
  expect(e.startedAt).toBe("2026-07-11T09:00:10.000Z");
  expect(e.endedAt).toBe("2026-07-11T09:20:00.000Z");
  // Steps without stats (pending/skipped) are absent from phases.
  expect(Object.keys(e.phases)).toEqual(["implement", "checks"]);
  expect(e.phases.implement).toEqual({
    agents: 1,
    fixLoops: 0,
    profile: "coder",
    costUsd: 2.1,
    tokens: { in: 50, out: 30_000, cacheRead: 400_000, cacheWrite: 60_000 },
  });
  expect(e.phases.checks.fixLoops).toBe(0); // No attempt fact: retries alone is not enough.
  expect(e.totals).toEqual({ in: 60, out: 35_000, cacheRead: 500_000, cacheWrite: 70_000 });
  expect(e.models["claude-opus-4-8"].out).toBe(30_000);
  expect(e.models["claude-sonnet-4-6"].out).toBe(5_000);
  expect(e.costUsd).toBeCloseTo(2.5, 10);
  expect(e.profiles).toEqual({
    coder: {
      steps: 1,
      costUsd: 2.1,
      tokens: { in: 50, out: 30_000, cacheRead: 400_000, cacheWrite: 60_000 },
    },
    reviewer: {
      steps: 1,
      costUsd: 0.4,
      tokens: { in: 10, out: 5_000, cacheRead: 100_000, cacheWrite: 10_000 },
    },
  });
  // No real events: the historical retries counter must not invent facts.
  expect(e.fixEvents).toEqual([]);
  expect(e.commit).toBeNull(); // buildRunStatsEntry leaves commit to emitRunStats.
  expect(e.failReason).toBeNull(); // Failed step without errors -> no reason.
});

test("buildRunStatsEntry: validates the contract", () => {
  const run = fakeRun();
  (run.steps[1] as { errors?: string }).errors = "Skill `creating-commit-message` not found";
  const e = buildRunStatsEntry(run);
  expect(e.failPhase).toBe("checks");
  expect(e.failReason).toBe("Skill `creating-commit-message` not found");
});

test("buildRunStatsEntry accepte has log store logique without localPath: validates the contract", () => {
  const logStore: RunLogStore = {
    allocate: (run, stepId, attempt) => createLogRef(run, stepId, attempt),
    append: () => undefined,
    read: () => "log distant",
  };
  const run = fakeRun({ logStore });
  run.steps[1]!.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "failed",
      started_at: "2026-07-11T09:10:00.000Z",
      finished_at: "2026-07-11T09:20:00.000Z",
      log_path: "steps/checks/attempt-001/output.log",
    },
  ];

  const entry = buildRunStatsEntry(run);

  expect(entry.status).toBe("FAIL");
  expect(entry.outcome.logPath).toBe("steps/checks/attempt-001/output.log");
});

test("buildRunStatsEntry: validates the contract", () => {
  const e = buildRunStatsEntry(fakeRun({ ticket: "PROJ-59-01" }));
  expect(e.ticketDir).toBe("PROJ-59/US-01");
});

test("buildRunStatsEntry: validates the contract", () => {
  const run = fakeRun();
  run.steps[1].status = "done";
  run.steps[2].status = "skipped";
  expect(buildRunStatsEntry(run).status).toBe("PASS");
  expect(buildRunStatsEntry(run).failPhase).toBeNull();

  const stopped = fakeRun({ stopped_reason: "triage → escalade" });
  stopped.steps[1].status = "skipped";
  stopped.steps[2].status = "skipped";
  expect(buildRunStatsEntry(stopped).status).toBe("STOPPED");

  expect(buildRunStatsEntry(fakeRun({ aborted: true })).status).toBe("ABORTED");
});

test("buildRunStatsEntry: validates the contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "runstats-aborted-"));
  const run = fakeRun({
    run_dir: runDir,
    status: "ABORTED",
    aborted: true,
    updatedAt: "2026-07-31T20:45:00.000Z",
  });
  const step = run.steps[0]!;
  step.status = "aborted";
  step.finished_at = "2026-07-31T20:45:00.000Z";
  step.control = { duration_ms: 100, model: CODEX_MODEL.GPT_5_6_LUNA, provider: "codex", cost_estimated: true };
  step.usage = undefined;
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "aborted",
      started_at: "2026-07-31T20:40:00.000Z",
      finished_at: "2026-07-31T20:45:00.000Z",
      log_path: "steps/implement/attempt-001/output.log",
      control: { duration_ms: 100, model: CODEX_MODEL.GPT_5_6_LUNA, provider: "codex", cost_estimated: true },
    },
  ];

  const entry = buildRunStatsEntry(run);

  expect(entry.status).toBe("ABORTED");
  expect(entry.usageStatus).toBe("unavailable");
  expect(entry.costStatus).toBe("unavailable");
  expect(entry.phases.implement).toMatchObject({
    provider: "codex",
    usageStatus: "unavailable",
    costStatus: "unavailable",
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  });
  expect(entry.warnings).toContainEqual({
    phase: "implement",
    reason: "usage/cost unavailable or partial: attempt interrupted before its usage report",
  });
});

test("buildRunStatsEntry: validates the contract", () => {
  const run = fakeRun();
  for (const s of run.steps) if (s.control) delete s.control.total_cost_usd;
  expect(buildRunStatsEntry(run).costUsd).toBeUndefined();
});

test("buildRunStatsEntry: an unpriced step marks the run cost as a lower bound", () => {
  const run = fakeRun();
  const [priced, unpriced] = run.steps;
  priced!.control = { duration_ms: 100, total_cost_usd: 1.5, model: "claude-opus-4-5", provider: "claude" };
  unpriced!.control = { duration_ms: 100, model: "mystery-model", provider: "opencode", cost_unknown: true };
  unpriced!.usage = { input_tokens: 1000, output_tokens: 200 };

  const entry = buildRunStatsEntry(run);

  // The priced spend is still summed; nothing is invented for the other step.
  expect(entry.costUsd).toBeCloseTo(1.5);
  expect(entry.costUnknown).toBe(true);
  expect(entry.costStatus).toBe("unavailable");
  expect(entry.phases[unpriced!.id]).toMatchObject({ costUnknown: true, costStatus: "unavailable" });
  expect(entry.phases[priced!.id]?.costUnknown).toBeUndefined();
});

test("emitRunStats: validates the contract", () => {
  const projRoot = mkdtempSync(join(tmpdir(), "runstats-"));
  mkdirSync(join(projRoot, ".lance-nuit/work-items/PROJ-238"), { recursive: true });

  const written = emitRunStats(fakeRun(), { projRoot });

  const centralPath = join(projRoot, ".lance-nuit/pipeline-history/runs.jsonl");
  expect(written).toBe(centralPath);
  const lines = readFileSync(centralPath, "utf-8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]!);
  expect(entry.costUsd).toBeCloseTo(2.5, 10);
  expect(entry.profiles.coder.costUsd).toBeCloseTo(2.1, 10);
  expect(existsSync(join(projRoot, ".lance-nuit/work-items/PROJ-238/run-stats"))).toBe(false);
});

test("run-stats: validates the integration contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "rstats-"));
  const runDir = join(dir, "run");
  mkdirSync(runDir, { recursive: true });
  const checksLog = join(runDir, "steps/checks/attempt-002/output.log");
  mkdirSync(join(runDir, "steps/checks/attempt-002"), { recursive: true });
  writeFileSync(checksLog, `${"x".repeat(500)}\nStatic analysis: 3 errors`);
  const run = fakeRun({
    run_dir: runDir,
    steps: [
      makeRunStep(
        { id: "implement", name: "Impl", command: "x" },
        {
          status: "done",
          retries: 1,
          started_at: "2026-07-11T09:00:00.000Z",
          finished_at: "2026-07-11T09:10:00.000Z",
          attempts: [
            {
              attempt: 1,
              kind: "step",
              status: "done",
              started_at: "2026-07-11T09:00:00.000Z",
              finished_at: "2026-07-11T09:10:00.000Z",
              log_path: "steps/implement/attempt-001/output.log",
            },
          ],
        },
      ),
      makeRunStep(
        { id: "checks", name: "Checks", command: "x" },
        {
          status: "failed",
          retries: 2,
          started_at: "2026-07-11T09:10:00.000Z",
          finished_at: "2026-07-11T09:20:00.000Z",
          control: { duration_ms: 1 },
          attempts: [
            {
              attempt: 1,
              kind: "step",
              status: "failed",
              started_at: "2026-07-11T09:10:00.000Z",
              finished_at: "2026-07-11T09:15:00.000Z",
              log_path: "steps/checks/attempt-001/output.log",
            },
            {
              attempt: 2,
              kind: "fix",
              status: "failed",
              started_at: "2026-07-11T09:15:00.000Z",
              finished_at: "2026-07-11T09:20:00.000Z",
              log_path: "steps/checks/attempt-002/output.log",
            },
          ],
        },
      ),
    ],
  });
  const entry = buildRunStatsEntry(run);
  expect(entry.fixEvents).toHaveLength(2); // Two actual failed check attempts.
  expect(entry.phases.checks.fixLoops).toBe(1); // One actual fix pass (attempt 2).
  const [e1, e2] = entry.fixEvents as Array<{
    kind: string;
    phase: string;
    iter: number;
    contract: string;
    details: string | null;
  }>;
  expect(e1).toMatchObject({ kind: "fail", phase: "checks", iter: 1, contract: "checks" });
  expect(e2).toMatchObject({
    kind: "fix",
    phase: "checks",
    iter: 2,
    contract: "checks",
    logPath: "steps/checks/attempt-002/output.log",
  });
  expect(e2.details).toContain("Static analysis: 3 errors");
  expect((e2.details as string).length).toBeLessThanOrEqual(300);
});

test("run-stats: validates the integration contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "rstats-events-"));
  const run = fakeRun({
    run_dir: dir,
    steps: [
      makeRunStep(
        { id: "checks", name: "Checks", command: "x" },
        {
          status: "failed",
          retries: 99,
          control: { duration_ms: 1 },
        },
      ),
    ],
  });
  appendRunEvent(run, "step.attempt.started", { stepId: "checks", attempt: 1, kind: "step" });
  appendRunEvent(run, "step.attempt.finished", { stepId: "checks", attempt: 1, kind: "step", status: "failed" });
  appendRunEvent(run, "step.attempt.started", { stepId: "checks", attempt: 2, kind: "fix" });
  appendRunEvent(run, "step.attempt.finished", { stepId: "checks", attempt: 2, kind: "fix", status: "done" });

  const entry = buildRunStatsEntry(run);
  expect(entry.phases.checks.fixLoops).toBe(1);
  expect(entry.fixEvents).toMatchObject([{ kind: "fail", phase: "checks", iter: 1, contract: "checks" }]);
});

test("models attribute tokens per attempt: validates the contract", () => {
  const run = fakeRun({
    steps: [
      makeRunStep(
        { id: "checks", name: "Checks", command: "x", profile: "reviewer" },
        {
          status: "done",
          control: { duration_ms: 2, total_cost_usd: 0.3, model: "claude-opus" },
          usage: { input_tokens: 30, output_tokens: 300 },
          attempts: [
            {
              attempt: 1,
              kind: "step",
              status: "failed",
              started_at: "2026-07-11T09:10:00.000Z",
              finished_at: "2026-07-11T09:11:00.000Z",
              log_path: "steps/checks/attempt-001/output.log",
              control: { duration_ms: 1, total_cost_usd: 0.1, model: "claude-sonnet" },
              usage: { input_tokens: 10, output_tokens: 100 },
            },
            {
              attempt: 2,
              kind: "fix",
              status: "done",
              started_at: "2026-07-11T09:11:00.000Z",
              finished_at: "2026-07-11T09:12:00.000Z",
              log_path: "steps/checks/attempt-002/output.log",
              control: { duration_ms: 1, total_cost_usd: 0.2, model: "claude-opus" },
              usage: { input_tokens: 20, output_tokens: 200 },
            },
          ],
        },
      ),
    ],
  });

  const entry = buildRunStatsEntry(run);
  expect(entry.models).toEqual({
    "claude-sonnet": { in: 10, out: 100, cacheRead: 0, cacheWrite: 0 },
    "claude-opus": { in: 20, out: 200, cacheRead: 0, cacheWrite: 0 },
  });
});

test("run-stats: validates the integration contract", () => {
  const proj = mkdtempSync(join(tmpdir(), "rstats-git-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x", { cwd: proj });
  mkdirSync(join(proj, ".lance-nuit/work-items/PROJ-238"), { recursive: true });
  const runDir = join(proj, ".lance-nuit/work-items/PROJ-238/runs/bugfix/20260711T090000.000Z-bugfix-abcdef");
  mkdirSync(runDir, { recursive: true });
  const jsonPath = emitRunStats(fakeRun({ run_dir: runDir }), { projRoot: proj });
  const entry = JSON.parse(readFileSync(jsonPath!, "utf-8").trim().split("\n").at(-1)!);
  expect(entry.commit).toMatch(/^[0-9a-f]{7,}$/);

  const noGit = mkdtempSync(join(tmpdir(), "rstats-nogit-"));
  mkdirSync(join(noGit, ".lance-nuit/work-items/PROJ-238"), { recursive: true });
  const runDir2 = join(noGit, ".lance-nuit/work-items/PROJ-238/runs/bugfix/20260711T090000.000Z-bugfix-abcdef");
  mkdirSync(runDir2, { recursive: true });
  const jsonPath2 = emitRunStats(fakeRun({ run_dir: runDir2 }), { projRoot: noGit });
  expect(JSON.parse(readFileSync(jsonPath2!, "utf-8").trim().split("\n").at(-1)!).commit).toBeNull();
});

test("run-stats: validates the integration contract", () => {
  const proj = mkdtempSync(join(tmpdir(), "rstats-ev-"));
  mkdirSync(join(proj, ".lance-nuit/work-items/PROJ-238"), { recursive: true });
  const runDir = join(proj, ".lance-nuit/work-items/PROJ-238/runs/bugfix/20260711T090000.000Z-bugfix-abcdef");
  mkdirSync(runDir, { recursive: true });
  const jsonPath = emitRunStats(fakeRun({ run_dir: runDir }), { projRoot: proj });
  expect(
    existsSync(join(proj, ".lance-nuit/work-items/PROJ-238/run-stats/20260711T090000.000Z-bugfix-abcdef.events.jsonl")),
  ).toBe(false);
  expect(readFileSync(jsonPath!, "utf-8").trim().split("\n")).toHaveLength(1);
});
