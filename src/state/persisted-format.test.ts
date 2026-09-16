import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { loadOrCreateRun } from "../boot/resume.js";
import { commandRegistries } from "../commands/registries.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { executeRunSteps, type StepLoopDeps } from "../step/step-loop.js";
import { assumptionsArtifact, lotsArtifact } from "../builtin-steps/lib/artifacts.js";
import { textArtifact } from "../dsl/artifact.js";
import { loadPipelineConfig } from "../env/config.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.js";
import type { Run } from "../model/run.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { makeRunStep } from "./run-step.js";
import { projectStepAttempts } from "./attempt-projection.js";
import {
  decisionMatchesArtifact,
  markDecisionApplied,
  readDecision,
  readDecisionAt,
  recordApproval,
} from "./decisions.js";
import { cleanLogs, inspectTicket, logsForTicket } from "./diagnostics.js";
import { appendRunEvent, readRunEvents } from "./run-journal.js";
import { emitRunStats } from "./stats/run-stats.js";
import { saveRun } from "./run-repository.js";
import { createRunId, latestRunFile, readRunFile, resolveRunDir } from "./stores/run-storage.js";

const refactoringArtifact = textArtifact("refactoring.md");

class FakeWorkItemArtifactStore implements WorkItemArtifactStore {
  private readonly values = new Map<string, string>();

  put(name: string, value: string): void {
    this.values.set(name, value);
  }

  async exists(ref: ArtifactRef): Promise<boolean> {
    return this.values.has(ref.name);
  }

  async readText(ref: ArtifactRef): Promise<string | undefined> {
    return this.values.get(ref.name);
  }

  async readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined> {
    const value = await this.readText(ref);
    return value === undefined ? undefined : parse(JSON.parse(value));
  }

  async writeText(ref: ArtifactRef, value: string): Promise<void> {
    this.put(ref.name, value);
  }

  async remove(ref: ArtifactRef): Promise<void> {
    this.values.delete(ref.name);
  }
}

function contextFor(root: string, ticket = "PROJ-1") {
  return buildPipelineContext({
    cwd: root,
    ticket,
    config: { ...loadPipelineConfig(root), specPath: ".lance-nuit/work-items" },
  });
}

function runFor(root: string, ticket = "PROJ-1", runDir = join(root, "run")): Run {
  return {
    schemaVersion: 1,
    runId: "20260731T120000.000Z-feature-abcdef",
    name: "feature",
    ticket,
    pipeline: "feature",
    pipeline_path: "pipelines/feature.ts",
    run_dir: runDir,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:01.000Z",
    status: "PASS",
    outcome: { phase: null, reason: null, logPath: null, resumable: false },
    steps: [
      makeRunStep(
        { id: "quality.tests", name: "Tests", command: "true", runner: "bash" },
        { status: "done", started_at: "2026-07-31T12:00:00.000Z", finished_at: "2026-07-31T12:00:01.000Z" },
      ),
    ],
  };
}

test("persisted format: a damaged latest snapshot is never replaced implicitly", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-storage-"));
  const ctx = contextFor(root);

  expect(createRunId("feature", new Date("2026-07-30T07:15:36.145Z"), "12345678-1234-1234-1234-1234567890ab")).toBe(
    "20260730T071536.145Z-feature-123456",
  );

  const featureDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const feature = runFor(root, "PROJ-1", featureDir);
  feature.status = "FAIL";
  feature.outcome = {
    phase: "quality.tests",
    reason: "tests failed",
    logPath: "steps/quality.tests/attempt-001/output.log",
    resumable: true,
  };
  feature.steps[0]!.status = "failed";
  saveRun(feature);

  const resumedFeatureDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const qualityDir = resolveRunDir("quality", "PROJ-1", undefined, false, ctx);

  expect(resumedFeatureDir).toBe(featureDir);
  expect(qualityDir).not.toBe(featureDir);
  expect(readlinkSync(join(root, ".lance-nuit/work-items/PROJ-1/runs/feature/latest"))).toBe(basename(featureDir));
  expect(readlinkSync(join(root, ".lance-nuit/work-items/PROJ-1/runs/quality/latest"))).toBe(basename(qualityDir));
  expect(latestRunFile("feature", "PROJ-1", ctx)).toBe(join(featureDir, "state.json"));
  expect(latestRunFile("quality", "PROJ-1", ctx)).toBe(join(qualityDir, "state.json"));
  expect(existsSync(join(featureDir, "feature.json"))).toBe(false);
  expect(readRunFile(join(featureDir, "state.json"))?.schemaVersion).toBe(1);
});

