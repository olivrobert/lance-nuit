import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../../model/run.js";
import { createLogRef, createRunRef, type RunLogStore } from "../../model/storage-ports.js";
import { makeRunStep } from "../run-step.js";
import { attemptLogPath, findStepLog, latestAttemptLog, nextAttemptLogPath } from "../run-timeline.js";
import { FileRunLogStore } from "./file-run-log-store.js";

test("file-run-log-store: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-log-store-"));
  const store = new FileRunLogStore({ runDir });
  const runRef = createRunRef({ runId: "run-1", pipeline: "quality" });
  const first = store.allocate(runRef, "quality.tests", 1);
  const second = store.allocate(runRef, "quality.tests", 2);

  expect(first.localPath).toBe(join(runDir, "steps", "quality.tests", "attempt-001", "output.log"));
  expect(second.localPath).toBe(join(runDir, "steps", "quality.tests", "attempt-002", "output.log"));
  store.append(first, "premier\n");
  store.append(first, "suite\n");
  store.append(second, "dernier\n");
  expect(store.read(first)).toBe("premier\nsuite\n");
  expect(store.findLatest(runRef, "quality.tests")).toEqual(second);
});

test("FileRunLogStore isolates steps: validates the contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-log-isolation-"));
  const store = new FileRunLogStore({ runDir });
  const runRef = createRunRef({ runId: "run-1", pipeline: "quality" });
  const tests = store.allocate(runRef, "quality.tests", 1);
  const lint = store.allocate(runRef, "quality.lint", 1);
  store.append(tests, "tests\n");
  store.append(lint, "lint\n");

  expect(store.read(tests)).toBe("tests\n");
  expect(store.read(lint)).toBe("lint\n");
  expect(tests.localPath).not.toBe(lint.localPath);
});

test("FileRunLogStore rejects step IDs that cannot have distinct paths", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-log-invalid-step-"));
  const store = new FileRunLogStore({ runDir });
  const runRef = createRunRef({ runId: "run-1", pipeline: "quality" });

  expect(() => store.allocate(runRef, "a?b", 1)).toThrow(/safe logical value/);
  expect(() => store.allocate(runRef, "a#b", 1)).toThrow(/safe logical value/);
  expect(() => store.allocate(runRef, "a/b", 1)).toThrow(/safe logical value/);
});

test("FileRunLogStore rejects symlink components before creating logs outside the run", () => {
  const root = mkdtempSync(join(tmpdir(), "file-run-log-symlink-"));
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "steps"));

  const store = new FileRunLogStore({ runDir: root });
  const runRef = createRunRef({ runId: "run-1", pipeline: "quality" });

  expect(() => store.allocate(runRef, "safe", 1)).toThrow(/symbolic link/);
  expect(existsSync(join(outside, "safe"))).toBe(false);
});

test("FileRunLogStore accepts a run directory reached through a symlink (worktree shared runs/)", () => {
  const root = mkdtempSync(join(tmpdir(), "file-run-log-shared-runs-"));
  const mainRuns = join(root, "main", "runs");
  mkdirSync(mainRuns, { recursive: true });
  mkdirSync(join(root, "worktree"));
  // `--worktree` links `work-items/<ticket>/runs` to the main clone's directory.
  symlinkSync(mainRuns, join(root, "worktree", "runs"));
  const runDir = join(root, "worktree", "runs", "run-1");

  const store = new FileRunLogStore({ runDir });
  const runRef = createRunRef({ runId: "run-1", pipeline: "quality" });

  const log = store.allocate(runRef, "safe", 1);
  store.append(log, "hello\n");
  expect(existsSync(join(mainRuns, "run-1", "steps", "safe", "attempt-001", "output.log"))).toBe(true);
  expect(store.read(log)).toBe("hello\n");

  // A link created inside the run is still refused.
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(mainRuns, "run-1", "steps", "evil"));
  expect(() => store.allocate(runRef, "evil", 1)).toThrow(/symbolic link/);
  expect(existsSync(join(outside, "attempt-001"))).toBe(false);
});

test("file-run-log-store: validates the integration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "run-log-fake-"));
  const runDir = join(root, "historical-run-dir");
  const calls: string[] = [];
  const fake: RunLogStore = {
    allocate: (run, stepId, attempt) => {
      calls.push(`${stepId}:${attempt}`);
      return createLogRef(run, stepId, attempt, join(root, "virtual", stepId, String(attempt), "output.log"));
    },
    append: () => {
      throw new Error("append inattendu");
    },
    read: () => "in-memory log",
  };
  const step = makeRunStep(
    { id: "quality.tests", name: "Tests", command: "test", runner: "bash" },
    { status: "running" },
  );
  const run: Run = {
    runId: "run-1",
    name: "quality",
    pipeline: "quality",
    pipeline_path: "quality.ts",
    run_dir: runDir,
    steps: [step],
    logStore: fake,
  };

  expect(attemptLogPath(run, step, 3)).toBe(join(root, "virtual", "quality.tests", "3", "output.log"));
  expect(nextAttemptLogPath(run, step)).toBe(join(root, "virtual", "quality.tests", "1", "output.log"));
  expect(step.attempts?.[0]?.log_path).toBe("steps/quality.tests/attempt-001/output.log");
  expect(latestAttemptLog(run, step)).toBe(join(root, "virtual", "quality.tests", "1", "output.log"));
  expect(findStepLog(run, step.id)).toBe(join(root, "virtual", "quality.tests", "1", "output.log"));
  expect(calls).toEqual(["quality.tests:3", "quality.tests:1", "quality.tests:1", "quality.tests:1"]);
  expect(existsSync(runDir)).toBe(false);
});
