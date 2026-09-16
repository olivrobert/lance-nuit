import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../../src/model/run.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { finalizeRun } from "../../src/state/run-transitions.js";
import { makeRunStep } from "../../src/state/run-step.js";
import { NULL_RUN_OUTPUT } from "../../src/runtime/run-output.js";
import { executeRunSteps, stepLoopDeps } from "../../src/step/step-loop.js";

test("generic bash pipeline: an arbitrary identifier never accesses the Jira gateway", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-phase5-generic-"));
  const runDir = mkdtempSync(join(tmpdir(), "pipeline-phase5-run-"));
  const ticket = "arbitrary-execution-id";
  const context = buildPipelineContext({ cwd, ticket });

  // The context retains historical Jira values, but any attempt to create or
  // access the gateway fails this focused smoke test.
  Object.defineProperty(context, "workItem", {
    configurable: true,
    enumerable: true,
    get(): never {
      throw new Error("generic bash pipeline touched the work-item gateway");
    },
  });

  const step = makeRunStep({
    id: "shell",
    name: "Generic shell command",
    runner: "bash",
    command: "printf 'generic-ok'",
  });
  const run: Run = {
    schemaVersion: 1,
    runId: "phase5-generic",
    name: "generic-shell",
    pipeline: "generic-shell",
    pipeline_path: join(cwd, "generic.ts"),
    run_dir: runDir,
    ticket,
    status: "RUNNING",
    steps: [step],
  };

  const outcome = await executeRunSteps(
    run,
    ticket,
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(run, outcome);

  expect(outcome.failed).toBe(false);
  expect(run.status).toBe("PASS");
  expect(step.status).toBe("done");
  expect(readFileSync(join(runDir, "state.json"), "utf8")).toContain(ticket);
  const attemptLog = readFileSync(join(runDir, "steps", "shell", "attempt-001", "output.log"), "utf8");
  expect(attemptLog).toContain("generic-ok");
});
