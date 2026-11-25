// `lancenuit stats` and the dashboard's statistics page list the same runs at the
// same amounts: both read the history through `readHistoryRuns`, each run from
// its snapshot while it still reads and from its `runs.jsonl` line once it is
// gone. Each case below is one way the two files of a run can differ on disk.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStats } from "../../src/dashboard/read-model/stats.js";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  writeHistory,
  writeProjectsFile,
  writeRun,
} from "../../src/dashboard/read-model/test-harness.js";
import type { RunSpend } from "../../src/run/index.js";
import { summarizeHistory } from "../../src/run/stats/history-runs.js";

afterEach(() => cleanupTempDirs());

const TICKET = "DEMO-1";
const control = (usd: number) => ({ duration_ms: 1, total_cost_usd: usd });

/** A cost as both screens can state it; `null` when neither prints a figure. */
type Printed = { usd?: number; estimated: boolean; floor: boolean } | null;

function printedSpend(spend: RunSpend): Printed {
  if (spend.usd === undefined && !spend.lowerBound) return null;
  return {
    ...(spend.usd !== undefined ? { usd: spend.usd } : {}),
    estimated: spend.estimated,
    floor: spend.lowerBound,
  };
}

test("stats: the CLI and the dashboard agree on every run, whichever record it is read from", () => {
  const home = makeTempDir("history-agree-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);

  // Resumed since its line was written: the snapshot holds the larger total.
  writeRun(project, TICKET, "feature", { runId: "resumed", status: "PASS", total_control: control(5) });
  // In flight, or its emission failed: no line yet.
  writeRun(project, TICKET, "review", { runId: "unprojected", status: "FAIL", total_control: control(2) });
  // Some spend could not be priced: a floor on both screens.
  writeRun(project, TICKET, "bugfix", {
    runId: "floor",
    status: "PASS",
    cost_unaccounted: true,
    total_control: control(1),
  });
  // Written in a format this release no longer reads.
  const oldDir = writeRun(project, TICKET, "lot", { runId: "old-format" });
  writeFileSync(join(oldDir, "state.json"), JSON.stringify({ schemaVersion: 2, runId: "old-format", steps: [] }));
  writeHistory(project, [
    { runId: "resumed", pipeline: "feature", ticket: TICKET, status: "FAIL", costUsd: 3 },
    { runId: "floor", pipeline: "bugfix", ticket: TICKET, status: "PASS", costUsd: 1, costUnknown: true },
    { runId: "old-format", pipeline: "lot", ticket: TICKET, status: "PASS", costUsd: 4, costStatus: "partial" },
    // Its run directory was deleted.
    { runId: "deleted", pipeline: "triage", ticket: TICKET, status: "PASS", costUsd: 0.75 },
    // Nothing priced it: unpriced on both screens, never $0.00.
    { runId: "unpriced", pipeline: "triage", ticket: TICKET, status: "PASS" },
    // Already inside its parent's total.
    { runId: "child", pipeline: "lot", ticket: TICKET, parentRunId: "deleted", costUsd: 0.5 },
  ]);

  const cli = new Map(
    summarizeHistory({ cwd: project, specPath: SPEC_PATH }).runs.map((run) => [
      run.entry.runId,
      printedSpend(run.spend),
    ]),
  );
  const env = { ...process.env, PIPELINE_HOME: home };
  const dashboard = new Map(
    readStats({ env }).tickets.flatMap((ticket) =>
      ticket.runs.map((run): [string, Printed] => [
        run.runId,
        run.cost
          ? {
              ...(run.cost.usd !== undefined ? { usd: run.cost.usd } : {}),
              estimated: run.cost.estimated,
              floor: run.cost.unknown === true,
            }
          : null,
      ]),
    ),
  );

  expect([...dashboard.keys()].sort()).toEqual([...cli.keys()].sort());
  expect(Object.fromEntries(dashboard)).toEqual(Object.fromEntries(cli));
  expect(Object.fromEntries(cli)).toEqual({
    resumed: { usd: 5, estimated: false, floor: false },
    unprojected: { usd: 2, estimated: false, floor: false },
    floor: { usd: 1, estimated: false, floor: true },
    "old-format": { usd: 4, estimated: true, floor: false },
    deleted: { usd: 0.75, estimated: false, floor: false },
    unpriced: null,
  });
});
