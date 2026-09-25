import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../../src/model/run.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import type { RunnerEvent } from "../../src/runtime/events.js";
import type { RunOutput } from "../../src/runtime/run-output.js";
import { makeRunStep } from "../../src/state/run-step.js";
import { executeRunSteps, stepLoopDeps } from "../../src/step/step-loop.js";

test("a code step that throws leaves its message and stack in the output.log the console points to", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-fn-throw-"));
  const runDir = mkdtempSync(join(tmpdir(), "pipeline-fn-throw-run-"));
  const ticket = "fn-throw";
  const context = buildPipelineContext({ cwd, ticket });
  const events: RunnerEvent[] = [];
  const output: RunOutput = { emit: (event) => events.push(event) };

  const step = makeRunStep({
    id: "validate",
    name: "Validate plan",
    runner: "fn",
    command: "",
    action: () => {
      throw new Error("Plan: one **Tests:** line per step is required");
    },
  });
  const run: Run = {
    schemaVersion: 1,
    runId: "fn-throw",
    name: "fn-throw",
    pipeline: "fn-throw",
    pipeline_path: join(cwd, "fn-throw.ts"),
    run_dir: runDir,
    ticket,
    status: "RUNNING",
    steps: [step],
  };

  const outcome = await executeRunSteps(run, ticket, undefined, { resuming: false }, stepLoopDeps(output), context);

  expect(outcome.failed).toBe(true);
  const announced = events
    .map((event) => (event.type === "runner.message" ? event.message : ""))
    .find((message) => message.includes("📄 Output: "));
  const logPath = join(runDir, "steps", "validate", "attempt-001", "output.log");
  expect(announced).toBe(`  📄 Output: ${logPath}`);
  expect(existsSync(logPath)).toBe(true);
  const log = readFileSync(logPath, "utf8");
  expect(log).toContain("Plan: one **Tests:** line per step is required");
  expect(log).toContain("fn-step-failure-log.test.ts");
});
