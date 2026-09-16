import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PipelineContext } from "../../model/context.js";
import type { PersistedRun, PersistedStepState } from "../../model/persisted.js";
import type { RunStateStore } from "../../model/storage-ports.js";
import { buildPipelineContext } from "../../pipeline/context.js";
import { loadOrCreateRun } from "../../boot/resume.js";
import { isPersistedRunComplete, isPersistedRunResumable } from "../run-predicates.js";
import { commandRegistries } from "../../commands/registries.js";

interface SaveAtCall {
  snapshot: PersistedRun;
  runDir: string;
}

class MemoryRunStateStore implements RunStateStore {
  readonly snapshots = new Map<string, PersistedRun>();

  readonly calls = {
    load: [] as string[],
    loadLatest: [] as Array<{ pipeline: string; ticket?: string }>,
    save: [] as PersistedRun[],
    saveAt: [] as SaveAtCall[],
    resolveRunDir: [] as Array<{
      pipeline: string;
      ticket?: string;
      explicitRunDir?: string;
      fresh?: boolean;
      context?: PipelineContext;
    }>,
  };

  constructor(private readonly root: string) {}

  load(runId: string): PersistedRun | null {
    this.calls.load.push(runId);
    return this.snapshots.get(runId) ?? null;
  }

  loadLatest(pipeline: string, ticket?: string): PersistedRun | null {
    this.calls.loadLatest.push({ pipeline, ticket });
    return (
      [...this.snapshots.values()].find((snapshot) => snapshot.pipeline === pipeline && snapshot.ticket === ticket) ??
      null
    );
  }

  save(snapshot: PersistedRun): void {
    this.calls.save.push(snapshot);
    this.remember(snapshot);
  }

  saveAt(snapshot: PersistedRun, runDir: string): void {
    this.calls.saveAt.push({ snapshot, runDir });
    this.remember(snapshot);
  }

  resolveRunDir(
    pipeline: string,
    ticket?: string,
    explicitRunDir?: string,
    fresh?: boolean,
    context?: PipelineContext,
  ): string {
    this.calls.resolveRunDir.push({ pipeline, ticket, explicitRunDir, fresh, context });
    return explicitRunDir ?? join(this.root, pipeline, ticket ?? "unticketed", "run");
  }

  private remember(snapshot: PersistedRun): void {
    if (snapshot.runId) this.snapshots.set(snapshot.runId, snapshot);
  }
}

/** Adapter limited to the required contract: the store does not know technical
 * location, only the latest snapshot. */
class RequiredOnlyRunStateStore implements RunStateStore {
  snapshot: PersistedRun | null = null;

  readonly loadCalls: string[] = [];

  readonly latestCalls: Array<{ pipeline: string; ticket?: string }> = [];

  load(runId: string): PersistedRun | null {
    this.loadCalls.push(runId);
    return null;
  }

  loadLatest(pipeline: string, ticket?: string): PersistedRun | null {
    this.latestCalls.push({ pipeline, ticket });
    return this.snapshot?.pipeline === pipeline && this.snapshot?.ticket === ticket ? this.snapshot : null;
  }

  save(snapshot: PersistedRun): void {
    this.snapshot = snapshot;
  }
}

function writePipelineFixture(dir: string): string {
  const pipelinePath = join(dir, "pipeline-fixture.ts");
  writeFileSync(
    pipelinePath,
    `export default ({ pipeline, bashStep }) => pipeline("fixture").add(bashStep({ id: "inspect", name: "Inspect", command: "true" })).build();\n`,
  );
  return pipelinePath;
}

function persistedRun(
  statuses: PersistedStepState["status"][],
  status: PersistedRun["status"] = "RUNNING",
): PersistedRun {
  return {
    schemaVersion: 1,
    runId: "fixture-run",
    name: "fixture",
    pipeline: "fixture",
    status,
    steps: statuses.map((stepStatus, index) => ({
      id: `step-${index}`,
      status: stepStatus,
      retries: 0,
    })),
  };
}

