import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PersistedRun } from "../../model/persisted.js";
import { buildPipelineContext } from "../../pipeline/context.js";
import { FileRunSnapshotCatalog } from "./file-run-snapshot-catalog.js";
import { FileRunStateStore } from "./file-run-state-store.js";

function persistedRun(runId: string): PersistedRun {
  return {
    schemaVersion: 1,
    runId,
    name: "feature",
    ticket: "PROJ-1",
    pipeline: "feature",
    status: "PASS",
    steps: [],
  };
}

test("file-run-state-store: validates the integration contract", () => {
  const cwd = mkdtempSync(join("/tmp", "file-run-state-store-"));
  const store = new FileRunStateStore({ cwd, pipeline: "feature", ticket: "PROJ-1" });
  const runDir = store.resolveRunDir("feature", undefined, undefined, true);
  const run = persistedRun(basename(runDir));

  store.save(run);

  expect(store.load(run.runId!)).toMatchObject(run);
  expect(store.loadLatest("feature")).toMatchObject(run);
  expect(store.pathFor(runDir)).toBe(join(runDir, "state.json"));
  expect(existsSync(`${store.pathFor(runDir)}.tmp`)).toBe(false);
});

test("corrupt state returns null without a temporary file: validates the contract", () => {
  const cwd = mkdtempSync(join("/tmp", "file-run-state-store-corrupt-"));
  const store = new FileRunStateStore({ cwd, pipeline: "feature", ticket: "PROJ-1" });
  const runDir = store.resolveRunDir("feature", undefined, undefined, true);
  const runId = basename(runDir);

  writeFileSync(store.pathFor(runDir), "{broken");

  expect(store.load(runId)).toBeNull();
  expect(store.loadLatest("feature")).toBeNull();
  expect(existsSync(`${store.pathFor(runDir)}.tmp`)).toBe(false);
});

test("file-run-state-store: validates the integration contract", () => {
  const cwd = mkdtempSync(join("/tmp", "file-run-state-store-explicit-"));
  const store = new FileRunStateStore({ cwd });
  const runDir = join(cwd, "explicit-run");
  const run = persistedRun("explicit-run");

  store.saveAt(run, runDir);

  expect(existsSync(store.pathFor(runDir))).toBe(true);
  expect(existsSync(`${store.pathFor(runDir)}.tmp`)).toBe(false);
});

test("file-run-state-store: validates the integration contract", () => {
  const cwd = mkdtempSync(join("/tmp", "file-run-state-store-frozen-"));
  const store = new FileRunStateStore({ cwd });
  const runDir = join(cwd, "computed-id");
  const run = Object.freeze({
    name: "feature",
    pipeline: "feature",
    status: "PASS",
    steps: [],
  }) as PersistedRun;

  store.saveAt(run, runDir);

  expect(run).toEqual({ name: "feature", pipeline: "feature", status: "PASS", steps: [] });
  const saved = JSON.parse(readFileSync(store.pathFor(runDir), "utf8"));
  expect(saved).toMatchObject({ schemaVersion: 1, runId: "computed-id", name: "feature" });
  expect(saved.updatedAt).toBeString();
});

test("file-run-state-store: validates the integration contract", () => {
  const cwd = mkdtempSync(join("/tmp", "file-run-snapshot-catalog-"));
  const context = buildPipelineContext({ cwd, ticket: "PROJ-1" });
  const store = new FileRunStateStore({ context, pipeline: "feature", ticket: "PROJ-1" });
  const runDir = store.resolveRunDir("feature", "PROJ-1", undefined, true, context);
  const run = persistedRun(basename(runDir));
  store.saveAt(run, runDir);

  const snapshots = new FileRunSnapshotCatalog(context).list("PROJ-1");

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({
    runDir,
    statePath: join(runDir, "state.json"),
    isLatest: true,
    state: { runId: run.runId },
  });
  expect(snapshots[0]!.modifiedAt).toBeNumber();
});
