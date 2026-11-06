import { afterEach, expect, test } from "bun:test";
import { readItem } from "./items.ts";
import { type ApiRunFilters, listApiRuns, readApiRun } from "./read-api.ts";
import { RunDetailSchema, RunListSchema } from "./read-api.schema.ts";
import {
  cleanupTempDirs,
  DEAD_PID,
  makeProject,
  makeTempDir,
  writeArtifact,
  writeDecision,
  writeHistory,
  writeProjectsFile,
  writeRun,
  writeRunLock,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProjects(...names: string[]): string[] {
  const kit = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = kit;
  const projects = names.map((name) => makeProject(name));
  writeProjectsFile(kit, projects);
  return projects;
}

/** Every answer is checked against the strict schema: a field the contract does
 *  not name fails the test. */
async function list(filters: Partial<ApiRunFilters> = {}) {
  const answer = await listApiRuns({ limit: 200, ...filters });
  return RunListSchema.parse(answer).runs;
}

async function detail(project: string, ticket: string, runId: string) {
  const answer = await readApiRun(project, ticket, runId);
  return answer === undefined ? undefined : RunDetailSchema.parse(answer);
}

test("read api: the status is the one a resume would judge, a dead runner's run is interrupted", async () => {
  const [project] = listedProjects("demo-app");
  const steps = [
    { id: "plan", status: "done" as const, retries: 0 },
    { id: "coder", status: "running" as const, retries: 0 },
  ];
  writeRunLock(
    writeRun(project!, "DEMO-1", "feature", {
      runId: "r-dead",
      status: "RUNNING",
      updatedAt: "2026-09-05T08:00:00Z",
      steps,
    }),
    DEAD_PID,
  );
  writeRunLock(
    writeRun(project!, "DEMO-2", "feature", {
      runId: "r-live",
      status: "RUNNING",
      updatedAt: "2026-09-05T07:00:00Z",
      steps,
    }),
    process.ppid,
  );

  const [dead, live] = await list();

  expect(dead).toMatchObject({ runId: "r-dead", status: "ABORTED", interrupted: true, awaitsHuman: true });
  expect(dead!.failure?.phase).toBe("coder");
  expect(live).toMatchObject({ runId: "r-live", status: "RUNNING", awaitsHuman: false });
  expect(live!.interrupted).toBeUndefined();
  expect(live!.failure).toBeUndefined();
});

test("read api: a composed child is never listed, its spend stays in its parent", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "release", {
    runId: "r-parent",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00Z",
    total_control: { duration_ms: 1_000, total_cost_usd: 3 },
  });
  writeRun(project!, "DEMO-1", "lot", {
    runId: "r-child",
    parentRunId: "r-parent",
    status: "PASS",
    updatedAt: "2026-09-05T09:00:00Z",
    total_control: { duration_ms: 500, total_cost_usd: 2 },
  });

  const runs = await list();

  expect(runs.map((run) => run.runId)).toEqual(["r-parent"]);
  expect(runs[0]!.cost).toEqual({ usd: 3, estimated: false, lowerBound: false });
  expect(await detail("demo-app", "DEMO-1", "r-child")).toBeUndefined();
});

test("read api: every root run is listed once, and only the ticket's current one is current", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "feature", { runId: "r-old", status: "FAIL", updatedAt: "2026-09-05T06:00:00Z" });
  writeRun(project!, "DEMO-1", "feature", { runId: "r-new", status: "PASS", updatedAt: "2026-09-05T07:00:00Z" });
  writeRun(project!, "DEMO-1", "triage", { runId: "r-triage", status: "PASS", updatedAt: "2026-09-05T08:00:00Z" });

  const runs = await list();

  // `latest` links point at runs already listed by their own directory.
  expect(runs.map((run) => run.runId)).toEqual(["r-triage", "r-new", "r-old"]);
  expect(runs.filter((run) => run.current).map((run) => run.runId)).toEqual(["r-triage"]);
  expect((await readItem("demo-app", "DEMO-1"))!.runId).toBe("r-triage");
  expect(runs.find((run) => run.runId === "r-old")!.pipeline).toBe("feature");
});

test("read api: a floor is never shown as an exact figure, and an unpriced run has no amount", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "feature", {
    runId: "r-floor",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00Z",
    total_control: { duration_ms: 12_000, total_cost_usd: 1.25, cost_unknown: true, cost_estimated: true },
  });
  writeRun(project!, "DEMO-2", "feature", { runId: "r-none", status: "PASS", updatedAt: "2026-09-05T07:00:00Z" });

  const [floor, none] = await list();

  expect(floor!.cost).toEqual({ usd: 1.25, estimated: true, lowerBound: true });
  expect(floor!.activeMs).toBe(12_000);
  expect(none!.cost).toEqual({ estimated: false, lowerBound: false });
  expect(none!.activeMs).toBeUndefined();
});

test("read api: a stop carries its approval only on the current run, judged as the work item stands", async () => {
  const [project] = listedProjects("demo-app");
  const stopped = (runId: string, pipeline: string, updatedAt: string) =>
    writeRun(project!, "DEMO-1", pipeline, {
      runId,
      status: "STOPPED",
      updatedAt,
      outcome: {
        phase: "plan",
        reason: "plan needs approval",
        logPath: null,
        resumable: true,
        stop: { subject: "plan", kind: "needs-decision", detail: "plan needs approval", reworkable: true },
      },
    });
  stopped("r-before", "triage", "2026-09-05T07:00:00Z");
  stopped("r-now", "feature", "2026-09-05T08:00:00Z");
  writeArtifact(project!, "DEMO-1", "plan.md", "# plan\n");
  writeDecision(project!, "DEMO-1", "plan", "plan.md", "# plan\n");

  const [now, before] = await list();

  expect(now!.stop).toEqual({
    subject: "plan",
    kind: "needs-decision",
    detail: "plan needs approval",
    reworkable: true,
  });
  expect(now!.approval).toEqual({
    subject: "plan",
    state: "fresh",
    decidedAt: "2026-09-05T08:00:00.000Z",
    decidedBy: "Olivier",
  });
  expect(before!.stop?.subject).toBe("plan");
  expect(before!.approval).toBeUndefined();
});