test("run-state-store: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-state-store-"));
  const pipelinePath = writePipelineFixture(root);
  const runDir = join(root, "memory-run");
  const store = new MemoryRunStateStore(root);
  const context: PipelineContext = buildPipelineContext({
    ...commandRegistries(),
    cwd: root,
    runnerBin: join(root, "runner.ts"),
    runnerDir: root,
  });

  const run = await loadOrCreateRun(pipelinePath, undefined, undefined, undefined, runDir, true, undefined, context, {
    stateStore: store,
  });

  expect(run.run_dir).toBe(runDir);
  expect(run.stateStore).toBe(store);
  expect(store.calls.resolveRunDir).toHaveLength(1);
  expect(store.calls.resolveRunDir[0]).toMatchObject({
    pipeline: "fixture",
    explicitRunDir: runDir,
    fresh: true,
  });
  expect(store.calls.load).toEqual([basename(runDir)]);
  expect(store.calls.save).toHaveLength(0);
  expect(store.calls.saveAt).toHaveLength(1);
  expect(store.calls.saveAt[0]).toMatchObject({
    runDir,
    snapshot: {
      schemaVersion: 1,
      runId: basename(runDir),
      name: "fixture",
      pipeline: "fixture",
      steps: [{ id: "inspect", status: "pending" }],
    },
  });
  expect(store.loadLatest("fixture")).toBe(store.calls.saveAt[0]?.snapshot);
  expect(existsSync(join(runDir, "state.json"))).toBe(false);

  const resumed = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    false,
    undefined,
    context,
    { stateStore: store },
  );

  expect(resumed.runId).toBe(run.runId);
  expect(store.calls.load).toEqual([basename(runDir), basename(runDir)]);
  expect(store.calls.saveAt).toHaveLength(2);
  expect(existsSync(join(runDir, "state.json"))).toBe(false);
});

test("loadOrCreateRun resumes via loadLatest for has store without extension local: validates the contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-state-required-only-"));
  const pipelinePath = writePipelineFixture(root);
  const store = new RequiredOnlyRunStateStore();
  const context = buildPipelineContext({
    ...commandRegistries(),
    cwd: root,
    ticket: "PROJ-1",
    runnerBin: join(root, "runner.ts"),
    runnerDir: root,
  });

  const first = await loadOrCreateRun(
    pipelinePath,
    "PROJ-1",
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    context,
    { stateStore: store },
  );
  const resumed = await loadOrCreateRun(
    pipelinePath,
    "PROJ-1",
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    context,
    { stateStore: store },
  );

  expect(resumed.runId).toBe(first.runId);
  expect(store.loadCalls).toEqual([]);
  expect(store.latestCalls).toHaveLength(2);
});

test("run-state-store: validates the integration contract", () => {
  const cases: Array<{
    label: string;
    run: PersistedRun | null;
    resumable: boolean;
    complete: boolean;
  }> = [
    { label: "pending", run: persistedRun(["pending"]), resumable: true, complete: false },
    { label: "running", run: persistedRun(["running"]), resumable: true, complete: false },
    { label: "failed", run: persistedRun(["failed"]), resumable: true, complete: false },
    { label: "PASS", run: persistedRun(["done", "skipped"], "PASS"), resumable: false, complete: true },
    {
      label: "ABORTED",
      run: { ...persistedRun(["pending"], "ABORTED"), aborted: true },
      resumable: true,
      complete: false,
    },
    {
      label: "ABORTED opted out",
      run: {
        ...persistedRun(["pending"], "ABORTED"),
        aborted: true,
        outcome: { phase: null, reason: "SIGINT", logPath: null, resumable: false },
      },
      resumable: false,
      complete: false,
    },
    // SIGINT with no step in flight: every step is settled but finalizeRun never
    // ran, so the run still owes a verdict and must resume to produce one.
    {
      label: "ABORTED settled",
      run: { ...persistedRun(["done", "skipped"], "ABORTED"), aborted: true },
      resumable: true,
      complete: false,
    },
    {
      label: "ABORTED settled opted out",
      run: {
        ...persistedRun(["done", "skipped"], "ABORTED"),
        aborted: true,
        outcome: { phase: null, reason: "SIGINT", logPath: null, resumable: false },
      },
      resumable: false,
      complete: false,
    },
    // Corrupt JSON and missing files normalize to null.
    { label: "corruption", run: null, resumable: false, complete: false },
    { label: "absent", run: null, resumable: false, complete: false },
  ];

  for (const scenario of cases) {
    expect(isPersistedRunResumable(scenario.run), scenario.label).toBe(scenario.resumable);
    expect(isPersistedRunComplete(scenario.run), scenario.label).toBe(scenario.complete);
  }
});
