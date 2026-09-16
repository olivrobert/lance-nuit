import { expect, test } from "bun:test";
import { parseRunnerArgs } from "../cli/parse.js";
import { setLogInterceptor } from "../runtime/logging.js";
import { aggregateHistory, type HistoryEntry } from "../state/stats/history-reader.js";
import { COMMANDS } from "./command.js";
import { renderStats, statsCommand } from "./stats.js";
import { WRAPPER_COMMANDS } from "./wrapper-help.js";

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
    totals: { in: 1200, out: 340, cacheRead: 0, cacheWrite: 0 },
    models: {},
    profiles: {},
    ...overrides,
  } as HistoryEntry;
}

function render(entries: readonly HistoryEntry[]): string {
  return renderStats(entries, aggregateHistory(entries), "$");
}

test("stats: an empty history explains where to look instead of printing zeros", () => {
  expect(render([])).toContain("runs.jsonl");
});

test("stats: the summary reports status, cost, tokens, and the failing phase", () => {
  const output = render([
    entry({ runId: "a", costUsd: 3 }),
    entry({ runId: "b", status: "FAIL", failPhase: "implement", costUsd: 1 }),
  ]);

  expect(output).toContain("2 run(s)");
  expect(output).toContain("$4.00");
  expect(output).toContain("avg $2.00");
  expect(output).toContain("Failures per phase");
  expect(output).toContain("implement  1");
});

test("stats: an unpriced run is excluded from the total and named as such", () => {
  const output = render([entry({ runId: "a", costUsd: 2 }), entry({ runId: "b" })]);

  expect(output).toContain("$2.00");
  expect(output).toContain("1 unpriced, excluded");
});

test("stats: a run with an unpriced attempt turns the total into a lower bound", () => {
  const output = render([entry({ runId: "a", costUsd: 2 }), entry({ runId: "b", costUsd: 1, costUnknown: true })]);

  expect(output).toContain("≥ $3.00");
  expect(output).toContain("1 under-counted (unpriced attempts)");
  // The run list carries the same warning per line.
  expect(output).toContain("≥$1.00  b");
});

test("stats: a history with no cost anywhere says so rather than showing $0.00", () => {
  const output = render([entry({ runId: "a" })]);

  expect(output).toContain("cost unavailable");
  expect(output).not.toContain("$0.00");
});

test("stats: several pipelines get a breakdown, a single one does not repeat itself", () => {
  const many = render([entry({ runId: "a", pipeline: "feature" }), entry({ runId: "b", pipeline: "bugfix" })]);
  expect(many).toContain("Per pipeline");

  const one = render([entry({ runId: "a" })]);
  expect(one).not.toContain("Per pipeline");
  expect(one).toContain("avg duration 5m00s");
});

test("stats: excluded nested runs are explained, not silently dropped", () => {
  const entries = [entry({ runId: "parent" })];

  expect(renderStats(entries, aggregateHistory(entries, null, 2), "$")).toContain("2 nested run(s) excluded");
});

test("stats: the run list is bounded and says how much it withheld", () => {
  const entries = Array.from({ length: 4 }, (_unused, index) => entry({ runId: `run-${index}` }));

  const output = renderStats(entries, aggregateHistory(entries), "$", { runRows: 2 });

  expect(output).toContain("run-0");
  expect(output).toContain("... 2 more (use --limit)");
  expect(output).not.toContain("run-3");
});

test("stats: an invalid --since is refused before any history is read", () => {
  // `log` writes to stderr through this interceptor, not through console.
  const messages: string[] = [];
  setLogInterceptor(() => void 0);
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(statsCommand.run(parseRunnerArgs(["--stats", "--since", "yesterday"]))).toBe(1);
  } finally {
    process.stderr.write = original;
    setLogInterceptor(undefined);
  }
  expect(messages.join("")).toContain("Invalid duration");
});

test("stats: --limit bounds a stats listing as well as a scan", () => {
  expect(parseRunnerArgs(["--stats", "--limit", "5"]).limit).toBe(5);
  expect(() => parseRunnerArgs(["--limit", "5"])).toThrow("--scan or --stats");
});

test("stats: the filter options require --stats", () => {
  expect(() => parseRunnerArgs(["--since", "30d"])).toThrow("require --stats");
  expect(() => parseRunnerArgs(["--failures"])).toThrow("require --stats");
  expect(() => parseRunnerArgs(["--include-children"])).toThrow("require --stats");
  expect(parseRunnerArgs(["--stats", "--since", "30d", "--failures"]).since).toBe("30d");
});

test("stats: the command is registered and reachable through the wrapper verb", () => {
  expect(COMMANDS.map((command) => command.id)).toContain("stats");
  expect(WRAPPER_COMMANDS.find((command) => command.verb === "stats")?.flag).toBe("--stats");
});
