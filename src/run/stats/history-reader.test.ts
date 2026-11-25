import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateHistory, filterHistory, type HistoryEntry, type HistoryRun, readHistory } from "./history-reader.js";
import { lineSpend, summarizeHistory } from "./history-runs.js";

function historyRoot(lines: readonly string[]): string {
  const projRoot = mkdtempSync(join(tmpdir(), "history-reader-"));
  const dir = join(projRoot, ".lance-nuit", "pipeline-history");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runs.jsonl"), `${lines.join("\n")}\n`);
  return projRoot;
}

function entry(overrides: Partial<HistoryEntry> & { runId: string }): HistoryEntry {
  return {
    schemaVersion: 1,
    pipeline: "feature",
    ticket: "PROJ-1",
    parentRunId: null,
    status: "PASS",
    startedAt: "2026-01-10T10:00:00.000Z",
    endedAt: "2026-01-10T10:05:00.000Z",
    failPhase: null,
    totals: { in: 100, out: 20, cacheRead: 0, cacheWrite: 0 },
    models: {},
    profiles: {},
    ...overrides,
  } as HistoryEntry;
}

const line = (value: Partial<HistoryEntry> & { runId: string }): string => JSON.stringify(entry(value));

/** A run whose snapshot is gone: read from its line alone. */
const fromLine = (value: Partial<HistoryEntry> & { runId: string }): HistoryRun => {
  const read = entry(value);
  return { entry: read, spend: lineSpend(read) };
};

const ids = (runs: readonly HistoryRun[]): string[] => runs.map((run) => run.entry.runId);

test("readHistory: skips malformed lines and returns the newest run first", () => {
  const projRoot = historyRoot([
    line({ runId: "old", startedAt: "2026-01-01T00:00:00.000Z" }),
    "{ not json",
    "[]",
    JSON.stringify({ pipeline: "feature" }),
    line({ runId: "recent", startedAt: "2026-02-01T00:00:00.000Z" }),
  ]);

  const entries = readHistory(projRoot);

  expect(entries.map((candidate) => candidate.runId)).toEqual(["recent", "old"]);
});

test("readHistory: a missing history reads as empty rather than throwing", () => {
  expect(readHistory(mkdtempSync(join(tmpdir(), "history-reader-empty-")))).toEqual([]);
});

test("filterHistory: drops nested runs by default because the parent already counts them", () => {
  const entries = [fromLine({ runId: "parent" }), fromLine({ runId: "child", parentRunId: "parent" })];

  expect(ids(filterHistory(entries))).toEqual(["parent"]);
  expect(filterHistory(entries, { includeChildren: true })).toHaveLength(2);
});

test("filterHistory: a line written before parentRunId existed reads as a root run", () => {
  const minimal = fromLine({ runId: "minimal" });
  delete (minimal.entry as { parentRunId?: unknown }).parentRunId;

  expect(filterHistory([minimal])).toHaveLength(1);
});

test("filterHistory: pipeline, work item, failures, and recency narrow the set", () => {
  const entries = [
    fromLine({ runId: "a", pipeline: "feature", ticket: "PROJ-1", status: "PASS" }),
    fromLine({ runId: "b", pipeline: "bugfix", ticket: "PROJ-2", status: "FAIL" }),
    fromLine({ runId: "c", pipeline: "feature", ticket: "PROJ-2", status: "FAIL" }),
  ];

  expect(ids(filterHistory(entries, { pipeline: "feature" }))).toEqual(["a", "c"]);
  expect(ids(filterHistory(entries, { ticket: "PROJ-2" }))).toEqual(["b", "c"]);
  expect(ids(filterHistory(entries, { failuresOnly: true }))).toEqual(["b", "c"]);
  expect(filterHistory(entries, { sinceMs: Date.parse("2026-01-11T00:00:00.000Z") })).toEqual([]);
  expect(filterHistory(entries, { sinceMs: Date.parse("2026-01-01T00:00:00.000Z") })).toHaveLength(3);
});

test("filterHistory: --since excludes a run with no usable timestamp", () => {
  const undated = fromLine({ runId: "undated", startedAt: null });

  expect(filterHistory([undated], { sinceMs: Date.parse("2020-01-01T00:00:00.000Z") })).toEqual([]);
});

