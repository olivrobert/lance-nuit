import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClosureAt } from "../state/closure.js";
import { closeLatestRun, reopenLatestRun } from "./closure.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project with one run of `feature` for PROJ-1, whose `latest` points at it. */
function projectWithRun(status: string): { cwd: string; runDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lancenuit-close-"));
  dirs.push(cwd);
  const pipelineDir = join(cwd, ".lance-nuit", "work-items", "PROJ-1", "runs", "feature");
  const runDir = join(pipelineDir, "r-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "r-1",
      name: "feature",
      pipeline: "feature",
      ticket: "PROJ-1",
      status,
      steps: [],
      updatedAt: "2026-09-05T08:00:00.000Z",
    }),
  );
  symlinkSync("r-1", join(pipelineDir, "latest"));
  return { cwd, runDir };
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
