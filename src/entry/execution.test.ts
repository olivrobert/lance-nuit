import { expect, test } from "bun:test";
import { textArtifact } from "../dsl/artifact.ts";
import type { RunnerArgs } from "../model/cli-options.ts";
import type { PipelineStep } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { makeRunStep, type StepStateInput } from "../state/run-step.ts";
import { announceRun } from "./execution.ts";

// `announceRun` prints what a resume will NOT replay. Its predicate has to stay
// the mirror of the re-admission rule in `step/step-loop.ts`: a step the loop
// re-admits must never be announced as already done.

const specArtifact = textArtifact("spec.md");

function step(id: string, def: Partial<PipelineStep> = {}, state: StepStateInput = { status: "done" }): RunStep {
  return makeRunStep({ id, name: id, command: "true", runner: "bash", ...def }, state);
}

function makeRun(steps: RunStep[]): Run {
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: "/tmp", steps } as Run;
}

/** Capture what the header wrote to stderr. */
function announce(run: Run): string {
  const previous = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    announceRun(run, {} as RunnerArgs);
  } finally {
    process.stderr.write = previous;
  }
  return captured;
}

test("a plain completed step is announced as already done", () => {
  const out = announce(makeRun([step("plain")]));
  expect(out).toContain("Resumed — already done: plain");
  expect(out).not.toContain("Re-checked on resume");
  expect(out).not.toContain("Re-run on resume");
});

test("a completed step declaring sources is announced as re-checked, not as done", () => {
  const out = announce(makeRun([step("hashed", { sources: [specArtifact] })]));
  expect(out).toContain("Re-checked on resume: hashed");
  expect(out).not.toContain("Resumed — already done");
});

test("a completed rerun_on_resume step without sources is announced as re-run, not as done", () => {
  const out = announce(makeRun([step("replayed", { rerun_on_resume: true })]));
  expect(out).toContain("Re-run on resume: replayed");
  expect(out).not.toContain("Resumed — already done");
  expect(out).not.toContain("Re-checked on resume");
});

test("rerun_on_resume outranks sources: the step is replayed unconditionally", () => {
  const out = announce(makeRun([step("both", { rerun_on_resume: true, sources: [specArtifact] })]));
  expect(out).toContain("Re-run on resume: both");
  expect(out).not.toContain("Re-checked on resume");
});

test("each family lands on its own line", () => {
  const out = announce(
    makeRun([
      step("plain"),
      step("hashed", { sources: [specArtifact] }),
      step("replayed", { rerun_on_resume: true }),
      step("later", {}, { status: "pending" }),
      step("dropped", {}, { status: "skipped" }),
    ]),
  );
  expect(out).toContain("Resumed — already done: plain\n");
  expect(out).toContain("Re-checked on resume: hashed\n");
  expect(out).toContain("Re-run on resume: replayed\n");
  expect(out).toContain("Skipped: dropped\n");
  expect(out).not.toContain("later");
});