test("aggregateHistory: sums tokens and per-pipeline status without inventing a cost", () => {
  const aggregate = aggregateHistory([
    fromLine({ runId: "a", pipeline: "feature", status: "PASS", costUsd: 1.5 }),
    fromLine({ runId: "b", pipeline: "feature", status: "FAIL", failPhase: "implement", costUsd: 0.5 }),
    fromLine({ runId: "c", pipeline: "bugfix", status: "PASS" }),
  ]);

  expect(aggregate.runs).toBe(3);
  expect(aggregate.byStatus).toEqual({ PASS: 2, FAIL: 1 });
  expect(aggregate.costUsd).toBeCloseTo(2);
  // The third run reported no amount: it is reported as unpriced instead of
  // counted as free.
  expect(aggregate.costMissing).toBe(1);
  expect(aggregate.costEstimated).toBe(0);
  expect(aggregate.tokens).toEqual({ in: 300, out: 60, cacheRead: 0, cacheWrite: 0 });
  expect(aggregate.byPipeline.feature?.runs).toBe(2);
  expect(aggregate.byPipeline.feature?.costUsd).toBeCloseTo(2);
  expect(aggregate.byPipeline.bugfix?.costMissing).toBe(1);
  expect(aggregate.byFailPhase).toEqual({ implement: 1 });
  expect(aggregate.firstStartedAt).toBe("2026-01-10T10:00:00.000Z");
});

test("aggregateHistory: a run with an unpriced attempt is summed but counted as under-counted", () => {
  const aggregate = aggregateHistory([
    fromLine({ runId: "a", costUsd: 2 }),
    fromLine({ runId: "b", costUsd: 1, costUnknown: true }),
  ]);

  expect(aggregate.costUsd).toBeCloseTo(3);
  expect(aggregate.costUnderCounted).toBe(1);
  expect(aggregate.costEstimated).toBe(0);
  expect(aggregate.costMissing).toBe(0);
  expect(aggregate.byPipeline.feature?.costUnderCounted).toBe(1);
});

test("aggregateHistory: per-profile totals accumulate across runs", () => {
  const aggregate = aggregateHistory([
    fromLine({
      runId: "a",
      profiles: { coder: { steps: 2, tokens: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 } },
    }),
    fromLine({
      runId: "b",
      profiles: { coder: { steps: 1, tokens: { in: 4, out: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 } },
    }),
  ]);

  expect(aggregate.byProfile.coder).toEqual({
    steps: 3,
    tokens: { in: 14, out: 6, cacheRead: 0, cacheWrite: 0 },
    costUsd: 1.5,
  });
});

test("summarizeHistory: reports the nested runs the same filter would have kept", () => {
  const projRoot = historyRoot([
    line({ runId: "parent", pipeline: "feature" }),
    line({ runId: "child", pipeline: "feature", parentRunId: "parent" }),
    line({ runId: "other-child", pipeline: "bugfix", parentRunId: "elsewhere" }),
  ]);

  const { runs, aggregate } = summarizeHistory(
    { cwd: projRoot, specPath: ".lance-nuit/work-items" },
    { pipeline: "feature" },
  );

  expect(ids(runs)).toEqual(["parent"]);
  // Only the `feature` child counts: the summary must explain itself, not the file.
  expect(aggregate.childrenSkipped).toBe(1);
});

test("aggregateHistory: a runner figure computed from a rate table is an estimate, not exact", () => {
  // Codex, opencode without a provider cost, or a killed Claude attempt: the runner
  // writes `costUsd` but marks it `costStatus: "partial"`. Reading it as exact hid
  // every estimate the runner itself made.
  const aggregate = aggregateHistory([
    fromLine({ runId: "a", costUsd: 2 }),
    fromLine({ runId: "b", costUsd: 1, costStatus: "partial" }),
  ]);

  expect(aggregate.costUsd).toBeCloseTo(3);
  expect(aggregate.costEstimated).toBe(1);
  expect(aggregate.byPipeline.feature?.costEstimated).toBe(1);
});