test("persisted format: the stop cause and the run location round-trip without a schema bump", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-stop-location-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  run.status = "STOPPED";
  run.stopped_reason = "escalated: plan needs a decision";
  run.outcome = {
    phase: "plan-gate",
    reason: "escalated: plan needs a decision",
    logPath: null,
    resumable: true,
    stop: { subject: "plan", kind: "needs-decision", detail: "plan needs a decision" },
  };
  run.worktree = true;
  run.cwd = join(root, "worktree");
  saveRun(run);

  const saved = readRunFile(join(runDir, "state.json"))!;
  expect(saved.schemaVersion).toBe(1);
  expect(saved.outcome?.stop).toEqual({ subject: "plan", kind: "needs-decision", detail: "plan needs a decision" });
  expect(saved.worktree).toBe(true);
  expect(saved.cwd).toBe(join(root, "worktree"));

  // The fields are optional: a snapshot that omits them still reads.
  const minimal = runFor(root, "PROJ-1", resolveRunDir("minimal", "PROJ-1", undefined, false, ctx));
  saveRun(minimal);
  const savedMinimal = readRunFile(join(minimal.run_dir, "state.json"))!;
  expect(savedMinimal.schemaVersion).toBe(1);
  expect(savedMinimal.outcome?.stop).toBeUndefined();
  expect(savedMinimal.worktree).toBeUndefined();
  expect(savedMinimal.cwd).toBeUndefined();
});

test("persisted format: the cost stop kind round-trips, and a snapshot written without it still reads", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-stopkind-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  run.status = "FAIL";
  run.outcome = {
    phase: "implement",
    reason: "process killed: budget exceeded ($0.11 estimated > $0.05 remaining)",
    logPath: null,
    resumable: true,
    failKind: "technical",
    stopKind: "budget-exceeded",
  };
  saveRun(run);

  const saved = readRunFile(join(runDir, "state.json"))!;
  expect(saved.schemaVersion).toBe(1);
  expect(saved.outcome?.stopKind).toBe("budget-exceeded");
  // Additive and optional, so no schema bump: an outcome written before the field
  // existed still validates, and reads as "no cost stop claimed".
  const minimal = runFor(root, "PROJ-1", resolveRunDir("minimal-stopkind", "PROJ-1", undefined, false, ctx));
  minimal.status = "FAIL";
  minimal.outcome = { phase: "implement", reason: "exit 1", logPath: null, resumable: true };
  saveRun(minimal);
  const savedMinimal = readRunFile(join(minimal.run_dir, "state.json"))!;
  expect(savedMinimal.schemaVersion).toBe(1);
  expect(savedMinimal.outcome?.reason).toBe("exit 1");
  expect(savedMinimal.outcome?.stopKind).toBeUndefined();
});

