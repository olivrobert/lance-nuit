import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../../model/run.ts";
import { buildPipelineContext } from "../../pipeline/context.ts";
import { makeRunStep } from "../run-step.ts";
import { readRunEvents } from "../run-journal.ts";
import { findStepLog, matchesStepSelector, nextAttemptLogPath } from "../run-timeline.ts";
import { controlForRun } from "../cost-accounting.ts";
import { loadOrCreateRun } from "../../boot/resume.ts";
import { saveRun } from "../run-repository.ts";
import { stepLogPath } from "../run-timeline.ts";
import { abortRun, updateStep } from "../run-transitions.ts";
import { isResumable, isRunComplete } from "./run-storage.ts";
import { commandRegistries } from "../../commands/registries.js";

function writeRun(obj: any): string {
  const dir = mkdtempSync(join(tmpdir(), "resume-"));
  const f = join(dir, "default.json");
  writeFileSync(
    f,
    JSON.stringify({ schemaVersion: 1, runId: "fixture-run", name: "default", pipeline: "default", ...obj }),
  );
  return f;
}

test("pending steps are resumable: validates the contract", () => {
  const f = writeRun({
    steps: [
      { id: "a", status: "done" },
      { id: "b", status: "pending" },
    ],
  });
  expect(isResumable(f)).toBe(true);
});

test("manually aborted runs with pending steps are resumable: validates the contract", () => {
  const f = writeRun({ aborted: true, steps: [{ id: "b", status: "pending" }] });
  expect(isResumable(f)).toBe(true);
});

test("runs whose outcome opted out of resume are discarded: validates the contract", () => {
  const f = writeRun({
    aborted: true,
    outcome: { phase: "b", reason: "SIGINT", logPath: null, resumable: false },
    steps: [{ id: "b", status: "pending" }],
  });
  expect(isResumable(f)).toBe(false);
});

test("persistence: validates the integration contract", () => {
  const f = writeRun({
    steps: [
      { id: "a", status: "done" },
      { id: "b", status: "failed" },
    ],
  });
  expect(isResumable(f)).toBe(true);
});

test("interrupted running steps are resumable: validates the contract", () => {
  const f = writeRun({ steps: [{ id: "a", status: "running" }] });
  expect(isResumable(f)).toBe(true);
});

test("completed runs are not resumable: validates the contract", () => {
  const f = writeRun({
    steps: [
      { id: "a", status: "done" },
      { id: "b", status: "skipped" },
    ],
  });
  expect(isResumable(f)).toBe(false);
});

test("aborted runs with a failed step are resumable: validates the contract", () => {
  const f = writeRun({ aborted: true, steps: [{ id: "b", status: "failed" }] });
  expect(isResumable(f)).toBe(true);
});

test("persistence: validates the integration contract", () => {
  expect(isResumable(join(tmpdir(), "nope-does-not-exist.json"))).toBe(false);
});

test("isRunComplete: validates the contract", () => {
  const f = writeRun({
    steps: [
      { id: "a", status: "done" },
      { id: "b", status: "skipped" },
    ],
  });
  expect(isRunComplete(f)).toBe(true);
});

test("isRunComplete: validates the contract", () => {
  expect(
    isRunComplete(
      writeRun({
        steps: [
          { id: "a", status: "done" },
          { id: "b", status: "pending" },
        ],
      }),
    ),
  ).toBe(false);
  expect(isRunComplete(writeRun({ steps: [{ id: "a", status: "failed" }] }))).toBe(false);
});

test("isRunComplete: validates the contract", () => {
  expect(isRunComplete(writeRun({ aborted: true, steps: [{ id: "a", status: "done" }] }))).toBe(false);
  expect(isRunComplete(writeRun({ steps: [] }))).toBe(false);
  expect(isRunComplete(null)).toBe(false);
  expect(isRunComplete(join(tmpdir(), "nope.json"))).toBe(false);
});

