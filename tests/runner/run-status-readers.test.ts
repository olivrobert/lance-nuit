// Every reader of a run status gives the same answer, and none of them keeps its
// own copy of the rule: what a status means lives in
// `src/run-record/run-status.ts`, and the `≥` of a partial total in
// `costIsLowerBound`.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { closeLatestRun } from "../../src/commands/closure.js";
import { cleanLogs, inspectTicket } from "../../src/commands/diagnostics-readers.js";
import { loadPipelineConfig } from "../../src/env/config.js";
import type { PersistedRun } from "../../src/model/persisted.js";
import { readItem, readRecap, readStats, readSteps } from "../../src/modules/read-model/index.js";
import {
  cleanupTempDirs,
  DEAD_PID,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  writeProjectsFile,
  writeRun,
  writeRunLock,
} from "../../src/modules/read-model/test-harness.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";

afterEach(() => cleanupTempDirs());

const TICKET = "DEMO-1";

interface Listed {
  project: string;
  options: { env: NodeJS.ProcessEnv };
}

function listedProject(): Listed {
  const home = makeTempDir("run-status-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  return { project, options: { env: { ...process.env, PIPELINE_HOME: home } } };
}

/** A run a runner was executing, stepping through `coder`, last written long
 *  ago so the log retention reaches it. */
function runningRun(project: string, extra: Partial<PersistedRun> = {}): string {
  const runDir = writeRun(project, TICKET, "feature", {
    runId: "r-1",
    status: "RUNNING",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    steps: [
      { id: "plan", status: "done", retries: 0 },
      { id: "coder", status: "running", retries: 0 },
    ],
    ...extra,
  });
  const logDir = join(runDir, "steps", "coder", "attempt-001");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "output.log"), "what the agent said before it died\n");
  return runDir;
}

function contextFor(project: string) {
  return buildPipelineContext({
    cwd: project,
    ticket: TICKET,
    config: { ...loadPipelineConfig(project), specPath: SPEC_PATH },
  });
}

async function statusesOf({ project, options }: Listed) {
  const item = await readItem("demo-app", TICKET, options);
  const ticket = readStats(options).tickets.find((candidate) => candidate.ticket === TICKET);
  const inspected = await inspectTicket(contextFor(project), TICKET);
  return {
    sheet: item?.status,
    steps: readSteps("demo-app", TICKET, options)?.status,
    recap: readRecap("demo-app", TICKET, options)?.status,
    costs: ticket?.runs[0]?.status,
    inspect: /^status: (\w+)/m.exec(inspected)?.[1],
  };
}

test("a run whose runner died has the same status in every reader, and waits on somebody everywhere", async () => {
  const listed = listedProject();
  const runDir = runningRun(listed.project);
  writeRunLock(runDir, DEAD_PID);

  expect(await statusesOf(listed)).toEqual({
    sheet: "ABORTED",
    steps: "ABORTED",
    recap: "ABORTED",
    costs: "ABORTED",
    inspect: "ABORTED",
  });
  // The step it died in runs nowhere, on the step list as in the recap.
  const coder = (steps: Array<{ id: string; status: string }> | undefined) =>
    steps?.find((step) => step.id === "coder")?.status;
  expect(coder(readSteps("demo-app", TICKET, listed.options)?.steps)).toBe("aborted");
  expect(coder(readRecap("demo-app", TICKET, listed.options)?.steps)).toBe("aborted");

  // `clean --keep-failed` keeps what a person still has to look at.
  cleanLogs(contextFor(listed.project), TICKET, "1d", true);
  expect(existsSync(join(runDir, "steps", "coder", "attempt-001", "output.log"))).toBe(true);

  // The dashboard offers to close it, so `lancenuit close` accepts it.
  expect(closeLatestRun(listed.project, TICKET, "feature", "olivier")).toMatchObject({ ok: true });
});

