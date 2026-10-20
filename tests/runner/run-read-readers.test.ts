// Every reader of a run takes it from the run record (`readRun`, `readRunHistory`):
// a runner that died after its journal recorded a step finished, and before its
// snapshot did, leaves the same steps and the same attempts in every view, and
// no code outside `src/run-record/` reads the snapshot or the journal by another
// path.

import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { closeLatestRun } from "../../src/commands/closure.js";
import { inspectTicket } from "../../src/commands/diagnostics-readers.js";
import { loadPipelineConfig } from "../../src/env/config.js";
import {
  readItem,
  readRecap,
  readRunJourney,
  readStats,
  readStepDetail,
  readSteps,
} from "../../src/modules/read-model/index.js";
import {
  cleanupTempDirs,
  DEAD_PID,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  writeProjectsFile,
  writeRun,
  writeRunEvents,
  writeRunLock,
} from "../../src/modules/read-model/test-harness.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";

afterEach(() => cleanupTempDirs());

const TICKET = "DEMO-1";

function listedProject(): { project: string; options: { env: NodeJS.ProcessEnv } } {
  const home = makeTempDir("run-read-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  return { project, options: { env: { ...process.env, PIPELINE_HOME: home } } };
}

/** The runner recorded `coder`'s attempt and its `done` in the journal, then
 *  died before rewriting the snapshot, which still says `running`. */
function runBehindItsJournal(project: string): string {
  const runDir = writeRun(project, TICKET, "feature", {
    runId: "r-1",
    status: "RUNNING",
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:04:00.000Z",
    steps: [
      { id: "plan", status: "done", retries: 0 },
      { id: "coder", status: "running", retries: 0 },
      { id: "review", status: "pending", retries: 0 },
    ],
  });
  writeRunEvents(runDir, [
    { ts: "2026-09-05T08:01:00.000Z", type: "step.attempt.started", stepId: "plan", attempt: 1, kind: "step" },
    {
      ts: "2026-09-05T08:02:00.000Z",
      type: "step.attempt.finished",
      stepId: "plan",
      attempt: 1,
      kind: "step",
      status: "done",
    },
    { ts: "2026-09-05T08:02:01.000Z", type: "step.status.changed", stepId: "plan", status: "done" },
    { ts: "2026-09-05T08:03:00.000Z", type: "step.status.changed", stepId: "coder", status: "running" },
    { ts: "2026-09-05T08:03:01.000Z", type: "step.attempt.started", stepId: "coder", attempt: 1, kind: "step" },
    {
      ts: "2026-09-05T08:05:00.000Z",
      type: "step.attempt.finished",
      stepId: "coder",
      attempt: 1,
      kind: "step",
      status: "done",
    },
    { ts: "2026-09-05T08:05:01.000Z", type: "step.status.changed", stepId: "coder", status: "done" },
  ]);
  writeRunLock(runDir, DEAD_PID);
  return runDir;
}

function contextFor(project: string) {
  return buildPipelineContext({
    cwd: project,
    ticket: TICKET,
    config: { ...loadPipelineConfig(project), specPath: SPEC_PATH },
  });
}

type Steps = Array<{ id: string; status: string }> | undefined;
const statusesOf = (steps: Steps) => steps?.map((step) => `${step.id}:${step.status}`);

/** `  done     coder` lines of `--inspect`, as `id:status`. */
function inspectedSteps(report: string): string[] {
  const lines = report.slice(report.indexOf("steps:\n") + "steps:\n".length).split("\n");
  return lines
    .map((line) => /^ {2}(\w+)\s+(\S+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => `${match[2]}:${match[1]}`);
}

test("a run behind its journal reads the same status, steps and attempts in every reader", async () => {
  const { project, options } = listedProject();
  runBehindItsJournal(project);
  const expected = ["plan:done", "coder:done", "review:pending"];

  const item = await readItem("demo-app", TICKET, options);
  const steps = readSteps("demo-app", TICKET, options);
  const recap = readRecap("demo-app", TICKET, options);
  const costs = readStats(options).tickets.find((ticket) => ticket.ticket === TICKET)?.runs[0];
  const inspected = await inspectTicket(contextFor(project), TICKET);

  expect({
    sheet: item?.status,
    steps: steps?.status,
    recap: recap?.status,
    costs: costs?.status,
    inspect: /^status: (\w+)/m.exec(inspected)?.[1],
  }).toEqual({ sheet: "ABORTED", steps: "ABORTED", recap: "ABORTED", costs: "ABORTED", inspect: "ABORTED" });

  expect(statusesOf(steps?.steps)).toEqual(expected);
  // Before the run record owned the read, the recap and `--inspect` read the
  // snapshot alone: `coder` was `aborted` in one and `running` in the other.
  expect(statusesOf(recap?.steps)).toEqual(expected);
  expect(inspectedSteps(inspected)).toEqual(expected);
  // The runner died between two steps, in none of them: the item names no
  // phase rather than the step the journal knows finished.
  expect(item?.failure?.phase).toBe("");

  const detail = readStepDetail("demo-app", TICKET, "coder", undefined, options);
  const journey = readRunJourney("demo-app", TICKET, options);
  expect(detail?.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([[1, "done"]]);
  expect(
    journey?.attempts
      .filter((attempt) => attempt.stepId === "coder")
      .map((attempt) => [attempt.attempt, attempt.status]),
  ).toEqual([[1, "done"]]);

  expect(closeLatestRun(project, TICKET, "feature", "olivier")).toMatchObject({ ok: true });
});

test("a run a live runner holds is read from its snapshot, without parsing its journal", () => {
  const { project, options } = listedProject();
  const runDir = runBehindItsJournal(project);
  writeRunLock(runDir, process.ppid);

  expect(readSteps("demo-app", TICKET, options)).toMatchObject({ status: "RUNNING" });
  // At most one write behind: the snapshot follows the event it lags.
  expect(statusesOf(readSteps("demo-app", TICKET, options)?.steps)).toEqual([
    "plan:done",
    "coder:running",
    "review:pending",
  ]);
});

// ---------------------------------------------------------------------------
// One read path
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

/** What reads a run without the projection: the stores and the projection
 *  itself, the raw snapshot and journal readers, and the file names. */
const RAW_READS =
  /\b(FileRunStateStore|FileRunEventStore|projectRunState|projectStepAttempts|readRunSnapshot|readRunEvents|readRunSnapshotDiagnostic|resolveLatestRunSnapshot)\b|["'`](state\.json|events\.jsonl)["'`]/g;

/**
 * The files outside the run record that still name a raw read, each with why.
 * Opening a run to execute it is boot's until the run record owns it.
 */
const ALLOWED: Record<string, string[]> = {
  // Opening and restoring a run before executing it.
  "boot/resume.ts": [
    "FileRunEventStore",
    "FileRunStateStore",
    "projectRunState",
    "readRunEvents",
    "readRunSnapshotDiagnostic",
  ],
  "entry/startup.ts": ["FileRunStateStore", "resolveLatestRunSnapshot"],
  "step/pipeline-orchestration-child.ts": ["FileRunStateStore", '"state.json"'],
  // The journal of the run this process just executed, handed to the statistics
  // projection as its event store.
  "run-stats/run-stats.ts": ["FileRunEventStore"],
  // The default store `--inspect`, `--logs` and `clean` list snapshots from;
  // each listed snapshot is then read through `readListedRun`.
  "commands/diagnostics-readers.ts": ["FileRunStateStore"],
  "commands/diagnostics.ts": ["FileRunStateStore"],
  // The tmux watcher greps the verdict out of the file to close its pane.
  "output/watcher.ts": ['"state.json"'],
  // The console report prints where the journal is, for a human to open.
  "output/run-report.ts": ['"events.jsonl"'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "run-record" && dir === SRC ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Comments name the readers to explain them; only code reads. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("no code outside the run record reads a snapshot or a journal by another path", () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file);
    // Fixture writers for the read model's tests, never loaded by the runner.
    if (name === "modules/read-model/test-harness.ts") continue;
    const reads = [...new Set(code(readFileSync(file, "utf-8")).match(RAW_READS) ?? [])].sort();
    if (reads.length > 0) found[name] = reads;
  }
  const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, reads]) => [file, [...reads].sort()]));
  expect(found).toEqual(allowed);
});