function writeCorrupt(): string {
  const dir = mkdtempSync(join(tmpdir(), "corrupt-"));
  const f = join(dir, "state.json");
  writeFileSync(f, '{"name": "default", "steps": [{"id": "a", "st');
  return f;
}

test("isResumable: validates the contract", () => {
  expect(isResumable(writeCorrupt())).toBe(false);
});

test("isRunComplete: validates the contract", () => {
  expect(isRunComplete(writeCorrupt())).toBe(false);
});

function writePipelineFixture(dir: string): string {
  const p = join(dir, "pipeline-fixture.ts");
  writeFileSync(
    p,
    `export default ({ pipeline, bashStep }) => pipeline("default").add(bashStep({ id: "a", name: "A", command: "true" })).build();\n`,
  );
  return p;
}

function writeMultiStepFixture(dir: string): string {
  const p = join(dir, "pipeline-multi.ts");
  writeFileSync(
    p,
    `export default ({ pipeline, bashStep }) => pipeline("default")` +
      `.add(bashStep({ id: "a", name: "A", command: "true" }))` +
      `.add(bashStep({ id: "b", name: "B", command: "true" }))` +
      `.add(bashStep({ id: "c", name: "C", command: "true" }))` +
      `.build();\n`,
  );
  return p;
}

function writeQualityFixture(dir: string): string {
  const p = join(dir, "pipeline-quality.ts");
  writeFileSync(
    p,
    `export default ({ pipeline, bashStep }) => {` +
      `const p = pipeline("default");` +
      `for (const name of ["format", "static-analysis", "dependencies", "tests", "mutation"]) p.add(bashStep({ id: "quality." + name, name, command: "true" }));` +
      `return p.add(bashStep({ id: "commit", name: "Commit", command: "true" })).build();` +
      `};\n`,
  );
  return p;
}

function writeWorkItemBudgetFixture(dir: string): string {
  const p = join(dir, "pipeline-work-items.ts");
  writeFileSync(
    p,
    `export default ({ pipeline, bashStep }) => pipeline("work-items")` +
      `.forEachWorkItem({ queue: "featureTodo", scan: { limit: 3 }, maxCostPerWorkItemUsd: 7, do: [bashStep({ id: "body", name: "Body", command: "true" })] })` +
      `.build();\n`,
  );
  return p;
}

test("loadOrCreateRun rejects an existing corrupt snapshot instead of initializing over it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startat-"));
  const pipelinePath = writeMultiStepFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);

  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    false,
    "b",
    buildPipelineContext(commandRegistries()),
  );
  const byId = Object.fromEntries(run.steps.map((s) => [s.id, s.status]));
  expect(byId).toEqual({ a: "skipped", b: "pending", c: "pending" });
});

test("loadOrCreateRun: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startat-bad-"));
  const pipelinePath = writeMultiStepFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);

  await expect(
    loadOrCreateRun(
      pipelinePath,
      undefined,
      undefined,
      undefined,
      runDir,
      false,
      "nope",
      buildPipelineContext(commandRegistries()),
    ),
  ).rejects.toThrow(/not found/);
});

test("matchesStepSelector: validates the contract", () => {
  expect(matchesStepSelector("quality.static-analysis", "quality")).toBe(true);
  expect(matchesStepSelector("quality.static-analysis", "quality.*")).toBe(true);
  expect(matchesStepSelector("refactoring-quality.static-analysis", "quality")).toBe(false);
  expect(matchesStepSelector("quality.static-analysis", "quality.static-analysis")).toBe(true);
});

test("loadOrCreateRun: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-filter-"));
  const pipelinePath = writeQualityFixture(dir);
  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    ["quality"],
    undefined,
    join(dir, "run"),
    true,
    undefined,
    buildPipelineContext(commandRegistries()),
  );
  expect(run.steps.filter((step) => step.status === "pending").map((step) => step.id)).toEqual([
    "quality.format",
    "quality.static-analysis",
    "quality.dependencies",
    "quality.tests",
    "quality.mutation",
  ]);
});

