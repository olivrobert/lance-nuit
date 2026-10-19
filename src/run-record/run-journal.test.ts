import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PipelineContext } from "../model/context.js";
import type { RunJournalEvent } from "../model/journal.js";
import type { PersistedRun } from "../model/persisted.js";
import type { RunEventStore, RunStateStore } from "../model/storage-ports.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { appendRunEvent, readRunEvents, readRunJournal } from "./run-journal.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { loadOrCreateRun } from "../boot/resume.js";
import { commandRegistries } from "../commands/registries.js";

class MemoryRunEventStore implements RunEventStore {
  readonly events = new Map<string, RunJournalEvent[]>();

  constructor(private readonly calls: string[] = []) {}

  append(runId: string, event: RunJournalEvent): void {
    this.calls.push(`event:${event.type}`);
    const events = this.events.get(runId) ?? [];
    events.push(event);
    this.events.set(runId, events);
  }

  read(runId: string): RunJournalEvent[] {
    return this.events.get(runId) ?? [];
  }
}

class MemoryRunStateStore implements RunStateStore {
  snapshot: PersistedRun | null = null;

  constructor(
    private readonly runDir: string,
    private readonly calls: string[],
  ) {}

  load(_runId: string): PersistedRun | null {
    return this.snapshot;
  }

  loadLatest(_pipeline: string, _ticket?: string): PersistedRun | null {
    return this.snapshot;
  }

  save(run: PersistedRun): void {
    this.calls.push("snapshot");
    this.snapshot = run;
  }

  readAt(_runDir: string): PersistedRun | null {
    return this.snapshot;
  }

  saveAt(run: PersistedRun, _runDir: string): void {
    this.save(run);
  }

  resolveRunDir(
    _pipeline: string,
    _ticket?: string,
    _explicitRunDir?: string,
    _fresh?: boolean,
    _context?: PipelineContext,
  ): string {
    return this.runDir;
  }
}

test("appendRunEvent writes through the contract, readRunEvents reads back the union", () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-journal-fake-"));
  const eventStore = new MemoryRunEventStore();
  const run = { runId: "run-1", run_dir: runDir, eventStore };

  appendRunEvent(run, "run.started", { pipeline: "quality", ticket: null });
  appendRunEvent(run, "step.status.changed", { stepId: "quality", status: "running" });

  expect(readRunEvents(run).map((event) => ({ type: event.type, runId: event.runId }))).toEqual([
    { type: "run.started", runId: "run-1" },
    { type: "step.status.changed", runId: "run-1" },
  ]);
  expect(existsSync(join(runDir, "events.jsonl"))).toBe(false);
});

/**
 * A typo in a payload field name must not compile. This only holds while every
 * emission site passes its fields UNCONDITIONALLY: excess-property checking does
 * not reach a spread, so `...(cond ? { sessionid: x } : {})` would compile and
 * land in the journal. `exactOptionalPropertyTypes` is off, so an explicit
 * `undefined` is assignable and `JSON.stringify` drops it.
 */
test("appendRunEvent rejects a field the event type does not declare", () => {
  const eventStore = new MemoryRunEventStore();
  const run = { runId: "run-1", run_dir: "/unused", eventStore };

  // @ts-expect-error `sessionid` is not a field of `step.attempt.started`
  appendRunEvent(run, "step.attempt.started", { stepId: "quality", attempt: 1, sessionid: null });
  // @ts-expect-error `stepId` is required: an attempt with no step cannot be keyed
  appendRunEvent(run, "step.attempt.started", { attempt: 1 });
  // @ts-expect-error `run.started` carries no `stepId`
  appendRunEvent(run, "run.started", { pipeline: "quality", ticket: null, stepId: "quality" });
  // An explicit `undefined` on an optional field is accepted, and never written.
  appendRunEvent(run, "step.skipped", { stepId: "quality", reason: "skipped", freshness: undefined });

  expect(JSON.stringify(eventStore.events.get("run-1")?.at(-1))).not.toContain("freshness");
});

