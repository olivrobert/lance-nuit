import { afterEach, expect, test } from "bun:test";
import { readRecap } from "./recap.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile, writeRun } from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

function home(): string {
  const dir = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = dir;
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(name = "demo-app"): string {
  const kit = home();
  const project = makeProject(name);
  writeProjectsFile(kit, [project]);
  return project;
}

test("recap: run-wide figures come from the ledger, not from a sum of the steps", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    createdAt: "2026-09-05T07:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    // Deliberately not the sum of the steps below: a composed child or a fix
    // pass is folded into the totals, and the recap must show what was charged.
    total_control: { duration_ms: 90_000, total_cost_usd: 4.2, model: "opus" },
    total_usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 300, cache_creation_tokens: 40 },
    steps: [
      { id: "ticket", status: "done", retries: 0, control: { duration_ms: 1000 } },
      {
        id: "plan",
        status: "done",
        retries: 1,
        profile: "planner",
        control: { duration_ms: 60_000, total_cost_usd: 1.5, cost_estimated: true, model: "opus" },
        usage: { input_tokens: 4, output_tokens: 8, cache_read_tokens: 100, cache_creation_tokens: 16 },
      },
      {
        id: "review",
        status: "done",
        retries: 0,
        control: { duration_ms: 20_000, total_cost_usd: 0, cost_unknown: true, model: "local-model" },
      },
      { id: "revise", status: "skipped", retries: 0 },
    ],
  });

  const recap = readRecap("demo-app", "DEMO-1");

  expect(recap).toEqual({
    pipeline: "feature",
    runId: "r-1",
    status: "PASS",
    startedAt: "2026-09-05T07:00:00.000Z",
    endedAt: "2026-09-05T08:00:00.000Z",
    activeMs: 90_000,
    tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 },
    models: ["opus", "local-model"],
    steps: [
      { id: "ticket", status: "done", durationMs: 1000 },
      {
        id: "plan",
        status: "done",
        durationMs: 60_000,
        costUsd: 1.5,
        costEstimated: true,
        model: "opus",
        profile: "planner",
        retries: 1,
        tokens: { input: 4, output: 8, cacheRead: 100, cacheWrite: 16 },
      },
      { id: "review", status: "done", durationMs: 20_000, costUsd: 0, costUnknown: true, model: "local-model" },
      { id: "revise", status: "skipped" },
    ],
  });
});

test("recap: a run with no accounting yet reports no figure rather than zeros", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "RUNNING",
    total_usage: {},
    steps: [{ id: "coder", status: "running", retries: 0 }],
  });

  expect(readRecap("demo-app", "DEMO-1")).toEqual({
    pipeline: "feature",
    runId: "r-1",
    status: "RUNNING",
    models: [],
    steps: [{ id: "coder", status: "running" }],
  });
});

test("recap: an unknown project or work item has no recap", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS" });

  expect(readRecap("demo-app", "DEMO-404")).toBeUndefined();
  expect(readRecap("unknown", "DEMO-1")).toBeUndefined();
});