test("maxCostPerWorkItemUsd: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-item-budget-runs-"));
  const pipelinePath = writeWorkItemBudgetFixture(dir);
  const firstContext = buildPipelineContext({ ...commandRegistries(), cwd: dir, ticket: "PROJ-1" });
  const secondContext = buildPipelineContext({ ...commandRegistries(), cwd: dir, ticket: "PROJ-2" });

  const first = await loadOrCreateRun(
    pipelinePath,
    "PROJ-1",
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    firstContext,
  );
  const second = await loadOrCreateRun(
    pipelinePath,
    "PROJ-2",
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    secondContext,
  );

  expect(first.max_cost_usd).toBe(7);
  expect(second.max_cost_usd).toBe(7);
  expect(first.run_dir).not.toBe(second.run_dir);
});

test("loadOrCreateRun: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corrupt-load-"));
  const pipelinePath = writePipelineFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "state.json"), '{"steps": [{"id"');

  await expect(
    loadOrCreateRun(
      pipelinePath,
      undefined,
      undefined,
      undefined,
      runDir,
      undefined,
      undefined,
      buildPipelineContext(commandRegistries()),
    ),
  ).rejects.toThrow(/invalid JSON/);
  expect(readFileSync(join(runDir, "state.json"), "utf-8")).toBe('{"steps": [{"id"');
});

test("loadOrCreateRun: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-resume-"));
  const pipelinePath = writePipelineFixture(dir);
  const ticket = "PROJ-42";
  const context = buildPipelineContext({ ...commandRegistries(), cwd: dir, ticket });

  const first = await loadOrCreateRun(pipelinePath, ticket, undefined, undefined, undefined, false, undefined, context);
  expect(first.steps[0]?.status).toBe("pending");

  updateStep(first, first.steps[0]!, "failed", "failure to resume");
  const resumed = await loadOrCreateRun(
    pipelinePath,
    ticket,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    context,
  );

  expect(resumed.runId).toBe(first.runId);
  expect(resumed.run_dir).toBe(first.run_dir);
  expect(resumed.steps[0]).toMatchObject({ status: "failed", errors: "failure to resume" });

  // A SIGINT abort resumes by default: completed work is kept, nothing restarts
  // from scratch unless the outcome explicitly opted out (resumable: false).
  abortRun(resumed, "SIGINT");
  const afterAbort = await loadOrCreateRun(
    pipelinePath,
    ticket,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    context,
  );

  expect(afterAbort.runId).toBe(first.runId);
  expect(afterAbort.run_dir).toBe(first.run_dir);
  expect(afterAbort.steps[0]).toMatchObject({ status: "failed", errors: "failure to resume" });
});

test("AUDIT #1: validates the contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-loss-"));
  const pipelinePath = writePipelineFixture(dir); // pipeline "default", step bash "a"
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "hydrate-loss",
      name: "default",
      pipeline: "default",
      pipeline_path: pipelinePath,
      status: "ABORTED",
      aborted: true,
      outcome: { phase: "a", reason: "SIGINT: run interrupted manually", logPath: null, resumable: false },
      steps: [{ id: "a", status: "failed", retries: 1, errors: "boom: assertion failed" }],
    }),
  );

  // loadOrCreateRun hydrates and THEN persists (saveRun), a round trip that used
  // to lose errors before the hydrate fix.
  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    undefined,
    undefined,
    buildPipelineContext(commandRegistries()),
  );
  expect(run.steps[0].errors).toBe("boom: assertion failed");

  // `aborted` describes the previous run's termination, not a durable state. If
  // rehydrated unchanged, isAborted() (step-loop) would be true on the first step
  // and recovery would execute nothing. hydrate() exists to resume a live run.
  expect(run.aborted).toBe(false);
  expect(run.status).toBe("RUNNING");
  expect(run.outcome).toBeUndefined();

  const reread = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(reread.steps[0].errors).toBe("boom: assertion failed");
  expect(reread.aborted).toBe(false);
});

