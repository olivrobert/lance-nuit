import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedRun } from "../model/persisted.js";
import type { Run } from "../model/run.js";
import { makeRunStep } from "./run-step.js";
import { finalizeRun } from "./run-transitions.js";
import { deriveRunStatus, isResumableStatus } from "./run-verdict.js";
import { projectRunStatsEntry } from "./stats/run-stats-projector.js";

function snapshot(partial: Partial<PersistedRun>): PersistedRun {
  return {
    schemaVersion: 1,
    name: "feature",
    pipeline: "feature",
    pipeline_path: "/tmp/pipeline.ts",
    run_dir: "/tmp/run",
    steps: [],
    ...partial,
  } as unknown as PersistedRun;
}

test("precedence: validates the contract", () => {
  expect(deriveRunStatus(snapshot({ aborted: true, steps: [{ id: "a", status: "done" }] as never }))).toBe("ABORTED");
  expect(deriveRunStatus(snapshot({ steps: [{ id: "a", status: "aborted" }] as never }))).toBe("ABORTED");
  expect(deriveRunStatus(snapshot({ stopped_reason: "quota", steps: [{ id: "a", status: "failed" }] as never }))).toBe(
    "STOPPED",
  );
  expect(deriveRunStatus(snapshot({ steps: [{ id: "a", status: "failed" }] as never }))).toBe("FAIL");
  expect(deriveRunStatus(snapshot({ steps: [] }), { budgetExceeded: true })).toBe("FAIL");
  expect(
    deriveRunStatus(
      snapshot({
        steps: [
          { id: "a", status: "done" },
          { id: "b", status: "skipped" },
        ] as never,
      }),
    ),
  ).toBe("PASS");
  expect(deriveRunStatus(snapshot({ steps: [{ id: "a", status: "pending" }] as never }))).toBe("UNKNOWN");
  expect(deriveRunStatus(snapshot({ steps: [] }))).toBe("UNKNOWN");
});

test("resumable: validates the contract", () => {
  expect(isResumableStatus("FAIL")).toBe(true);
  expect(isResumableStatus("STOPPED")).toBe(true);
  expect(isResumableStatus("UNKNOWN")).toBe(true);
  expect(isResumableStatus("ABORTED")).toBe(true);
  expect(isResumableStatus("PASS")).toBe(false);
});

function runFixture(steps: Array<{ id: string; status: string }>, extra: Record<string, unknown> = {}): Run {
  return {
    schemaVersion: 1,
    runId: "run-1",
    name: "feature",
    pipeline: "feature",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "run-verdict-")),
    steps: steps.map((step) =>
      makeRunStep({ id: step.id, name: step.id, command: "true", runner: "bash" }, { status: step.status as never }),
    ),
    ...extra,
  } as unknown as Run;
}

// Original defect (issue #9): two derivations produced two verdicts for one run.
const CASES: Array<{
  label: string;
  steps: Array<{ id: string; status: string }>;
  extra?: Record<string, unknown>;
}> = [
  {
    label: "clean stop despite a failed step",
    steps: [{ id: "a", status: "failed" }],
    extra: { stopped_reason: "quota" },
  },
  {
    label: "step interrompu sans drapeau de run",
    steps: [
      { id: "a", status: "aborted" },
      { id: "b", status: "pending" },
    ],
  },
  { label: "simple failure", steps: [{ id: "a", status: "failed" }] },
  {
    label: "full success",
    steps: [
      { id: "a", status: "done" },
      { id: "b", status: "skipped" },
    ],
  },
  { label: "unfinished run", steps: [{ id: "a", status: "pending" }] },
];

for (const { label, steps, extra } of CASES) {
  test(`finalizeRun and the stats projection agree — ${label}`, () => {
    const finalized = runFixture(steps, extra);
    finalizeRun(finalized);
    const projected = projectRunStatsEntry(runFixture(steps, extra));

    expect(projected.status).toBe(finalized.status as typeof projected.status);
    expect(projected.outcome.resumable).toBe(finalized.outcome!.resumable);
  });
}
