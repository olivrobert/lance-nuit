import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunJournalEvent } from "../model/journal.js";
import type { Run } from "../model/run.js";
import { commandRegistries } from "../commands/registries.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { projectStepAttempts } from "./attempt-projection.js";
import { appendRunEvent, readRunEvents } from "./run-journal.js";
import { loadOrCreateRun } from "../boot/resume.js";
import { saveRun } from "./run-repository.js";
import { nextAttemptLogPath } from "./run-timeline.js";

function writeFixture(dir: string): string {
  const path = join(dir, "pipeline-attempts.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, bashStep }) => pipeline("default")` +
      `.add(bashStep({ id: "a", name: "A", command: "true" }))` +
      `.build();\n`,
  );
  return path;
}

/** Journal lines as they are read back, including the partial ones the schema
 *  refuses: the projection must keep ignoring them without shifting a number. */
function event(type: string, ts: string, data: Record<string, unknown>): RunJournalEvent {
  return { ts, type, ...data } as unknown as RunJournalEvent;
}

test("projectStepAttempts: validates the contract", () => {
  const attempts = projectStepAttempts([
    event("run.started", "2026-08-01T10:00:00.000Z", {}),
    event("step.attempt.started", "2026-08-01T10:00:01.000Z", {
      stepId: "checks",
      attempt: 1,
      kind: "step",
      logPath: "steps/checks/attempt-001/output.log",
    }),
    event("step.attempt.finished", "2026-08-01T10:00:09.000Z", {
      stepId: "checks",
      attempt: 1,
      kind: "step",
      status: "failed",
      session: { provider: "claude", id: "sess-1", resumable: true },
      control: { duration_ms: 8000, total_cost_usd: 0.5, model: "claude-opus-5" },
      usage: { num_turns: 3 },
      logPath: "steps/checks/attempt-001/output.log",
      reason: "static analysis failed",
    }),
    event("step.attempt.started", "2026-08-01T10:00:10.000Z", { stepId: "checks", attempt: 2, kind: "fix" }),
  ]);

  const checks = attempts.get("checks");
  expect(checks).toHaveLength(2);
  expect(checks?.[0]).toEqual({
    attempt: 1,
    kind: "step",
    status: "failed",
    started_at: "2026-08-01T10:00:01.000Z",
    finished_at: "2026-08-01T10:00:09.000Z",
    log_path: "steps/checks/attempt-001/output.log",
    session: { provider: "claude", id: "sess-1", resumable: true },
    control: { duration_ms: 8000, total_cost_usd: 0.5, model: "claude-opus-5" },
    usage: { num_turns: 3 },
    errors: "static analysis failed",
  });
  // A start with no finish is an attempt killed mid-flight, not a lost one.
  expect(checks?.[1]).toMatchObject({ attempt: 2, kind: "fix", status: "running" });
});

test("projectStepAttempts: validates the contract", () => {
  // A journal whose head is missing must not shift the numbering of what remains.
  const attempts = projectStepAttempts([
    event("step.attempt.finished", "2026-08-01T10:00:09.000Z", {
      stepId: "checks",
      attempt: 2,
      kind: "fix",
      status: "done",
      session: { provider: "codex", id: "sess-9", resumable: true },
    }),
  ]);

  expect(attempts.get("checks")).toHaveLength(1);
  expect(attempts.get("checks")?.[0]).toMatchObject({
    attempt: 2,
    kind: "fix",
    status: "done",
    session: { provider: "codex", id: "sess-9", resumable: true },
  });
});

test("projectStepAttempts: validates the contract", () => {
  // An unusable event is dropped, and an unknown status closes the attempt rather
  // than leaving it `running` forever.
  const attempts = projectStepAttempts([
    event("step.attempt.started", "2026-08-01T10:00:00.000Z", { attempt: 1 }),
    event("step.attempt.started", "2026-08-01T10:00:00.000Z", { stepId: "checks", attempt: 0 }),
    event("step.attempt.finished", "2026-08-01T10:00:01.000Z", { stepId: "checks", attempt: 1, status: "???" }),
  ]);

  expect(attempts.get("checks")).toHaveLength(1);
  expect(attempts.get("checks")?.[0]?.status).toBe("failed");
});