test("a run a live runner holds is running in every reader, and nobody may close it", async () => {
  const listed = listedProject();
  const runDir = runningRun(listed.project);
  // The runner reads its own pid as its own lock, never as a foreign holder.
  writeRunLock(runDir, process.ppid);

  expect(await statusesOf(listed)).toEqual({
    sheet: "RUNNING",
    steps: "RUNNING",
    recap: "RUNNING",
    costs: "RUNNING",
    inspect: "RUNNING",
  });
  expect(closeLatestRun(listed.project, TICKET, "feature", "olivier")).toMatchObject({ ok: false });
  cleanLogs(contextFor(listed.project), TICKET, "1d", true);
  expect(existsSync(join(runDir, "steps", "coder", "attempt-001", "output.log"))).toBe(false);
});

/** A root run stepping through an orchestration node, and the child it composed:
 *  the child's directory never has a lock of its own, since it runs inside the
 *  root's process. The child was written last, so it is the run the item is
 *  about. */
function composedRuns(project: string): { parentDir: string; childDir: string } {
  const parentDir = writeRun(project, TICKET, "feature", {
    runId: "p-1",
    status: "RUNNING",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pipelineLineage: [{ pipelinePath: "/pipelines/feature.ts", ticket: TICKET }],
    steps: [{ id: "lots", status: "running", retries: 0 }],
  });
  const childDir = writeRun(project, TICKET, "lot", {
    runId: "c-1",
    status: "RUNNING",
    parentRunId: "p-1",
    parentNodeId: "lots",
    rootRunId: "p-1",
    updatedAt: "2026-01-01T00:00:01.000Z",
    pipelineLineage: [
      { pipelinePath: "/pipelines/feature.ts", ticket: TICKET },
      { pipelinePath: "/pipelines/lot.ts", ticket: TICKET },
    ],
    steps: [{ id: "coder", status: "running", retries: 0 }],
  });
  return { parentDir, childDir };
}

async function childStatusesOf({ project, options }: Listed) {
  const tree = await inspectTicket(contextFor(project), TICKET);
  const child = await inspectTicket(contextFor(project), TICKET, "c-1");
  return {
    sheet: (await readItem("demo-app", TICKET, options))?.status,
    steps: readSteps("demo-app", TICKET, options)?.status,
    tree: /^children:\n\s+(\w+)\s+lot \(c-1\)/m.exec(tree)?.[1],
    inspect: /^status: (.+)$/m.exec(child)?.[1],
  };
}

test("a composed child runs as long as the runner of its root lives, though its own directory has no lock", async () => {
  const listed = listedProject();
  const { parentDir, childDir } = composedRuns(listed.project);
  writeRunLock(parentDir, process.ppid);
  expect(existsSync(join(childDir, "runner.lock"))).toBe(false);

  expect(await childStatusesOf(listed)).toEqual({
    sheet: "RUNNING",
    steps: "RUNNING",
    tree: "RUNNING",
    inspect: "RUNNING",
  });
  expect(closeLatestRun(listed.project, TICKET, "lot", "olivier")).toMatchObject({ ok: false });
});

test("a composed child whose root's runner died is interrupted, like its root", async () => {
  const listed = listedProject();
  const { parentDir } = composedRuns(listed.project);
  writeRunLock(parentDir, DEAD_PID);

  expect(await childStatusesOf(listed)).toEqual({
    sheet: "ABORTED",
    steps: "ABORTED",
    tree: "ABORTED",
    inspect: "ABORTED (interrupted: the runner died without a verdict)",
  });
  expect(closeLatestRun(listed.project, TICKET, "lot", "olivier")).toMatchObject({ ok: true });
});

test("the ≥ of a partial total is the same on the sheet and on the costs page", async () => {
  const cases: Array<[string, Partial<PersistedRun>, boolean]> = [
    [
      "priced",
      { steps: [{ id: "coder", status: "done", retries: 0, control: { duration_ms: 1, total_cost_usd: 1 } }] },
      false,
    ],
    // The step's total is partial though the run totals were rewritten without
    // the flag: the sheet used to read the totals alone, the costs page the steps.
    [
      "a step priced in part",
      {
        steps: [
          {
            id: "coder",
            status: "done",
            retries: 0,
            control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true },
          },
        ],
      },
      true,
    ],
    ["the run-level latch", { cost_unaccounted: true, steps: [{ id: "coder", status: "done", retries: 0 }] }, true],
  ];
  for (const [label, run, partial] of cases) {
    const listed = listedProject();
    writeRun(listed.project, TICKET, "feature", {
      runId: "r-1",
      status: "PASS",
      total_control: { duration_ms: 1, total_cost_usd: 1 },
      ...run,
    });

    const item = await readItem("demo-app", TICKET, listed.options);
    const ticket = readStats(listed.options).tickets.find((candidate) => candidate.ticket === TICKET);
    expect({ label, sheet: item?.cost.unknown === true, costs: ticket?.runs[0]?.costUnknown === true }).toEqual({
      label,
      sheet: partial,
      costs: partial,
    });
  }
});

