import { expect, test } from "bun:test";
import type { ArtifactRef, WorkItemArtifactStore } from "./artifact-ports.ts";
import { createArtifactRef, isArtifactRef } from "./artifact-ports.ts";
import type { PersistedRun } from "./persisted.ts";
import type { Run } from "./run.ts";
import type { LogRef, RunEventStore, RunLogStore, RunStateStore } from "./storage-ports.ts";
import { createLogRef, createRunRef, isLogRef, isRunRef, runRefFromRun } from "./storage-ports.ts";

const run: Run = {
  runId: "run-123",
  name: "feature",
  pipeline: "feature",
  pipeline_path: "pipelines/feature.ts",
  run_dir: "/tmp/local-run-directory",
  ticket: "PROJ-42-01",
  steps: [],
};

test("storage-ports: validates the integration contract", () => {
  const ref = runRefFromRun(run);
  expect(ref).toEqual({ runId: "run-123", pipeline: "feature", ticket: "PROJ-42-01" });
  expect(ref).not.toHaveProperty("run_dir");

  const artifact = createArtifactRef("PROJ-42", "plan.md");
  expect(artifact).toEqual({ ticket: "PROJ-42", name: "plan.md" });

  const log = createLogRef(
    ref,
    "quality.tests",
    2,
    "/tmp/local-run-directory/steps/quality.tests/attempt-002/output.log",
  );
  expect(log).toEqual({
    run: ref,
    stepId: "quality.tests",
    attempt: 2,
    localPath: "/tmp/local-run-directory/steps/quality.tests/attempt-002/output.log",
  });
  expect(log.run).not.toHaveProperty("run_dir");
});

test("storage-ports: validates the integration contract", () => {
  expect(createArtifactRef({ ticket: "exports/PROJ-1478", name: "plan.md" })).toEqual({
    ticket: "exports/PROJ-1478",
    name: "plan.md",
  });
  expect(isArtifactRef({ ticket: "PROJ-42", name: "reports/plan.md" })).toBe(true);
  expect(isArtifactRef({ ticket: "PROJ-42", name: "../state.json" })).toBe(false);
  expect(isArtifactRef({ ticket: "PROJ-42", name: "/tmp/plan.md" })).toBe(false);
  expect(isRunRef({ runId: "run-123", pipeline: "feature", ticket: "../outside" })).toBe(false);
});

test("constructors validate required fields and attempts: validates the contract", () => {
  expect(() => createRunRef({ runId: "", pipeline: "feature" })).toThrow();
  expect(() => createRunRef({ runId: "run-123", pipeline: "feature/name" })).toThrow();
  expect(() => createArtifactRef("PROJ-42", "")).toThrow();
  expect(() => createLogRef(createRunRef({ runId: "run-123", pipeline: "feature" }), "quality", 0)).toThrow();
  expect(() => createLogRef(createRunRef({ runId: "run-123", pipeline: "feature" }), "quality", 1.5)).toThrow();
});

test("storage-ports: validates the integration contract", () => {
  const withoutId = { ...run, runId: undefined };
  expect(() => runRefFromRun(withoutId)).toThrow();
});

test("storage-ports: validates the integration contract", () => {
  const stateStore: RunStateStore = {
    load: (_runId): PersistedRun | null => null,
    loadLatest: (_pipeline, _ticket): PersistedRun | null => null,
    save: (_run): void => undefined,
  };
  const eventStore: RunEventStore = {
    append: (_runId, _event): void => undefined,
    read: (_runId) => [],
  };
  const logStore: RunLogStore = {
    allocate: (runRef, stepId, attempt): LogRef => createLogRef(runRef, stepId, attempt),
    append: (_log, _text): void => undefined,
    read: (_log): string | null => null,
  };
  const artifactStore: WorkItemArtifactStore = {
    exists: async (_ref: ArtifactRef) => false,
    readText: async (_ref: ArtifactRef) => undefined,
    readJson: async <T>(_ref: ArtifactRef, _parse: (value: unknown) => T) => undefined,
    writeText: async (_ref: ArtifactRef, _value: string) => undefined,
    remove: async (_ref: ArtifactRef) => undefined,
  };

  expect(stateStore.load("run-123")).toBeNull();
  expect(eventStore.read("run-123")).toEqual([]);
  expect(logStore.read(createLogRef(createRunRef({ runId: "run-123", pipeline: "feature" }), "quality", 1))).toBeNull();
  expect(artifactStore.exists(createArtifactRef("PROJ-42", "plan.md"))).resolves.toBe(false);
});

test("isLogRef validates logical references and optional locations: validates the contract", () => {
  const ref = createLogRef({
    run: createRunRef({ runId: "run-123", pipeline: "feature" }),
    stepId: "quality.tests",
    attempt: 1,
  });
  expect(isLogRef(ref)).toBe(true);
  expect(isLogRef({ ...ref, attempt: 0 })).toBe(false);
  expect(isLogRef({ ...ref, localPath: "" })).toBe(false);
  expect(isLogRef({ ...ref, run: { runId: "", pipeline: "feature", run_dir: "/tmp" } })).toBe(false);
});
