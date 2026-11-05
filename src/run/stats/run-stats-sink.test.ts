import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitRunStats } from "./run-stats.js";
import type { RunStatsEntry } from "./run-stats-projector.js";
import { FileRunStatsSink } from "./run-stats-sink.js";

function entry(runId: string, status: RunStatsEntry["status"] = "PASS"): RunStatsEntry {
  return {
    schemaVersion: 1,
    runId,
    pipeline: "quality",
    ticket: "PROJ-42",
    ticketDir: "PROJ-42",
    sessionId: null,
    startedAt: null,
    endedAt: null,
    status,
    outcome: { phase: null, reason: null, logPath: null, resumable: false },
    failPhase: null,
    failReason: null,
    phases: {},
    totals: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    models: {},
    profiles: {},
    commit: null,
    branch: null,
    fixEvents: [],
    sourceRunDir: null,
  };
}

test("run-stats-sink: validates the integration contract", () => {
  const projRoot = mkdtempSync(join(tmpdir(), "run-stats-sink-"));
  const sink = new FileRunStatsSink({ projRoot });
  const first = entry("run-1");
  const centralPath = sink.write(first);
  expect(centralPath).toBe(join(projRoot, ".lance-nuit/pipeline-history/runs.jsonl"));
  expect(existsSync(join(projRoot, ".lance-nuit/work-items/PROJ-42/run-stats/run-1.json"))).toBe(false);

  const second = { ...first, status: "FAIL" as const };
  expect(sink.write(second)).toBe(centralPath);
  const history = readFileSync(centralPath!, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ runId: "run-1", schemaVersion: 1, status: "FAIL" });
});

test("emitRunStats uses the injected sink: validates the contract", () => {
  const projRoot = mkdtempSync(join(tmpdir(), "run-stats-custom-sink-"));
  const received: RunStatsEntry[] = [];
  const sink = {
    write(value: RunStatsEntry): string {
      received.push(value);
      return "memory://run-stats";
    },
  };
  const result = emitRunStats(
    {
      runId: "run-custom-sink",
      name: "quality",
      pipeline: "quality",
      pipeline_path: "quality.ts",
      run_dir: join(projRoot, "run"),
      steps: [],
    },
    { projRoot, sink },
  );

  expect(result).toBe("memory://run-stats");
  expect(received[0]).toMatchObject({ schemaVersion: 1, runId: "run-custom-sink", sourceRunDir: "run" });
  expect(existsSync(join(projRoot, ".lance-nuit/pipeline-history/runs.jsonl"))).toBe(false);
});
