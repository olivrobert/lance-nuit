// Non-regression on real-shaped `runs.jsonl` lines.
//
// `readHistory` is the one boundary that must never throw: the sink keeps lines
// it could not finish writing, so a single truncated write may not cost the
// whole file. These fixtures pin that policy line by line — a modern entry, one
// predating the newer fields, a corrupted one, one carrying a key this release
// does not know, and a child run.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory, summarizeHistory } from "./history-reader.js";
import { diagnoseHistoryEntry } from "./history-schema.js";

/** A complete line as the current projector writes it. */
const MODERN = {
  schemaVersion: 1,
  runId: "20260210-093000-feature",
  pipeline: "feature",
  ticket: "PROJ-42",
  ticketDir: "PROJ-42",
  parentRunId: null,
  lot: "lot-1",
  lotTitle: "Reader",
  sessionId: "sess-1",
  sessionProvider: "claude",
  startedAt: "2026-02-10T09:30:00.000Z",
  endedAt: "2026-02-10T09:45:00.000Z",
  status: "PASS",
  outcome: { phase: null, reason: null, logPath: null, resumable: false },
  failPhase: null,
  failReason: null,
  phases: {
    coder: {
      agents: 1,
      fixLoops: 0,
      tokens: { in: 1000, out: 200, cacheRead: 50, cacheWrite: 10 },
      provider: "claude",
      profile: "coder",
      costUsd: 0.25,
      usageStatus: "complete",
      costStatus: "complete",
    },
  },
  totals: { in: 1000, out: 200, cacheRead: 50, cacheWrite: 10 },
  usageStatus: "complete",
  costStatus: "complete",
  models: { "claude-sonnet-4-5": { in: 1000, out: 200, cacheRead: 50, cacheWrite: 10 } },
  profiles: { coder: { steps: 1, tokens: { in: 1000, out: 200, cacheRead: 50, cacheWrite: 10 }, costUsd: 0.25 } },
  commit: "abc1234",
  branch: "feature/PROJ-42",
  fixEvents: [{ kind: "fix", phase: "coder", iter: 1 }],
  sourceRunDir: ".lance-nuit/work-items/PROJ-42/runs/feature/20260210-093000-feature",
  warnings: [{ phase: "coder", reason: "usage event missing" }],
  costUsd: 0.25,
};

/** A line written before `parentRunId`, `lot`, `costStatus`, and `warnings`
 *  existed: the fields are simply absent, not null. */
const MINIMAL = {
  schemaVersion: 1,
  runId: "20250101-120000-bugfix",
  pipeline: "bugfix",
  ticket: "PROJ-7",
  ticketDir: "PROJ-7",
  sessionId: null,
  startedAt: "2025-01-01T12:00:00.000Z",
  endedAt: "2025-01-01T12:10:00.000Z",
  status: "FAIL",
  failPhase: "tests",
  failReason: "3 failing tests",
  phases: { tests: { agents: 1, fixLoops: 2, tokens: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 } } },
  totals: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 },
  models: {},
  profiles: {},
  commit: null,
  fixEvents: [],
  sourceRunDir: null,
};

/** A line from a later release: an unknown key must not cost the run. */
const FUTURE = {
  ...MODERN,
  runId: "20260301-101500-feature",
  startedAt: "2026-03-01T10:15:00.000Z",
  endedAt: "2026-03-01T10:20:00.000Z",
  costUsd: 1,
  reviewVerdict: { approved: true, reviewer: "release-42" },
};

/** A nested run: its usage is already folded into the parent's step control. */
const CHILD = {
  ...MODERN,
  runId: "20260210-093500-child",
  parentRunId: MODERN.runId,
  pipeline: "quality",
  startedAt: "2026-02-10T09:35:00.000Z",
  endedAt: "2026-02-10T09:40:00.000Z",
  costUsd: 0.1,
};

function historyRoot(lines: readonly string[]): string {
  const projRoot = mkdtempSync(join(tmpdir(), "history-fixtures-"));
  const dir = join(projRoot, ".lance-nuit", "pipeline-history");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runs.jsonl"), `${lines.join("\n")}\n`);
  return projRoot;
}

const FIXTURE_ROOT = () =>
  historyRoot([
    JSON.stringify(MINIMAL),
    JSON.stringify(MODERN),
    // Truncated write: the sink keeps the fragment, the reader must step over it.
    '{"schemaVersion":1,"runId":"20260210-094500-fea',
    JSON.stringify(CHILD),
    JSON.stringify(FUTURE),
  ]);