test("readRunJournal counts what a typed read leaves out", () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-journal-counts-"));
  const store = new FileRunEventStore({ runDir });
  const run = { runId: basename(runDir), run_dir: runDir, eventStore: store };

  appendRunEvent(run, "run.started", { pipeline: "quality", ticket: null });
  // What the live feed and a backend stream write into the same file.
  store.appendAt(runDir, { ts: "2026-08-01T10:00:00.000Z", type: "step.done" } as unknown as RunJournalEvent);
  // A contracted type whose payload is refused: kept, counted, never projected.
  store.appendAt(runDir, {
    ts: "2026-08-01T10:00:01.000Z",
    type: "step.attempt.started",
    attempt: 1,
  } as unknown as RunJournalEvent);
  writeFileSync(join(runDir, "events.jsonl"), `${readFileSync(join(runDir, "events.jsonl"), "utf-8")}{broken\n`);

  const report = readRunJournal(run);
  expect(report.entries.map((entry) => entry.kind)).toEqual(["known", "unknown", "invalid"]);
  expect({ skipped: report.skipped, invalid: report.invalid, unknown: report.unknown }).toEqual({
    skipped: 1,
    invalid: 1,
    unknown: 1,
  });
  expect(readRunEvents(run).map((event) => event.type)).toEqual(["run.started"]);
});

test("run-journal: validates the integration contract", () => {
  const eventStore: RunEventStore = {
    append: () => {
      throw new Error("observability unavailable");
    },
    read: () => {
      throw new Error("observability unavailable");
    },
  };
  const run = { runId: "run-1", run_dir: "/unused", eventStore };

  // A failed append must not stop the run; a failed read must not pass for an
  // empty journal, since the attempts and child-start facts live only here.
  expect(() => appendRunEvent(run, "run.started", { pipeline: "quality", ticket: null })).not.toThrow();
  expect(() => readRunEvents(run)).toThrow("observability unavailable");
});

test("run-journal: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-journal-loader-"));
  const runDir = join(root, "run");
  const pipelinePath = join(root, "pipeline.ts");
  writeFileSync(
    pipelinePath,
    `export default ({ pipeline, bashStep }) => pipeline("fixture").add(bashStep({ id: "inspect", name: "Inspect", command: "true" })).build();\n`,
  );
  const context = buildPipelineContext({ ...commandRegistries(), cwd: root, runnerBin: pipelinePath, runnerDir: root });
  const calls: string[] = [];
  const stateStore = new MemoryRunStateStore(runDir, calls);
  const eventStore = new MemoryRunEventStore(calls);

  const run = await loadOrCreateRun(pipelinePath, undefined, undefined, undefined, runDir, true, undefined, context, {
    stateStore,
    eventStore,
  });

  expect(run.eventStore).toBe(eventStore);
  expect(calls).toEqual(["snapshot", "event:run.started"]);
  expect(eventStore.read(basename(runDir)).map((event) => event.type)).toEqual(["run.started"]);

  calls.length = 0;
  const resumed = await loadOrCreateRun(
    pipelinePath,
    undefined,
    undefined,
    undefined,
    runDir,
    false,
    undefined,
    context,
    { stateStore, eventStore },
  );

  expect(resumed.eventStore).toBe(eventStore);
  expect(calls).toEqual(["event:run.resumed", "snapshot"]);
  expect(eventStore.read(basename(runDir)).map((event) => event.type)).toEqual(["run.started", "run.resumed"]);
});

test("readRunEvents tells an absent journal from an unreadable one", () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-journal-unreadable-"));

  expect(readRunEvents(runDir)).toEqual([]);
  expect(readRunJournal(runDir)).toEqual({ entries: [], skipped: 0, invalid: 0, unknown: 0 });

  mkdirSync(join(runDir, "events.jsonl"));
  expect(() => readRunEvents(runDir)).toThrow(/EISDIR/);
  expect(() => readRunEvents({ run_dir: runDir, runId: undefined, eventStore: undefined })).toThrow(/EISDIR/);
  expect(() => readRunJournal(runDir)).toThrow(/EISDIR/);
});