test("hydrate: an ABORTED run whose steps are all settled loads as live so it can be finalized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-aborted-settled-"));
  const pipelinePath = writePipelineFixture(dir); // pipeline "default", step bash "a"
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "aborted-settled",
      name: "default",
      pipeline: "default",
      pipeline_path: pipelinePath,
      // Ctrl+C after the last step snapshot but before finalizeRun: abortRun
      // found no step running, so it stamped ABORTED over a fully settled run.
      status: "ABORTED",
      aborted: true,
      outcome: { phase: null, reason: "SIGINT: run interrupted manually", logPath: null, resumable: true },
      steps: [{ id: "a", status: "done", retries: 0 }],
    }),
  );

  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    undefined,
    undefined,
    buildPipelineContext(commandRegistries()),
  );

  // Loaded as terminal, this run could never be finalized: a top-level resume
  // would start a new directory and replay every step, and a child run would
  // fail its parent on every attempt.
  expect(run.status).toBe("RUNNING");
  expect(run.aborted).toBe(false);
  expect(run.outcome).toBeUndefined();
  expect(run.steps[0]!.status).toBe("done");
});

test("hydrate: an ABORTED settled run that opted out of resuming stays terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-aborted-optout-"));
  const pipelinePath = writePipelineFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "aborted-optout",
      name: "default",
      pipeline: "default",
      pipeline_path: pipelinePath,
      status: "ABORTED",
      aborted: true,
      outcome: { phase: null, reason: "SIGINT: run interrupted manually", logPath: null, resumable: false },
      steps: [{ id: "a", status: "done", retries: 0 }],
    }),
  );

  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    undefined,
    undefined,
    buildPipelineContext(commandRegistries()),
  );

  expect(run.status).toBe("ABORTED");
  expect(run.aborted).toBe(true);
});

test("hydrate derives live totals from steps instead of a stale finalized aggregate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-stats-"));
  const pipelinePath = writePipelineFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "hydrate-stats",
      name: "default",
      pipeline: "default",
      pipeline_path: pipelinePath,
      total_control: { duration_ms: 100, total_cost_usd: 0.1 },
      total_usage: { output_tokens: 40 },
      steps: [
        {
          id: "a",
          status: "failed",
          retries: 1,
          control: { duration_ms: 100, total_cost_usd: 0.4 },
          usage: { output_tokens: 40 },
        },
      ],
    }),
  );

  const run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    undefined,
    undefined,
    buildPipelineContext(commandRegistries()),
  );
  expect(run.steps[0]).toMatchObject({
    control: { duration_ms: 100, total_cost_usd: 0.4 },
    usage: { output_tokens: 40 },
  });
  expect(run.total_control).toBeUndefined();
  expect(run.total_usage).toBeUndefined();
  expect(controlForRun(run).total_cost_usd).toBe(0.4);

  const reread = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(reread.steps[0].control).toEqual({ duration_ms: 100, total_cost_usd: 0.4 });
  expect(reread.total_control).toBeUndefined();
});

test("loadOrCreateRun refuses to erase a persisted step removed from the definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-definition-drift-"));
  const pipelinePath = writePipelineFixture(dir);
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "definition-drift",
      name: "default",
      pipeline: "default",
      status: "FAIL",
      steps: [
        { id: "a", status: "pending", retries: 0 },
        { id: "removed-paid-step", status: "done", retries: 0, control: { duration_ms: 1, total_cost_usd: 2 } },
      ],
    }),
  );

  expect(
    loadOrCreateRun(
      pipelinePath,
      undefined,
      undefined,
      undefined,
      runDir,
      undefined,
      undefined,
      buildPipelineContext(commandRegistries()),
    ),
  ).rejects.toThrow("removed or renamed persisted step(s): removed-paid-step");
  const unchanged = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(unchanged.steps).toHaveLength(2);
});