test("readHistory: every well-formed line survives, the truncated one does not", () => {
  const entries = readHistory(FIXTURE_ROOT());

  expect(entries.map((entry) => entry.runId)).toEqual([FUTURE.runId, CHILD.runId, MODERN.runId, MINIMAL.runId]);
});

test("readHistory: an entry predating a field stays readable and keeps its absent fields absent", () => {
  const minimal = readHistory(FIXTURE_ROOT()).find((entry) => entry.runId === MINIMAL.runId);

  expect(minimal).toBeDefined();
  expect(minimal?.pipeline).toBe("bugfix");
  expect("parentRunId" in minimal!).toBe(false);
  expect("costUsd" in minimal!).toBe(false);
  expect(minimal?.totals).toEqual({ in: 10, out: 5, cacheRead: 0, cacheWrite: 0 });
});

test("readHistory: a key this release does not know is preserved, not stripped", () => {
  const future = readHistory(FIXTURE_ROOT()).find((entry) => entry.runId === FUTURE.runId);

  expect((future as Record<string, unknown> | undefined)?.reviewVerdict).toEqual(FUTURE.reviewVerdict);
});

test("readHistory: a line that names no run is skipped, never thrown", () => {
  const projRoot = historyRoot([
    JSON.stringify(MODERN),
    JSON.stringify({ ...MODERN, runId: "", pipeline: "feature" }),
    JSON.stringify({ ...MODERN, runId: 42 }),
    JSON.stringify([MODERN]),
    "null",
  ]);

  expect(readHistory(projRoot).map((entry) => entry.runId)).toEqual([MODERN.runId]);
});

test("readHistory: a value this release does not know reads as absent, the line survives", () => {
  // A newer runner may write a status or a counter shape this reader has never
  // seen; dropping the line would silently under-report the spend.
  const projRoot = historyRoot([
    JSON.stringify({ ...MODERN, runId: "new-status", status: "CANCELLED", costUsd: 3 }),
    JSON.stringify({ ...MODERN, runId: "bad-totals", totals: "1000" }),
    JSON.stringify({
      ...MODERN,
      runId: "bad-phase-status",
      phases: { coder: { ...MODERN.phases.coder, usageStatus: "weird" } },
    }),
  ]);
  const entries = readHistory(projRoot);
  const byId = Object.fromEntries(entries.map((entry) => [entry.runId, entry]));

  expect(Object.keys(byId).sort()).toEqual(["bad-phase-status", "bad-totals", "new-status"]);
  // A caught value is written back as `undefined`, unlike a key that was never there.
  expect(byId["new-status"]?.status).toBeUndefined();
  expect(byId["new-status"]?.costUsd).toBe(3);
  expect(byId["bad-totals"]?.totals).toBeUndefined();
  expect(byId["bad-phase-status"]?.phases?.coder?.usageStatus).toBeUndefined();
  expect(byId["bad-phase-status"]?.phases?.coder?.tokens).toEqual(MODERN.phases.coder.tokens);
});

test("summarizeHistory: children are excluded from the totals but counted as skipped", () => {
  const { entries, aggregate } = summarizeHistory(FIXTURE_ROOT(), {}, null);

  expect(entries.map((entry) => entry.runId)).toEqual([FUTURE.runId, MODERN.runId, MINIMAL.runId]);
  expect(aggregate.childrenSkipped).toBe(1);
  expect(aggregate.byStatus).toEqual({ PASS: 2, FAIL: 1 });
  expect(aggregate.costUsd).toBeCloseTo(1.25, 10);
  // The minimal line carries no cost and no priceable model.
  expect(aggregate.costMissing).toBe(1);
});

test("diagnoseHistoryEntry: names the offending field, and stays silent on a valid line", () => {
  expect(diagnoseHistoryEntry(MODERN)).toBeUndefined();
  expect(diagnoseHistoryEntry(MINIMAL)).toBeUndefined();
  // An unknown value is not a defect of the line: it reads as absent.
  expect(diagnoseHistoryEntry({ ...MODERN, status: "CANCELLED" })).toBeUndefined();
  expect(diagnoseHistoryEntry({ pipeline: "feature" })).toContain("runId");
  expect(diagnoseHistoryEntry("not an object")).toBeDefined();
});