test("persisted format: fail_cause round-trips on the step and the outcome, and a snapshot without it still reads", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-failcause-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  run.status = "FAIL";
  run.steps[0]!.status = "failed";
  run.steps[0]!.fail_kind = "verdict";
  run.steps[0]!.fail_cause = "blocked";
  run.steps[0]!.errors = "the release branch does not exist";
  run.outcome = {
    phase: "quality.tests",
    reason: "the release branch does not exist",
    logPath: null,
    resumable: true,
    failKind: "verdict",
    failCause: "blocked",
  };
  saveRun(run);

  const saved = readRunFile(join(runDir, "state.json"))!;
  expect(saved.schemaVersion).toBe(1);
  expect(saved.steps?.[0]?.fail_cause).toBe("blocked");
  expect(saved.outcome?.failCause).toBe("blocked");
  // And a resume restores it: the hydrated step carries the cause the snapshot
  // holds, so a report written after the resume still names the block.
  const resumed = makeRunStep(
    { id: "quality.tests", name: "Tests", command: "true", runner: "bash" },
    saved.steps![0]!,
  );
  expect(resumed.fail_cause).toBe("blocked");

  // Additive and optional, so no schema bump: a snapshot written before the
  // field existed still validates, and reads as "no such cause".
  const minimal = runFor(root, "PROJ-1", resolveRunDir("minimal-failcause", "PROJ-1", undefined, false, ctx));
  minimal.status = "FAIL";
  minimal.steps[0]!.status = "failed";
  minimal.steps[0]!.fail_kind = "technical";
  minimal.outcome = { phase: "quality.tests", reason: "exit 1", logPath: null, resumable: true, failKind: "technical" };
  saveRun(minimal);
  const savedMinimal = readRunFile(join(minimal.run_dir, "state.json"))!;
  expect(savedMinimal.schemaVersion).toBe(1);
  expect(savedMinimal.steps?.[0]?.fail_kind).toBe("technical");
  expect(savedMinimal.steps?.[0]?.fail_cause).toBeUndefined();
  expect(savedMinimal.outcome?.failCause).toBeUndefined();
});

test("persisted format: keeps a RUNNING snapshot with all steps settled for finalization", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-final-step-window-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  run.status = "RUNNING";
  run.outcome = undefined;
  saveRun(run);

  const selected = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);

  expect(selected).toBe(runDir);
});

test("persisted format: validates the contract", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-journal-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  const step = run.steps[0]!;

  expect(readRunEvents(runDir)).toEqual([]);

  const firstLog = join(runDir, "steps", "quality.tests", "attempt-001", "output.log");
  const secondLog = join(runDir, "steps", "quality.tests", "attempt-002", "output.log");
  mkdirSync(join(runDir, "steps", "quality.tests", "attempt-001"), { recursive: true });
  writeFileSync(firstLog, "first attempt\n");
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "failed",
      started_at: "2026-07-31T12:00:00.000Z",
      finished_at: "2026-07-31T12:00:00.500Z",
      log_path: "steps/quality.tests/attempt-001/output.log",
    },
  ];
  mkdirSync(join(runDir, "steps", "quality.tests", "attempt-002"), { recursive: true });
  writeFileSync(secondLog, "second attempt\n");
  step.attempts.push({
    attempt: 2,
    kind: "step",
    status: "done",
    started_at: "2026-07-31T12:00:01.000Z",
    finished_at: "2026-07-31T12:00:01.500Z",
    log_path: "steps/quality.tests/attempt-002/output.log",
  });
  appendRunEvent(run, "step.attempt.started", { stepId: step.id, attempt: 1 });
  appendRunEvent(run, "step.attempt.finished", { stepId: step.id, attempt: 1, status: "failed" });
  appendRunEvent(run, "step.attempt.started", { stepId: step.id, attempt: 2 });
  appendRunEvent(run, "step.attempt.finished", { stepId: step.id, attempt: 2, status: "done" });
  saveRun(run);

  const saved = readRunFile(join(runDir, "state.json"));
  expect(saved?.schemaVersion).toBe(1);
  expect(saved?.runId).toBe(run.runId);
  // The snapshot no longer carries the attempts; the journal projects them back.
  expect((saved?.steps[0] as Record<string, unknown> | undefined)?.attempts).toBeUndefined();
  expect(projectStepAttempts(readRunEvents(runDir)).get(step.id)).toHaveLength(2);
  expect(readFileSync(firstLog, "utf-8")).toContain("first attempt");
  expect(readFileSync(secondLog, "utf-8")).toContain("second attempt");
  const events = readRunEvents(runDir);
  expect(events[0]).toMatchObject({ type: "step.attempt.started", stepId: step.id, attempt: 1 });
  expect(events.map((event) => event.type)).toEqual([
    "step.attempt.started",
    "step.attempt.finished",
    "step.attempt.started",
    "step.attempt.finished",
  ]);
  expect(readFileSync(join(runDir, "events.jsonl"), "utf-8").split("\n").filter(Boolean)).toHaveLength(4);
});

