import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashStep, llmStep, pipeline } from "../../src/dsl.js";
import type { Run, RunStep } from "../../src/model/run.js";
import { isPersistedRunResumable, pendingSteps } from "../../src/state/run-predicates.js";
import { readRunSnapshot } from "../../src/state/run-snapshot.js";
import { deriveRunStatus } from "../../src/state/run-verdict.js";
import { stopRun } from "../../src/state/run-transitions.js";
import { validatePipeline } from "../../src/pipeline/loader.js";
import { makeRunStep } from "../../src/state/run-step.js";
import { commandRegistries } from "../../src/commands/registries.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { createDefaultAgentBackendRegistry } from "../../src/engine/default-registry.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

function fakeRun(): Run {
  const dir = mkdtempSync(join(tmpdir(), "runner-stop-"));
  const steps: RunStep[] = [
    makeRunStep({ id: "a", name: "A", command: "x", runner: "bash" }, { status: "done" }),
    makeRunStep({ id: "b", name: "B", command: "x", runner: "bash" }),
    makeRunStep({ id: "c", name: "C", command: "x", runner: "bash" }),
  ];
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, steps };
}

test("stopRun: stopped_reason persisted, remaining work preserved", () => {
  const run = fakeRun();
  stopRun(run, run.steps[1], "escalated: too sensitive");
  expect(run.steps[0].status).toBe("done");
  // The stop is not a verdict on the remaining steps. Settling them here would
  // make the snapshot non-resumable and replay the step already completed.
  expect(run.steps[1].status).toBe("pending");
  expect(run.steps[2].status).toBe("pending");
  expect(run.stopped_reason).toBe("escalated: too sensitive");
  expect(run.status).toBe("STOPPED");
  const saved = JSON.parse(readFileSync(join(run.run_dir, "state.json"), "utf-8"));
  expect(saved.stopped_reason).toBe("escalated: too sensitive");
  expect(saved.steps[2].status).toBe("pending");
});

test("stopRun: the structured cause is persisted and journaled", () => {
  const run = fakeRun();
  stopRun(run, run.steps[1], 'escalated: too sensitive — lift with "lancenuit run PROJ-9 --approve diff"', {
    subject: "diff",
    kind: "needs-decision",
    detail: "too sensitive",
  });
  const saved = JSON.parse(readFileSync(join(run.run_dir, "state.json"), "utf-8"));
  // A reader learns what lifts the stop without parsing the console sentence,
  // which keeps the CLI free to reword it.
  expect(saved.outcome.stop).toEqual({ subject: "diff", kind: "needs-decision", detail: "too sensitive" });
  expect(saved.stopped_reason).toContain("lancenuit run");

  const events = readFileSync(join(run.run_dir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const stopped = events.find((event) => event.type === "run.stopped");
  expect(stopped.stop).toEqual({ subject: "diff", kind: "needs-decision", detail: "too sensitive" });
});

test("stopRun: a stop that describes nothing stays valid", () => {
  const run = fakeRun();
  // An admission declaring no cause still stops the run; older snapshots have no
  // `stop` either, so the field must remain absent rather than half-filled.
  stopRun(run, run.steps[1], "waiting");
  const saved = JSON.parse(readFileSync(join(run.run_dir, "state.json"), "utf-8"));
  expect(saved.status).toBe("STOPPED");
  expect(saved.outcome.stop).toBeUndefined();
});

test("stopRun: a stopped run resumes instead of replaying completed steps", () => {
  const run = fakeRun();
  stopRun(run, run.steps[1], "escalated: waiting for a human decision");
  const saved = readRunSnapshot(join(run.run_dir, "state.json"));
  expect(deriveRunStatus(saved!)).toBe("STOPPED");
  expect(isPersistedRunResumable(saved)).toBe(true);
  expect(pendingSteps(saved).map((step) => step.id)).toEqual(["b", "c"]);
});

test("validatePipeline accepts a stop admission", () => {
  const p = pipeline("x")
    .add(bashStep({ id: "s", name: "S", command: "true", when: { command: "false", else: "stop" } }))
    .build();
  // Validation runs against the backends the run will use: the caller supplies
  // the context that carries the registry.
  const context = buildPipelineContext({ ...commandRegistries(), cwd: process.cwd() });
  expect(() => validatePipeline(p, "test", { context })).not.toThrow();
});

test("the DSL exposes stop admissions in step inputs", () => {
  const step = llmStep(
    {
      id: "s",
      name: "S",
      backend: "claude",
      profile: "operator",
      command: "c",
      when: { command: "test -f x", else: "stop" },
    },
    REGISTRY,
  ).build();
  expect(step.inputs?.[0]?.kind).toBe("command");
});