test("read api: a failure keeps the runner's words, the ticket title and branch ride along", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "feature", {
    runId: "r-fail",
    status: "FAIL",
    createdAt: "2026-09-05T07:00:00Z",
    updatedAt: "2026-09-05T08:00:00Z",
    worktree: true,
    outcome: { phase: "tests", reason: "3 tests failed", logPath: null, resumable: true, failKind: "verdict" },
  });
  writeArtifact(project!, "DEMO-1", "ticket.md", "# DEMO-1 — Export a CSV\n\nBody.\n");
  writeHistory(project!, [{ runId: "r-fail", branch: "feature/demo-1" }]);

  const [run] = await list();

  expect(run).toMatchObject({
    project: "demo-app",
    ticket: "DEMO-1",
    title: "Export a CSV",
    failure: { phase: "tests", reason: "3 tests failed", kind: "verdict" },
    createdAt: "2026-09-05T07:00:00Z",
    updatedAt: "2026-09-05T08:00:00Z",
    branch: "feature/demo-1",
    worktree: true,
  });
});

test("read api: filters narrow by project, ticket, status, recency and current, then the limit cuts the newest", async () => {
  const [demo, shop] = listedProjects("demo-app", "shop");
  writeRun(demo!, "DEMO-1", "feature", { runId: "d-1", status: "PASS", updatedAt: "2026-09-05T08:00:00Z" });
  writeRun(demo!, "DEMO-1", "feature", { runId: "d-2", status: "FAIL", updatedAt: "2026-09-05T09:00:00Z" });
  writeRun(demo!, "DEMO-2", "feature", { runId: "d-3", status: "STOPPED", updatedAt: "2026-09-04T08:00:00Z" });
  writeRun(shop!, "SHOP-1", "feature", { runId: "s-1", status: "PASS", updatedAt: "2026-09-05T10:00:00Z" });
  writeRun(shop!, "SHOP-2", "feature", { runId: "s-undated", status: "PASS" });

  const ids = async (filters: Partial<ApiRunFilters>) => (await list(filters)).map((run) => run.runId);

  expect(await ids({})).toEqual(["s-1", "d-2", "d-1", "d-3", "s-undated"]);
  expect(await ids({ project: "demo-app" })).toEqual(["d-2", "d-1", "d-3"]);
  expect(await ids({ project: "unknown" })).toEqual([]);
  expect(await ids({ ticket: "DEMO-1" })).toEqual(["d-2", "d-1"]);
  expect(await ids({ statuses: ["PASS", "STOPPED"] })).toEqual(["s-1", "d-1", "d-3", "s-undated"]);
  expect(await ids({ sinceMs: Date.parse("2026-09-05T08:30:00Z") })).toEqual(["s-1", "d-2"]);
  expect(await ids({ currentOnly: true })).toEqual(["s-1", "d-2", "d-3", "s-undated"]);
  expect(await ids({ limit: 2 })).toEqual(["s-1", "d-2"]);
});

test("read api: the detail lists the steps, and the report of the current run only", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "feature", { runId: "r-1", status: "FAIL", updatedAt: "2026-09-05T07:00:00Z" });
  writeRun(project!, "DEMO-1", "feature", {
    runId: "r-2",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00Z",
    steps: [
      {
        id: "coder",
        status: "done",
        retries: 1,
        profile: "coder",
        control: { duration_ms: 4_000, total_cost_usd: 0.5, model: "claude-sonnet-5-5" },
      },
      { id: "tests", status: "done", retries: 0 },
    ],
  });
  writeArtifact(project!, "DEMO-1", "report.json", JSON.stringify({ version: 1, runId: "r-2" }));

  const current = await detail("demo-app", "DEMO-1", "r-2");
  const previous = await detail("demo-app", "DEMO-1", "r-1");

  expect(current!.run).toMatchObject({ runId: "r-2", current: true });
  expect(current!.steps).toEqual([
    {
      id: "coder",
      status: "done",
      profile: "coder",
      model: "claude-sonnet-5-5",
      durationMs: 4_000,
      cost: { usd: 0.5, estimated: false, lowerBound: false },
      retries: 1,
    },
    { id: "tests", status: "done" },
  ]);
  expect(current!.report).toMatchObject({ version: 1, runId: "r-2" });
  expect(previous!.run).toMatchObject({ runId: "r-1", current: false });
  expect(previous!.report).toBeUndefined();
  expect(previous!.reportError).toBeUndefined();
});

test("read api: an unknown project, ticket or run is not found rather than an error", async () => {
  const [project] = listedProjects("demo-app");
  writeRun(project!, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T07:00:00Z" });

  expect(await detail("unknown", "DEMO-1", "r-1")).toBeUndefined();
  expect(await detail("demo-app", "DEMO-9", "r-1")).toBeUndefined();
  expect(await detail("demo-app", "../DEMO-1", "r-1")).toBeUndefined();
  expect(await detail("demo-app", "DEMO-1", "r-unknown")).toBeUndefined();
});