test("persisted format: validates the contract", () => {
  for (const snapshot of ["absent", "corrompu"] as const) {
    const root = mkdtempSync(join("/tmp", `pipeline-state-latest-${snapshot}-`));
    const ctx = contextFor(root);
    const firstDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
    const run = runFor(root, "PROJ-1", firstDir);
    run.status = "FAIL";
    run.steps[0]!.status = "failed";
    run.outcome = {
      phase: run.steps[0]!.id,
      reason: "tests failed",
      logPath: null,
      resumable: true,
    };
    saveRun(run);

    const statePath = join(firstDir, "state.json");
    if (snapshot === "absent") unlinkSync(statePath);
    else writeFileSync(statePath, "{ truncated snapshot");

    expect(() => resolveRunDir("feature", "PROJ-1", undefined, false, ctx)).toThrow(
      snapshot === "absent" ? /is missing/ : /invalid JSON/,
    );
    expect(readlinkSync(join(root, ".lance-nuit/work-items/PROJ-1/runs/feature/latest"))).toBe(basename(firstDir));
  }
});

test("persisted format: validates the contract", async () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-decision-"));
  const ctx = contextFor(root);
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  const lotsBody = (second: string) =>
    JSON.stringify({
      reason: "plan split",
      lots: [
        { id: "LOT-01", title: "Flux 1", risk: 1, steps: [1, 2], dependsOn: [], acceptanceCriteria: ["AC-1"] },
        {
          id: second,
          title: `Flux ${second}`,
          risk: 1,
          steps: [3],
          dependsOn: ["LOT-01"],
          acceptanceCriteria: ["AC-2"],
        },
      ],
    });
  writeFileSync(ctx.paths.artifact("lots.json"), lotsBody("LOT-02"));

  const decision = await recordApproval(ctx, "lots", lotsArtifact);
  expect(decision.artifact).toBe("artifacts/lots.json");
  expect(decision.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readDecision(ctx, "lots")?.decision).toBe("approved");
  expect(await decisionMatchesArtifact(ctx, "lots", lotsArtifact)).toBe(true);

  writeFileSync(ctx.paths.artifact("lots.json"), lotsBody("LOT-03"));
  expect(await decisionMatchesArtifact(ctx, "lots", lotsArtifact)).toBe(false);
});

test("persisted format: validates the contract", async () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-decision-store-"));
  const artifacts = new FakeWorkItemArtifactStore();
  const ctx = contextFor(root);
  const storeCtx = buildPipelineContext({
    cwd: root,
    ticket: "PROJ-1",
    config: ctx.config,
    artifacts,
  });
  const cases = [
    {
      subject: "lots",
      artifact: lotsArtifact,
      value: JSON.stringify({
        reason: "plan split",
        lots: [
          { id: "LOT-01", title: "Flux 1", risk: 1, steps: [1, 2], dependsOn: [], acceptanceCriteria: ["AC-1"] },
          { id: "LOT-02", title: "Flux 2", risk: 1, steps: [3], dependsOn: ["LOT-01"], acceptanceCriteria: ["AC-2"] },
        ],
      }),
    },
    { subject: "assumptions", artifact: assumptionsArtifact, value: JSON.stringify({ blocking: [] }) },
    { subject: "refactoring", artifact: refactoringArtifact, value: "# refactoring via store\n" },
  ] as const;

  for (const { subject, artifact, value } of cases) {
    const name = artifact.name;
    artifacts.put(name, value);
    const decision = await recordApproval(storeCtx, subject, artifact);
    expect(decision.artifactSha256).toBe(createHash("sha256").update(value).digest("hex"));
    expect(existsSync(storeCtx.paths.artifact(name))).toBe(false);
    expect(await decisionMatchesArtifact(storeCtx, subject, artifact)).toBe(true);
    if (subject === "refactoring") {
      expect((await markDecisionApplied(storeCtx, subject, artifact)).decision).toBe("applied");
    }

    artifacts.put(name, `${value}changed`);
    expect(await decisionMatchesArtifact(storeCtx, subject, artifact)).toBe(false);
  }
});