// ---------------------------------------------------------------------------
// No copy of the rule outside the run record
// ---------------------------------------------------------------------------

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "src");
const STATUS = "RUNNING|PASS|FAIL|STOPPED|ABORTED|UNKNOWN";

/** Comparing a status to `RUNNING` or `STOPPED` asks only whether the run is in
 *  that state, which needs no rule. Any other classification is a copy: a
 *  comparison to a status that carries a meaning (`PASS` is "completed", `FAIL`
 *  and `ABORTED` are failures), a `case`, a list of statuses, a regex of them,
 *  or a table keyed by status. */
const COPIES: readonly RegExp[] = [
  /[!=]==\s*"(PASS|FAIL|ABORTED|UNKNOWN)"/,
  /"(PASS|FAIL|ABORTED|UNKNOWN)"\s*[!=]==/,
  new RegExp(`case\\s+"(${STATUS})"\\s*:`),
  new RegExp(`"(${STATUS})"\\s*,\\s*"(${STATUS})"`),
  new RegExp(`\\b(${STATUS})\\|(${STATUS})\\b`),
  new RegExp(`^\\s*"?(${STATUS})"?\\s*:`, "m"),
];

/** Places that spell statuses without deciding anything with them. */
const EXCLUDED: ReadonlyArray<[string, string]> = [
  ["run-record/", "the owner of the rule"],
  ["model/persisted.ts", "the type that enumerates the statuses"],
  // The browser bundle may import nothing but types from the server: it renders
  // the statuses and the booleans the read model serves.
  ["modules/ui/app/", "the browser bundle"],
];

/** Lists of statuses that enumerate without classifying, one snippet each. */
const ALLOWED: ReadonlyArray<{ file: string; snippet: string; reason: string }> = [
  {
    file: "run-stats/history-schema.ts",
    snippet: `const RUN_STATS_STATUSES = [\n  "PASS",\n  "FAIL",\n  "STOPPED",\n  "ABORTED",\n  "UNKNOWN",\n]`,
    reason: "the values the history schema accepts",
  },
  {
    file: "run-stats/stats-core.ts",
    snippet: `const STATUS_BADGES: Readonly<Record<string, string>> = {\n  PASS: "✅ PASS",\n  FAIL: "❌ FAIL",\n  STOPPED: "⏹ STOPPED",\n  ABORTED: "🛑 ABORTED",\n};`,
    reason: "the console label of each status",
  },
  {
    file: "commands/stats.ts",
    snippet: `const order = ["PASS", "FAIL", "STOPPED", "ABORTED", "UNKNOWN"];`,
    reason: "the order `stats` prints its counts in",
  },
];

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.isFile() && /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** The code of a file without its comments, so a sentence that names statuses
 *  is never taken for a rule. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no reader outside the run record classifies a run status itself", () => {
  const copies: string[] = [];
  const unused: string[] = [];
  for (const file of productionSources(SRC)) {
    const path = relative(SRC, file);
    if (EXCLUDED.some(([prefix]) => path.startsWith(prefix))) continue;
    let code = codeOf(readFileSync(file, "utf8"));
    for (const allowed of ALLOWED.filter((entry) => entry.file === path)) {
      if (!code.includes(allowed.snippet)) unused.push(`${path}: ${allowed.reason}`);
      code = code.replace(allowed.snippet, "");
    }
    for (const pattern of COPIES) {
      const match = pattern.exec(code);
      if (match) copies.push(`${path}: ${match[0]}`);
    }
  }

  expect(unused).toEqual([]);
  expect(copies).toEqual([]);
});
