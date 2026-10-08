import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_EXCERPT_BYTES, readStepDetail, readStepSession } from "./step-detail.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  writeProjectsFile,
  writeRun,
  writeRunEvents,
  writeRunLock,
  writeWorkItemFile,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(): string {
  const kit = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = kit;
  const project = makeProject("demo-app");
  writeProjectsFile(kit, [project]);
  return project;
}

function writeAttemptFiles(runDir: string, stepId: string, attempt: number, files: Record<string, string>): void {
  const dir = join(runDir, "steps", stepId, `attempt-${String(attempt).padStart(3, "0")}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

function logPath(stepId: string, attempt: number): string {
  return `steps/${stepId}/attempt-${String(attempt).padStart(3, "0")}/output.log`;
}

/** A test step that failed once, was repaired by a fix pass, and an audit step
 *  that ran once: the journal as the runner appends it. */
function runWithAttempts(project: string): string {
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [
      { id: "audit", status: "done", retries: 0 },
      { id: "tests", status: "done", retries: 1 },
    ],
  });
  writeRunEvents(runDir, [
    {
      ts: "2026-09-05T07:00:00.000Z",
      type: "step.attempt.started",
      stepId: "tests",
      attempt: 1,
      kind: "step",
      logPath: logPath("tests", 1),
    },
    {
      ts: "2026-09-05T07:02:00.000Z",
      type: "step.attempt.finished",
      stepId: "tests",
      attempt: 1,
      kind: "step",
      status: "failed",
      control: { duration_ms: 120000 },
      logPath: logPath("tests", 1),
      reason: "1 fail\nexpected 2, got 3",
    },
    {
      ts: "2026-09-05T07:02:01.000Z",
      type: "step.attempt.started",
      stepId: "tests",
      attempt: 2,
      kind: "fix",
      logPath: logPath("tests", 2),
    },
    {
      ts: "2026-09-05T07:03:00.000Z",
      type: "step.attempt.finished",
      stepId: "tests",
      attempt: 2,
      kind: "fix",
      status: "done",
      costUsd: 0.4,
      control: { duration_ms: 59000, total_cost_usd: 0.4, model: "claude-opus-5-5" },
      logPath: logPath("tests", 2),
    },
    {
      ts: "2026-09-05T07:04:00.000Z",
      type: "step.attempt.started",
      stepId: "audit",
      attempt: 1,
      kind: "step",
      logPath: logPath("audit", 1),
    },
  ]);
  writeAttemptFiles(runDir, "tests", 1, { "output.log": "1 fail\n", "command.txt": "bun test" });
  writeAttemptFiles(runDir, "tests", 2, { "output.log": "fixed it\n", "command.txt": "Repair the failing test" });
  return runDir;
}

test("step detail: attempts come from the journal, in order, with what each one cost and why it ended", () => {
  const project = listedProject();
  runWithAttempts(project);

  const detail = readStepDetail("demo-app", "DEMO-1", "tests", undefined);

  expect(detail?.attempts).toEqual([
    {
      attempt: 1,
      kind: "step",
      status: "failed",
      startedAt: "2026-09-05T07:00:00.000Z",
      finishedAt: "2026-09-05T07:02:00.000Z",
      durationMs: 120000,
      reason: "1 fail\nexpected 2, got 3",
      logPath: `runs/feature/r-1/${logPath("tests", 1)}`,
    },
    {
      attempt: 2,
      kind: "fix",
      status: "done",
      startedAt: "2026-09-05T07:02:01.000Z",
      finishedAt: "2026-09-05T07:03:00.000Z",
      durationMs: 59000,
      costUsd: 0.4,
      model: "claude-opus-5-5",
      logPath: `runs/feature/r-1/${logPath("tests", 2)}`,
    },
  ]);
  expect(detail?.stepDir).toBe("runs/feature/r-1/steps/tests");
});

test("step detail: the last attempt is shown by default, another one on request", () => {
  const project = listedProject();
  runWithAttempts(project);

  const last = readStepDetail("demo-app", "DEMO-1", "tests", undefined);
  expect(last?.attempt).toBe(2);
  expect(last?.command).toEqual({
    text: "Repair the failing test",
    truncated: false,
    path: "runs/feature/r-1/steps/tests/attempt-002/command.txt",
  });
  expect(last?.output?.text).toBe("fixed it\n");

  const first = readStepDetail("demo-app", "DEMO-1", "tests", 1);
  expect(first?.attempt).toBe(1);
  expect(first?.command?.text).toBe("bun test");
  expect(first?.output?.text).toBe("1 fail\n");
});

test("step detail: a long output is cut to its tail, a missing command is simply absent", () => {
  const project = listedProject();
  const runDir = runWithAttempts(project);
  writeAttemptFiles(runDir, "audit", 1, { "output.log": `${"x".repeat(OUTPUT_EXCERPT_BYTES)}VERDICT` });

  const detail = readStepDetail("demo-app", "DEMO-1", "audit", undefined);

  expect(detail?.output?.truncated).toBe(true);
  expect(detail?.output?.text.endsWith("VERDICT")).toBe(true);
  expect(detail?.output?.text.length).toBe(OUTPUT_EXCERPT_BYTES);
  expect(detail?.command).toBeUndefined();
  expect(detail?.attempts[0]?.status).toBe("running");
});

test("step detail: produced files are the artifacts whose provenance names the step", () => {
  const project = listedProject();
  runWithAttempts(project);
  const record = (artifact: string, producedBy: string) =>
    JSON.stringify({ schemaVersion: 1, artifact, producedBy, producedAt: "2026-09-05T07:04:00.000Z", inputs: {} });
  writeWorkItemFile(
    project,
    "DEMO-1",
    "artifacts/.provenance/audit.json.json",
    record("artifacts/audit.json", "audit"),
  );
  writeWorkItemFile(project, "DEMO-1", "artifacts/.provenance/plan.md.json", record("artifacts/plan.md", "plan"));
  writeWorkItemFile(project, "DEMO-1", "artifacts/.provenance/evil.json", record("../../etc/passwd", "audit"));
  writeWorkItemFile(project, "DEMO-1", "artifacts/.provenance/broken.json", "{");

  expect(readStepDetail("demo-app", "DEMO-1", "audit", undefined)?.produced).toEqual(["artifacts/audit.json"]);
  expect(readStepDetail("demo-app", "DEMO-1", "tests", undefined)?.produced).toEqual([]);
});

test("step detail: an unknown step, attempt-less step or unknown run answers without guessing", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "RUNNING",
    steps: [{ id: "review", status: "pending", retries: 0 }],
  });
  writeRunEvents(runDir, []);

  expect(readStepDetail("demo-app", "DEMO-1", "../state.json", undefined)).toBeUndefined();
  expect(readStepDetail("demo-app", "DEMO-2", "review", undefined)).toBeUndefined();
  const pending = readStepDetail("demo-app", "DEMO-1", "review", undefined);
  expect(pending?.attempts).toEqual([]);
  expect(pending?.attempt).toBeUndefined();
  expect(pending?.output).toBeUndefined();
});

test("step detail: a journal log path leaving the run is never opened", () => {
  const project = listedProject();
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    steps: [{ id: "tests", status: "failed", retries: 0 }],
  });
  writeWorkItemFile(project, "DEMO-1", "secret.log", "secret");
  writeRunEvents(runDir, [
    {
      ts: "2026-09-05T07:00:00.000Z",
      type: "step.attempt.started",
      stepId: "tests",
      attempt: 1,
      logPath: "../../../secret.log",
    },
  ]);

  const detail = readStepDetail("demo-app", "DEMO-1", "tests", undefined);

  expect(detail?.attempts[0]?.logPath).toBeUndefined();
  expect(detail?.output).toBeUndefined();
});

test("step session: an attempt's resumable session, where its run ran; none for an attempt without one", () => {
  const project = listedProject();
  const session = { provider: "claude", id: "6bd3dbb0-0923-4814-9958-449272a0d545", resumable: true };
  const runDir = writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "RUNNING",
    steps: [{ id: "triage", status: "done", retries: 1 }],
  });
  writeRunLock(runDir, process.ppid);
  const finished = (attempt: number, extra: Record<string, unknown>) => ({
    ts: "2026-09-05T07:00:00.000Z",
    type: "step.attempt.finished",
    stepId: "triage",
    attempt,
    kind: "step",
    status: "done",
    ...extra,
  });
  writeRunEvents(runDir, [
    finished(1, { session: { ...session, resumable: false } }),
    finished(2, { session }),
    { ts: "2026-09-05T07:01:00.000Z", type: "step.attempt.started", stepId: "triage", attempt: 3, kind: "step" },
  ]);

  expect(readStepSession("demo-app", "DEMO-1", "triage", 2)).toEqual({
    pipeline: "feature",
    runId: "r-1",
    status: "RUNNING",
    stepId: "triage",
    provider: "claude",
    sessionId: session.id,
    cwd: project,
    worktree: false,
  });
  expect(readStepSession("demo-app", "DEMO-1", "triage", 1)).toBeUndefined();
  expect(readStepSession("demo-app", "DEMO-1", "triage", 3)).toBeUndefined();
  expect(readStepSession("demo-app", "DEMO-1", "other", 2)).toBeUndefined();
  const attempts = readStepDetail("demo-app", "DEMO-1", "triage", undefined)?.attempts;
  expect(attempts?.map((attempt) => attempt.hasSession ?? false)).toEqual([false, true, false]);
});