test("persisted format: validates the contract", () => {
  const dir = mkdtempSync(join("/tmp", "pipeline-state-invalid-decision-"));
  const decision = (overrides: Record<string, unknown>) => {
    const path = join(dir, `${Object.keys(overrides).join("-")}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        decision: "approved",
        subject: "assumptions",
        artifact: "artifacts/assumptions.json",
        artifactSha256: "a".repeat(64),
        decidedAt: "2026-07-31T00:00:00.000Z",
        decidedBy: "human",
        ...overrides,
      }),
    );
    return path;
  };

  expect(readDecisionAt(decision({ artifactSha256: "fixture" }))).toBeUndefined();
  expect(readDecisionAt(decision({ schemaVersion: 2 }))).toBeUndefined();
  expect(readDecisionAt(decision({ decision: "maybe" }))).toBeUndefined();
  // Any non-empty author is a valid decision: the dashboard signs approvals with
  // the name of the person who clicked, and rejecting those would keep the gate
  // closed on an approval that was granted.
  expect(readDecisionAt(decision({ decidedBy: "Olivier" }))?.decidedBy).toBe("Olivier");
  expect(readDecisionAt(decision({ decidedBy: "" }))).toBeUndefined();
  expect(readDecisionAt(decision({ decidedBy: 42 }))).toBeUndefined();
  expect(readDecisionAt(decision({ decidedAt: "hier" }))).toBeUndefined();
  // The subject becomes a filename under `decisions/`: a decision whose subject
  // contains characters outside the allowed charset must never be read back.
  expect(readDecisionAt(decision({ subject: "../escape" }))).toBeUndefined();
  // The same applies to `artifact`: it is an artifact name, never a path.
  expect(readDecisionAt(decision({ artifact: "../../etc/passwd" }))).toBeUndefined();
  expect(readDecisionAt(decision({ artifact: "assumptions.json" }))).toBeUndefined();
  // A well-formed decision passes; without this witness, the assertions above
  // could all pass for the wrong reason.
  expect(readDecisionAt(decision({}))?.subject).toBe("assumptions");
});

test("persisted format: validates the contract", async () => {
  // This identity check used to live in `readDecisionAt`, which knew the
  // hardcoded subject -> artifact mapping. The mapping now belongs to the
  // pipeline, so validation lives where the artifact is provided.
  const root = mkdtempSync(join("/tmp", "pipeline-state-decision-mismatch-"));
  const ctx = contextFor(root);
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  const body = JSON.stringify({ blocking: [] });
  writeFileSync(ctx.paths.artifact("assumptions.json"), body);
  mkdirSync(ctx.paths.decisionsDir!, { recursive: true });
  writeFileSync(
    join(ctx.paths.decisionsDir!, "assumptions.json"),
    JSON.stringify({
      schemaVersion: 1,
      decision: "approved",
      subject: "assumptions",
      // Correct hash, but it binds a DIFFERENT artifact from the subject's artifact.
      artifact: "artifacts/lots.json",
      artifactSha256: createHash("sha256").update(body).digest("hex"),
      decidedAt: "2026-07-31T00:00:00.000Z",
      decidedBy: "human",
    }),
  );

  expect(await decisionMatchesArtifact(ctx, "assumptions", assumptionsArtifact)).toBe(false);
});

test("persisted format: validates the contract", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-stats-"));
  const ctx = contextFor(root);
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  const logPath = join(runDir, "steps", "quality.tests", "attempt-001", "output.log");
  mkdirSync(join(runDir, "steps", "quality.tests", "attempt-001"), { recursive: true });
  writeFileSync(logPath, "tests passed\n");
  run.steps[0]!.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "done",
      started_at: run.createdAt!,
      finished_at: run.updatedAt!,
      log_path: "steps/quality.tests/attempt-001/output.log",
    },
  ];
  saveRun(run);

  const centralPath = emitRunStats(run, { projRoot: root, context: ctx });
  expect(centralPath).toBe(join(root, ".lance-nuit/pipeline-history/runs.jsonl"));
  expect(readFileSync(centralPath!, "utf-8").trim().split("\n")).toHaveLength(1);
  expect(existsSync(join(root, ".lance-nuit/work-items/PROJ-1/run-stats"))).toBe(false);
  expect(inspectTicket(ctx, "PROJ-1")).toContain(`Run ${run.runId}`);
  expect(logsForTicket(ctx, "PROJ-1", "quality.tests")).toContain("tests passed");

  run.status = "FAIL";
  run.outcome = {
    phase: "quality.tests",
    reason: "second projection",
    logPath: "steps/quality.tests/attempt-001/output.log",
    resumable: true,
  };
  emitRunStats(run, { projRoot: root, context: ctx });
  const history = readFileSync(centralPath!, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(history).toHaveLength(1);
  expect(history[0].status).toBe("FAIL");
});

test("persisted format: validates the contract", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-clean-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  const logDir = join(runDir, "steps", "quality.tests", "attempt-001");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "output.log"), "old output\n");
  appendRunEvent(run, "run.finished", { status: "PASS" });
  saveRun(run);
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.updatedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(statePath, JSON.stringify(state));

  const result = cleanLogs(ctx, "PROJ-1", "1d", false);
  expect(result.files).toBe(1);
  expect(existsSync(join(logDir, "output.log"))).toBe(false);
  expect(existsSync(join(logDir, "output.log.gz"))).toBe(true);
  expect(readFileSync(join(runDir, "events.jsonl"), "utf-8")).toContain("run.finished");

  const failedDir = resolveRunDir("quality", "PROJ-1", undefined, false, ctx);
  const failedRun = runFor(root, "PROJ-1", failedDir);
  failedRun.status = "FAIL";
  failedRun.steps[0]!.status = "failed";
  failedRun.outcome = {
    phase: failedRun.steps[0]!.id,
    reason: "tests failed",
    logPath: "steps/quality.tests/attempt-001/output.log",
    resumable: true,
  };
  const failedLogDir = join(failedDir, "steps", "quality.tests", "attempt-001");
  mkdirSync(failedLogDir, { recursive: true });
  writeFileSync(join(failedLogDir, "output.log"), "keep this diagnostic\n");
  saveRun(failedRun);
  const failedStatePath = join(failedDir, "state.json");
  const failedState = JSON.parse(readFileSync(failedStatePath, "utf-8"));
  failedState.updatedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(failedStatePath, JSON.stringify(failedState));

  cleanLogs(ctx, "PROJ-1", "1d", true);
  expect(existsSync(join(failedLogDir, "output.log"))).toBe(true);
});

test("persisted format: validates the contract", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-log-traversal-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("feature", "PROJ-1", undefined, false, ctx);
  const run = runFor(root, "PROJ-1", runDir);
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "must not be read\n");
  run.steps[0]!.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "done",
      started_at: run.createdAt!,
      finished_at: run.updatedAt!,
      log_path: relative(runDir, secret),
    },
  ];
  saveRun(run);

  expect(logsForTicket(ctx, "PROJ-1", "quality.tests")).toBe("No logs found for quality.tests.");
});

test("persisted format: validates the contract", () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-clean-global-"));
  const ctx = contextFor(root);
  const runDir = resolveRunDir("quality", undefined, undefined, false, ctx);
  const run = runFor(root, "NO-TICKET", runDir);
  run.ticket = undefined;
  const logDir = join(runDir, "steps", "quality.tests", "attempt-001");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "output.log"), "old global output\n");
  saveRun(run);
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.updatedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(statePath, JSON.stringify(state));

  const result = cleanLogs(ctx, undefined, "1d", false);
  expect(result).toEqual({ runs: 1, files: 1 });
  expect(existsSync(join(logDir, "output.log.gz"))).toBe(true);
});

test("persisted format: a snapshot written before cost_unaccounted existed still stops a capped run", async () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-minimal-unaccounted-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "PROJ-9" });
  const pipelinePath = join(root, "p.ts");
  writeFileSync(
    pipelinePath,
    `export default ({ pipeline, actionStep }) => pipeline("p")
  .maxCost(5)
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .build();`,
  );
  const runDir = resolveRunDir("p", "PROJ-9", undefined, true, ctx);
  // Hand-written snapshot from a release that had no run-level accounting
  // fields: the ONLY evidence of the unpriced attempt is the step's own
  // `cost_unknown` over figures that prove consumption. Run-level uncertainty is
  // a projection of the attempts, so the absent field must not read as
  // "accounted for".
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: basename(runDir),
      name: "p",
      ticket: "PROJ-9",
      pipeline: "p",
      pipeline_path: relative(root, pipelinePath),
      status: "RUNNING",
      max_cost_usd: 5,
      steps: [
        {
          id: "a",
          status: "done",
          retries: 0,
          control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true },
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
        { id: "b", status: "pending", retries: 0 },
      ],
    }),
  );

  const run = await loadOrCreateRun(pipelinePath, "PROJ-9", undefined, undefined, runDir, false, undefined, ctx);
  expect(run.cost_unaccounted).toBeUndefined();
  expect(run.allow_unmetered).toBeUndefined();

  const spawned: string[] = [];
  const deps: StepLoopDeps = {
    executeStep: async (step) => {
      spawned.push(step.id);
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runFixLoop: async () => ({ failed: false }),
    output: NULL_RUN_OUTPUT,
  };
  const outcome = await executeRunSteps(run, "PROJ-9", undefined, { resuming: true }, deps, ctx);

  expect(outcome.costUnaccounted).toBe(true);
  expect(spawned).toEqual([]);
  expect(run.steps[1]!.status).toBe("pending");
  // The loop latches what the old snapshot only implied, so the next reader does
  // not have to re-derive it from the attempt history.
  expect(run.cost_unaccounted).toBe(true);
}, 20_000);

test("persisted format: a minimal step flagged cost_unknown with nothing measured does not stop the run", async () => {
  const root = mkdtempSync(join("/tmp", "pipeline-state-minimal-unmeasured-"));
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "PROJ-10" });
  const pipelinePath = join(root, "p.ts");
  writeFileSync(
    pipelinePath,
    `export default ({ pipeline, actionStep }) => pipeline("p")
  .maxCost(5)
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .build();`,
  );
  const runDir = resolveRunDir("p", "PROJ-10", undefined, true, ctx);
  // The other minimal shape: an attempt that died before reporting anything. Its
  // control carries `cost_unknown` — the closure rule's precaution, which keeps
  // the total a lower bound — but no tokens and no amount were ever measured, so
  // it is no proof that the ceiling became unenforceable. Stopping here would
  // freeze a resumed run on a transport failure from a previous generation.
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: basename(runDir),
      name: "p",
      ticket: "PROJ-10",
      pipeline: "p",
      pipeline_path: relative(root, pipelinePath),
      status: "RUNNING",
      max_cost_usd: 5,
      steps: [
        { id: "a", status: "failed", retries: 0, control: { duration_ms: 60_000, cost_unknown: true } },
        { id: "b", status: "pending", retries: 0 },
      ],
    }),
  );

  const run = await loadOrCreateRun(pipelinePath, "PROJ-10", undefined, undefined, runDir, false, undefined, ctx);
  const spawned: string[] = [];
  const deps: StepLoopDeps = {
    executeStep: async (step) => {
      spawned.push(step.id);
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runFixLoop: async () => ({ failed: false }),
    output: NULL_RUN_OUTPUT,
  };
  const outcome = await executeRunSteps(run, "PROJ-10", undefined, { resuming: true }, deps, ctx);

  expect(outcome.costUnaccounted).toBe(false);
  expect(spawned).toEqual(["a", "b"]);
  expect(run.cost_unaccounted).toBeUndefined();
}, 20_000);