test("last_attempt prevents log-number reuse when the journal is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "attempt-counter-"));
  const run = makeRun(dir);
  const step = run.steps[0]!;
  step.last_attempt = 4;
  step.attempts = [];

  expect(nextAttemptLogPath(run, step)).toContain("attempt-005");
  saveRun(run);
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  expect(saved.steps[0].last_attempt).toBe(5);
});

test("saveRun: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [makeRunStep({ id: "a", name: "A", command: "x", runner: "bash" })],
  };
  saveRun(run);
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
  expect(saved.steps[0].id).toBe("a");
  expect(existsSync(join(dir, "p.json.tmp"))).toBe(false);
});

test("abortRun: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "abort-bookkeeping-"));
  const run = makeRun(dir);
  run.runId = "abort-bookkeeping";
  const step = run.steps[1]!;
  const started = new Date(Date.now() - 25).toISOString();
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "running",
      started_at: started,
      log_path: "steps/spec/attempt-001/output.log",
    },
  ];

  abortRun(run, "SIGINT");

  expect(run.status).toBe("ABORTED");
  expect(run.aborted).toBe(true);
  expect(step.status).toBe("aborted");
  expect(step.finished_at).toBeDefined();
  expect(step.errors).toContain("SIGINT");
  expect(step.attempts?.[0]).toMatchObject({ status: "aborted", errors: "SIGINT: run interrupted manually" });
  expect(step.attempts?.[0]?.finished_at).toBeDefined();
  expect(step.control?.cost_estimated).toBe(true);
  expect(step.usage).toBeUndefined();
  expect(run.total_usage).toBeUndefined();
  expect(readRunEvents(dir).map((event) => event.type)).toEqual([
    "step.attempt.finished",
    "step.status.changed",
    "run.aborted",
  ]);
  // The aborted step is actionable again on the next invocation.
  expect(isResumable(join(dir, "state.json"))).toBe(true);
});

test("abortRun: an agent attempt killed without a live estimate is flagged cost_unknown, not free", () => {
  const dir = mkdtempSync(join(tmpdir(), "abort-unpriced-"));
  const run = makeRun(dir);
  run.runId = "abort-unpriced";
  const step = run.steps[1]!;
  step.status = "running";
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "running",
      started_at: new Date().toISOString(),
      log_path: "steps/x/attempt-001/output.log",
    },
  ];

  abortRun(run, "SIGINT");

  expect(step.attempts?.[0]?.control).toMatchObject({ cost_estimated: true, cost_unknown: true });
  expect(step.attempts?.[0]?.control?.total_cost_usd).toBeUndefined();
  expect(step.control).toMatchObject({ cost_unknown: true });
  expect(run.total_control?.cost_unknown).toBe(true);
});

test("abortRun: a live estimate charges the attempt and clears the unknown flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "abort-estimated-"));
  const run = makeRun(dir);
  run.runId = "abort-estimated";
  const step = run.steps[1]!;
  step.status = "running";
  step.control = { duration_ms: 10, total_cost_usd: 0.2 };
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "running",
      started_at: new Date().toISOString(),
      log_path: "steps/x/attempt-001/output.log",
    },
  ];

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.05 });

  expect(step.attempts?.[0]?.control?.total_cost_usd).toBeCloseTo(0.05);
  expect(step.attempts?.[0]?.control?.cost_unknown).toBeUndefined();
  expect(step.control?.total_cost_usd).toBeCloseTo(0.25);
  expect(step.control?.cost_unknown).toBeUndefined();
});

