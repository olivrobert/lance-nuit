import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStep } from "../model/definition.ts";
import type { Run } from "../model/run.ts";
import { saveRun } from "./run-repository.ts";
import { makeRunStep } from "./run-step.ts";

const def: PipelineStep = { id: "a", name: "A", command: "true", runner: "bash" };

test("makeRunStep: validates the contract", () => {
  expect(makeRunStep(def).def.runner).toBe("bash");
  expect(makeRunStep(def).def.backend).toBeUndefined();
});

test("makeRunStep: validates the contract", () => {
  const step = makeRunStep(def);
  // Intentional cast: the assignment does not compile in TS (readonly). The freeze
  // is the safety net for untyped JavaScript, which is what this test verifies.
  const mutable = step.def as unknown as Record<string, unknown>;
  expect(() => {
    mutable.command = "rm -rf /";
  }).toThrow(TypeError);
  expect(step.def.command).toBe("true");
});

test("makeRunStep: validates the contract", () => {
  const step = makeRunStep(def);
  step.status = "running";
  step.session = { provider: "claude", id: "sess-1", resumable: true };
  step.control = { duration_ms: 5, total_cost_usd: 0.1 };
  expect(step).toMatchObject({ status: "running", session: { id: "sess-1" } });
});

test("saveRun: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "runstep-persist-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [makeRunStep(def, { status: "done", retries: 2 })],
  };
  saveRun(run);
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
  // Resume format is UNCHANGED by the definition/state split: runs already on
  // disk remain readable, and no definition leaks into the snapshot.
  expect(saved.steps[0]).toEqual({ id: "a", status: "done", retries: 2 });
  expect(saved.steps[0].def).toBeUndefined();
  expect(saved.steps[0].command).toBeUndefined();
  // Attempts and the rendered command belong to the journal, never the snapshot.
  expect(saved.steps[0].attempts).toBeUndefined();
  expect(saved.steps[0].last_command).toBeUndefined();
});

test("saveRun: preserves the timeout retry quota across a snapshot round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "runstep-timeout-retries-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [makeRunStep(def, { timeout_retries: 2 })],
  };

  saveRun(run);

  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
  expect(saved.steps[0].timeout_retries).toBe(2);
  expect(makeRunStep(def, saved.steps[0]).timeout_retries).toBe(2);
});

test("saveRun: preserves the attempt-numbering floor across a snapshot round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "runstep-last-attempt-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [makeRunStep(def, { last_attempt: 3 })],
  };

  saveRun(run);

  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
  expect(saved.steps[0].last_attempt).toBe(3);
  // Without the floor, a resume with a lost journal renumbers from 1 and
  // overwrites the previous run's attempt logs.
  expect(makeRunStep(def, saved.steps[0]).last_attempt).toBe(3);
});

test("saveRun: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "runstep-profile-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [makeRunStep({ id: "a", name: "A", command: "x", profile: "coder" })],
  };
  saveRun(run);
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
  expect(saved.steps[0].profile).toBe("coder");
});
