import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateHistory,
  filterHistory,
  type HistoryEntry,
  pricingTable,
  readHistory,
  summarizeHistory,
} from "./history-reader.js";
import type { PricingTable } from "./stats-core.js";

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
  const entries = [entry({ runId: "parent" }), entry({ runId: "child", parentRunId: "parent" })];

  expect(filterHistory(entries).map((candidate) => candidate.runId)).toEqual(["parent"]);
  expect(filterHistory(entries, { includeChildren: true })).toHaveLength(2);
});

test("filterHistory: a line written before parentRunId existed reads as a root run", () => {
  const minimal = entry({ runId: "minimal" });
  delete (minimal as { parentRunId?: unknown }).parentRunId;

  expect(filterHistory([minimal])).toHaveLength(1);
});

test("filterHistory: pipeline, work item, failures, and recency narrow the set", () => {
  const entries = [
    entry({ runId: "a", pipeline: "feature", ticket: "PROJ-1", status: "PASS" }),
    entry({ runId: "b", pipeline: "bugfix", ticket: "PROJ-2", status: "FAIL" }),
    entry({ runId: "c", pipeline: "feature", ticket: "PROJ-2", status: "FAIL" }),
  ];

  expect(filterHistory(entries, { pipeline: "feature" }).map((c) => c.runId)).toEqual(["a", "c"]);
  expect(filterHistory(entries, { ticket: "PROJ-2" }).map((c) => c.runId)).toEqual(["b", "c"]);
  expect(filterHistory(entries, { failuresOnly: true }).map((c) => c.runId)).toEqual(["b", "c"]);
  expect(filterHistory(entries, { sinceMs: Date.parse("2026-01-11T00:00:00.000Z") })).toEqual([]);
  expect(filterHistory(entries, { sinceMs: Date.parse("2026-01-01T00:00:00.000Z") })).toHaveLength(3);
});

test("filterHistory: --since excludes a run with no usable timestamp", () => {
  const undated = entry({ runId: "undated", startedAt: null });

  expect(filterHistory([undated], { sinceMs: Date.parse("2020-01-01T00:00:00.000Z") })).toEqual([]);
});

test("aggregateHistory: sums tokens and per-pipeline status without inventing a cost", () => {
  const aggregate = aggregateHistory([
    entry({ runId: "a", pipeline: "feature", status: "PASS", costUsd: 1.5 }),
    entry({ runId: "b", pipeline: "feature", status: "FAIL", failPhase: "implement", costUsd: 0.5 }),
    entry({ runId: "c", pipeline: "bugfix", status: "PASS" }),
  ]);

  expect(aggregate.runs).toBe(3);
  expect(aggregate.byStatus).toEqual({ PASS: 2, FAIL: 1 });
  expect(aggregate.costUsd).toBeCloseTo(2);
  // The third run carries neither a written cost nor pricing: it is reported as
  // unpriced instead of counted as free.
  expect(aggregate.costMissing).toBe(1);
  expect(aggregate.costEstimated).toBe(0);
  expect(aggregate.tokens).toEqual({ in: 300, out: 60, cacheRead: 0, cacheWrite: 0 });
  expect(aggregate.byPipeline.feature?.runs).toBe(2);
  expect(aggregate.byPipeline.feature?.costUsd).toBeCloseTo(2);
  expect(aggregate.byPipeline.bugfix?.costMissing).toBe(1);
  expect(aggregate.byFailPhase).toEqual({ implement: 1 });
  expect(aggregate.firstStartedAt).toBe("2026-01-10T10:00:00.000Z");
});

test("aggregateHistory: a cost derived from pricing.json is flagged as an estimate", () => {
  const pricing: PricingTable = { opus: { in: 1_000_000, out: 1_000_000 } };

  const aggregate = aggregateHistory(
    [entry({ runId: "a", models: { opus: { in: 2, out: 3, cacheRead: 0, cacheWrite: 0 } } })],
    pricing,
  );

  expect(aggregate.costUsd).toBeCloseTo(5);
  expect(aggregate.costEstimated).toBe(1);
  expect(aggregate.costMissing).toBe(0);
});

test("aggregateHistory: a written cost outranks the pricing estimate", () => {
  const pricing: PricingTable = { opus: { in: 1_000_000 } };

  const aggregate = aggregateHistory(
    [entry({ runId: "a", costUsd: 0.25, models: { opus: { in: 99, out: 0, cacheRead: 0, cacheWrite: 0 } } })],
    pricing,
  );

  expect(aggregate.costUsd).toBeCloseTo(0.25);
  expect(aggregate.costEstimated).toBe(0);
});

test("aggregateHistory: a run with an unpriced attempt is summed but counted as under-counted", () => {
  const aggregate = aggregateHistory([
    entry({ runId: "a", costUsd: 2 }),
    entry({ runId: "b", costUsd: 1, costUnknown: true }),
  ]);

  expect(aggregate.costUsd).toBeCloseTo(3);
  expect(aggregate.costUnderCounted).toBe(1);
  expect(aggregate.costEstimated).toBe(0);
  expect(aggregate.costMissing).toBe(0);
  expect(aggregate.byPipeline.feature?.costUnderCounted).toBe(1);
});

test("aggregateHistory: per-profile totals accumulate across runs", () => {
  const aggregate = aggregateHistory([
    entry({
      runId: "a",
      profiles: { coder: { steps: 2, tokens: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 } },
    }),
    entry({
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

  const { entries, aggregate } = summarizeHistory(projRoot, { pipeline: "feature" }, null);

  expect(entries.map((candidate) => candidate.runId)).toEqual(["parent"]);
  // Only the `feature` child counts: the summary must explain itself, not the file.
  expect(aggregate.childrenSkipped).toBe(1);
});

test("aggregateHistory: a runner figure computed from a rate table is an estimate, not exact", () => {
  // Codex, opencode without a provider cost, or a killed Claude attempt: the runner
  // writes `costUsd` but marks it `costStatus: "partial"`. Reading it as exact hid
  // every estimate the runner itself made.
  const aggregate = aggregateHistory([
    entry({ runId: "a", costUsd: 2 }),
    entry({ runId: "b", costUsd: 1, costStatus: "partial" }),
  ]);

  expect(aggregate.costUsd).toBeCloseTo(3);
  expect(aggregate.costEstimated).toBe(1);
  expect(aggregate.byPipeline.feature?.costEstimated).toBe(1);
});

test("pricingTable: a non-USD pricing.json is dropped, as the runtime drops it", () => {
  // The runner's `costUsd` is always in dollars; estimating the remaining runs in
  // euros and summing the two printed a total in no currency at all.
  expect(pricingTable({ _currency: "€", opus: { in: 1, out: 2 } })).toBeNull();
  expect(pricingTable({ _currency: "$", opus: { in: 1, out: 2 } })).toEqual({
    _currency: "$",
    opus: { in: 1, out: 2 },
  });
  expect(pricingTable({ opus: { in: 1, out: 2 } })).toEqual({ opus: { in: 1, out: 2 } });
  expect(pricingTable(null)).toBeNull();
});
