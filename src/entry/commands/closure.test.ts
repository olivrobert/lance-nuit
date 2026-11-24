import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClosureAt } from "../../run/record/closure.js";
import { closeLatestRun, reopenLatestRun } from "./closure.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project with one run of `feature` for PROJ-1, whose `latest` points at it. */
function projectWithRun(status: string): { cwd: string; runDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lancenuit-close-"));
  dirs.push(cwd);
  return { cwd, runDir: addRun(cwd, "feature", status) };
}

function addRun(cwd: string, pipeline: string, status: string, pipelinePath?: string): string {
  const pipelineDir = join(cwd, ".lance-nuit", "work-items", "PROJ-1", "runs", pipeline);
  const runDir = join(pipelineDir, "r-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "r-1",
      name: pipeline,
      pipeline,
      ...(pipelinePath === undefined ? {} : { pipeline_path: pipelinePath }),
      ticket: "PROJ-1",
      status,
      steps: [],
      updatedAt: "2026-09-05T08:00:00.000Z",
    }),
  );
  symlinkSync("r-1", join(pipelineDir, "latest"));
  return runDir;
}

test("close: a failed run gets a closure bound to its snapshot, reopen removes it", () => {
  const { cwd, runDir } = projectWithRun("FAIL");

  const closed = closeLatestRun(cwd, "PROJ-1", "feature", "Olivier");
  expect(closed.ok).toBe(true);
  expect(readClosureAt(runDir)).toMatchObject({ closedBy: "Olivier", runUpdatedAt: "2026-09-05T08:00:00.000Z" });

  expect(reopenLatestRun(cwd, "PROJ-1", "feature").ok).toBe(true);
  expect(readClosureAt(runDir)).toBeUndefined();
});

test("close: a passed run is refused and left untouched", () => {
  const { cwd, runDir } = projectWithRun("PASS");

  expect(closeLatestRun(cwd, "PROJ-1", "feature", "Olivier").ok).toBe(false);
  expect(readClosureAt(runDir)).toBeUndefined();
});

test("close: a pipeline without a run is refused", () => {
  const { cwd } = projectWithRun("FAIL");

  expect(closeLatestRun(cwd, "PROJ-1", "other", "Olivier").ok).toBe(false);
});

test("close and reopen: a path designates the pipeline whose runs started from that file", () => {
  const { cwd } = projectWithRun("FAIL");
  const runDir = addRun(cwd, "nightly", "FAIL", "flows/night.ts");

  expect(closeLatestRun(cwd, "PROJ-1", "./flows/night.ts", "Olivier").ok).toBe(true);
  expect(readClosureAt(runDir)).toMatchObject({ closedBy: "Olivier" });
  expect(reopenLatestRun(cwd, "PROJ-1", join(cwd, "flows", "night.ts"))).toMatchObject({ ok: true });
  expect(readClosureAt(runDir)).toBeUndefined();
});

test("close: a path designates the pipeline named after its file", () => {
  const { cwd, runDir } = projectWithRun("FAIL");

  expect(closeLatestRun(cwd, "PROJ-1", ".lance-nuit/pipelines/feature.ts", "Olivier").ok).toBe(true);
  expect(readClosureAt(runDir)).toMatchObject({ closedBy: "Olivier" });
});

test("close and reopen: a path no run started from is refused", () => {
  const { cwd, runDir } = projectWithRun("FAIL");

  expect(closeLatestRun(cwd, "PROJ-1", "flows/other.ts", "Olivier")).toMatchObject({
    ok: false,
    message: 'No run of pipeline "flows/other.ts" found for PROJ-1.',
  });
  expect(reopenLatestRun(cwd, "PROJ-1", "flows/other.ts").ok).toBe(false);
  expect(readClosureAt(runDir)).toBeUndefined();
});

test("close: a path that designates several pipelines is refused, naming them", () => {
  const { cwd, runDir } = projectWithRun("FAIL");
  const otherDir = addRun(cwd, "nightly", "FAIL", "flows/feature.ts");

  const refused = closeLatestRun(cwd, "PROJ-1", "flows/feature.ts", "Olivier");
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("feature, nightly");
  expect(readClosureAt(runDir)).toBeUndefined();
  expect(readClosureAt(otherDir)).toBeUndefined();
});