test("abortRun: a bash step spends nothing; its fix pass is an agent and does", () => {
  const bashDir = mkdtempSync(join(tmpdir(), "abort-bash-"));
  const bash = makeRun(bashDir);
  bash.runId = "abort-bash";
  const bashStep = bash.steps[0]!;
  bashStep.status = "running";
  bashStep.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "running",
      started_at: new Date().toISOString(),
      log_path: "steps/x/attempt-001/output.log",
    },
  ];
  abortRun(bash, "SIGINT");
  expect(bashStep.control?.cost_unknown).toBeUndefined();

  const fixDir = mkdtempSync(join(tmpdir(), "abort-bash-fix-"));
  const fix = makeRun(fixDir);
  fix.runId = "abort-bash-fix";
  const fixed = fix.steps[0]!;
  fixed.status = "running";
  fixed.attempts = [
    {
      attempt: 2,
      kind: "fix",
      status: "running",
      started_at: new Date().toISOString(),
      log_path: "steps/x/attempt-001/output.log",
    },
  ];
  abortRun(fix, "SIGINT");
  expect(fixed.attempts?.[0]?.control).toMatchObject({ cost_unknown: true });
});

test("abortRun persists an interruption before a step starts running", () => {
  const dir = mkdtempSync(join(tmpdir(), "abort-admission-"));
  const run = makeRun(dir);
  run.runId = "abort-admission";
  run.steps[1]!.status = "pending";

  abortRun(run, "SIGTERM");

  expect(run).toMatchObject({
    status: "ABORTED",
    aborted: true,
    outcome: {
      phase: null,
      reason: "SIGTERM: run interrupted manually",
      logPath: null,
      resumable: true,
    },
  });
  expect(run.steps[1]!.status).toBe("pending");
  expect(readRunEvents(dir).map((event) => event.type)).toEqual(["run.aborted"]);
  expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"))).toMatchObject({
    status: "ABORTED",
    aborted: true,
    steps: [{ status: "done" }, { status: "pending" }, { status: "pending" }],
  });
});

test("updateStep: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "running-timestamp-"));
  const run = makeRun(dir);
  const step = run.steps[1]!;
  step.status = "failed";
  step.finished_at = "2026-07-31T20:00:00.000Z";

  updateStep(run, step, "running");

  expect(step.started_at).toBeDefined();
  expect(step.finished_at).toBeUndefined();
});

function makeRun(dir: string): Run {
  return {
    name: "feat",
    pipeline: "feat",
    pipeline_path: "feat.ts",
    run_dir: dir,
    steps: [
      makeRunStep({ id: "triage", name: "T", command: "x", runner: "bash" }, { status: "done" }),
      makeRunStep(
        { id: "spec", name: "S", command: "x", runner: "agent", backend: { id: "claude" } },
        { status: "running" },
      ),
      makeRunStep({ id: "commit", name: "C", command: "x", runner: "bash" }),
    ],
  };
}

test("stepLogPath: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-"));
  const run = makeRun(dir);
  expect(stepLogPath(run, run.steps[0])).toBe(join(dir, "steps", "triage", "attempt-001", "output.log"));
  expect(stepLogPath(run, run.steps[2])).toBe(join(dir, "steps", "commit", "attempt-001", "output.log"));
  expect(existsSync(join(dir, "steps", "triage", "attempt-001"))).toBe(true);
});

test("findStepLog: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-find-"));
  const run = makeRun(dir);
  const p = stepLogPath(run, run.steps[1]);
  writeFileSync(p, "log spec");
  expect(findStepLog(dir, "feat", "spec")).toBe(p);
});

test("findStepLog: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-flat-"));
  writeFileSync(join(dir, "spec.log"), "previous");
  expect(findStepLog(dir, "feat", "spec")).toBe(null);
});

test("findStepLog: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-none-"));
  mkdirSync(join(dir, "steps", "feat"), { recursive: true });
  writeFileSync(join(dir, "steps", "feat", "01-triage-guard.log"), "x");
  expect(findStepLog(dir, "feat", "triage")).toBe(null);
  expect(findStepLog(dir, "feat", "triage-guard")).toBe(null);
});

test("saveRun: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-save-"));
  const run = makeRun(dir);
  saveRun(run);
  expect(existsSync(join(dir, "state.json"))).toBe(true);
  expect(existsSync(join(dir, "feat.timeline.md"))).toBe(false);
});
