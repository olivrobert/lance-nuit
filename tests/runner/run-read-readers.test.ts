// Every reader of a run takes it from the run record (`readRun`, `readRunHistory`):
// a runner that died inside a step leaves the same steps and the same attempts in every view, and
// no code outside `src/run/record/` reads the snapshot or the journal by another
// path.

import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { closeLatestRun } from "../../src/entry/commands/closure.js";
import { inspectTicket } from "../../src/entry/commands/diagnostics-readers.js";
import { loadPipelineConfig } from "../../src/shared/env/config.js";
import { readItem } from "../../src/dashboard/read-model/items.js";
import { readRecap } from "../../src/dashboard/read-model/recap.js";
import { readRunJourney } from "../../src/dashboard/read-model/run-journey.js";
import { readStats } from "../../src/dashboard/read-model/stats.js";
import { readStepDetail } from "../../src/dashboard/read-model/step-detail.js";
import { readSteps } from "../../src/dashboard/read-model/steps.js";
import {
  cleanupTempDirs,
  DEAD_PID,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  writeProjectsFile,
  writeRun,
  writeRunLock,
} from "../../src/dashboard/read-model/test-harness.js";
import { buildPipelineContext } from "../../src/definition/pipeline/context.js";

afterEach(() => cleanupTempDirs());

const TICKET = "DEMO-1";

function listedProject(): { project: string; options: { env: NodeJS.ProcessEnv } } {
  const home = makeTempDir("run-read-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  return { project, options: { env: { ...process.env, PIPELINE_HOME: home } } };
}

/** The runner died inside `coder`: its attempt is still `running` in the snapshot. */
function runDiedInsideStep(project: string): string {
  const attempt = (started: string, status: "done" | "running", finished?: string) => ({
    attempt: 1,
    kind: "step" as const,
    status,
    started_at: started,
    ...(finished ? { finished_at: finished } : {}),
    log_path: "",
  });
  const runDir = writeRun(project, TICKET, "feature", {
    runId: "r-1",
    status: "RUNNING",
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:04:00.000Z",
    steps: [
      {
        id: "plan",
        status: "done",
        retries: 0,
        attempts: [attempt("2026-09-05T08:01:00.000Z", "done", "2026-09-05T08:02:00.000Z")],
      },
      { id: "coder", status: "running", retries: 0, attempts: [attempt("2026-09-05T08:03:01.000Z", "running")] },
      { id: "review", status: "pending", retries: 0 },
    ],
  });
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

test("a run whose runner died reads the same run status in every reader", async () => {
  const { project, options } = listedProject();
  runDiedInsideStep(project);
  const expected = ["plan:done", "coder:aborted", "review:pending"];

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
  expect(statusesOf(recap?.steps)).toEqual(expected);
  // `--inspect` prints the snapshot's step statuses as stored.
  expect(inspectedSteps(inspected)).toEqual(["plan:done", "coder:running", "review:pending"]);
  expect(item?.failure?.phase).toBe("coder");

  const detail = readStepDetail("demo-app", TICKET, "coder", undefined, options);
  const journey = readRunJourney("demo-app", TICKET, options);
  expect(detail?.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([[1, "running"]]);
  expect(
    journey?.attempts
      .filter((attempt) => attempt.stepId === "coder")
      .map((attempt) => [attempt.attempt, attempt.status]),
  ).toEqual([[1, "running"]]);

  expect(closeLatestRun(project, TICKET, "feature", "olivier")).toMatchObject({ ok: true });
});

test("a run a live runner holds is read from its snapshot", () => {
  const { project, options } = listedProject();
  const runDir = runDiedInsideStep(project);
  writeRunLock(runDir, process.ppid);

  expect(readSteps("demo-app", TICKET, options)).toMatchObject({ status: "RUNNING" });
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
  /\b(FileRunStateStore|FileRunEventStore|readRunSnapshot|readRunEvents|readRunSnapshotDiagnostic|resolveLatestRunSnapshot)\b|["'`](state\.json|events\.jsonl)["'`]/g;

/**
 * The files outside the run record that still name a raw read, each with why.
 * Opening a run to execute it is the run record's (`openRun`): boot names none.
 */
const ALLOWED: Record<string, string[]> = {
  "entry/composition/startup.ts": ["FileRunStateStore"],
  "execution/step/pipeline-orchestration-child.ts": ["FileRunStateStore"],
  // The default store `--inspect`, `--logs` and `clean` list snapshots from;
  // each listed snapshot is then read through `readListedRun`.
  "entry/commands/diagnostics-readers.ts": ["FileRunStateStore"],
  "entry/commands/diagnostics.ts": ["FileRunStateStore"],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join(SRC, "run", "record") ? [] : sourceFiles(path);
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
    // A facade re-exports the readers; it reads nothing.
    if (name === "run/index.ts") continue;
    // Fixture writers for the read model's tests, never loaded by the runner.
    if (name === "dashboard/read-model/test-harness.ts") continue;
    const reads = [...new Set(code(readFileSync(file, "utf-8")).match(RAW_READS) ?? [])].sort();
    if (reads.length > 0) found[name] = reads;
  }
  const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, reads]) => [file, [...reads].sort()]));
  expect(found).toEqual(allowed);
});