test("projectStepAttempts: an abort event carrying costUsd and usage projects them faithfully", () => {
  // The abort path may enrich its event with the same fields as a normal finish.
  // The projection reads `control`/`usage`, never the flat `costUsd`: the extra
  // key must not disturb what the attempt keeps.
  const attempts = projectStepAttempts([
    event("step.attempt.started", "2026-08-01T10:00:01.000Z", {
      stepId: "checks",
      attempt: 1,
      kind: "step",
      logPath: "steps/checks/attempt-001/output.log",
    }),
    event("step.attempt.finished", "2026-08-01T10:00:09.000Z", {
      stepId: "checks",
      attempt: 1,
      kind: "step",
      status: "aborted",
      model: "claude-opus-5",
      provider: "claude",
      costUsd: 0.4,
      control: { duration_ms: 8000, total_cost_usd: 0.4, model: "claude-opus-5", cost_estimated: true },
      usage: { input_tokens: 12, output_tokens: 3 },
      logPath: "steps/checks/attempt-001/output.log",
      reason: "SIGINT: run interrupted manually",
    }),
  ]);

  expect(attempts.get("checks")?.[0]).toEqual({
    attempt: 1,
    kind: "step",
    status: "aborted",
    started_at: "2026-08-01T10:00:01.000Z",
    finished_at: "2026-08-01T10:00:09.000Z",
    log_path: "steps/checks/attempt-001/output.log",
    control: { duration_ms: 8000, total_cost_usd: 0.4, model: "claude-opus-5", cost_estimated: true },
    usage: { input_tokens: 12, output_tokens: 3 },
    errors: "SIGINT: run interrupted manually",
  });
});

test("attempt projection: validates the integration contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attempt-resume-"));
  const pipelinePath = writeFixture(dir);
  const runDir = join(dir, "run");

  // Loading a definition builds the DSL against the run's registry: the caller
  // supplies the context, nothing falls back to the built-in composition.
  const context = buildPipelineContext({ ...commandRegistries(), cwd: dir });
  const run = await loadOrCreateRun(pipelinePath, undefined, undefined, undefined, runDir, true, undefined, context);
  const step = run.steps[0]!;

  // Two attempts recorded the way the runner records them: allocation, then the
  // pair of journal events.
  for (const attempt of [1, 2] as const) {
    nextAttemptLogPath(run, step, attempt === 1 ? "step" : "fix");
    appendRunEvent(run, "step.attempt.started", {
      stepId: step.id,
      attempt,
      kind: attempt === 1 ? "step" : "fix",
      logPath: step.attempts.at(-1)?.log_path,
    });
    appendRunEvent(run, "step.attempt.finished", {
      stepId: step.id,
      attempt,
      kind: attempt === 1 ? "step" : "fix",
      status: attempt === 1 ? "failed" : "done",
      logPath: step.attempts.at(-1)?.log_path,
    });
  }
  step.status = "failed";
  saveRun(run);

  // The snapshot carries none of it; the journal carries all of it.
  const snapshot = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8")) as {
    steps: Record<string, unknown>[];
  };
  expect(snapshot.steps[0]?.attempts).toBeUndefined();
  expect(projectStepAttempts(readRunEvents(runDir)).get(step.id)).toHaveLength(2);

  const resumed: Run = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    false,
    undefined,
    context,
  );
  const resumedStep = resumed.steps[0]!;
  expect(resumedStep.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  expect(resumedStep.attempts.map((attempt) => attempt.kind)).toEqual(["step", "fix"]);
  expect(resumedStep.attempts.map((attempt) => attempt.status)).toEqual(["failed", "done"]);

  // The load path of this whole projection: the next attempt must not reuse a
  // number, or it would overwrite the logs of a previous attempt.
  const next = nextAttemptLogPath(resumed, resumedStep, "step");
  expect(next).toContain("attempt-003");
});
