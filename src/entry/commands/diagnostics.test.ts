import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import type { PersistedRun } from "../../run/persisted.js";
import { pipelineRunsDir } from "../../run/record/stores/run-storage.js";
import type { RunnerArgs } from "../cli-options.js";
import { composeRunnerRegistries } from "../composition/registries.js";
import { inspectCommand, logsCommand } from "./diagnostics.js";

/**
 * `inspect` is a query, not progress prose: its report is the command's result,
 * so it must survive `lancenuit inspect PROJ-1 > file` and a pipe into `grep`.
 * stderr stays reserved for the execution log (shared/runtime/logging.ts).
 */
test("inspect: the report goes to stdout, not to stderr", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  const cwd = process.cwd();
  process.chdir(mkdtempSync(`${tmpdir()}/lancenuit-inspect-`));
  let code: number;
  try {
    code = await inspectCommand.run({ ticket: "PROJ-1" } as RunnerArgs, { composeRegistries: composeRunnerRegistries });
  } finally {
    process.chdir(cwd);
    stdout.mockRestore();
    stderr.mockRestore();
  }

  expect(code).toBe(0);
  expect(out.join("")).toBe("No run found for PROJ-1.\n");
  expect(err.join("")).toBe("");
});

/**
 * `--logs` finds a run's logs in the directory the run was listed from. A run
 * whose directory is not named after its `runId` (a copied or renamed run) is
 * only found that way: rebuilt from the run id, the path points nowhere.
 */
test("logs: a run whose directory is not named after its runId still shows its logs", () => {
  const root = mkdtempSync(`${tmpdir()}/lancenuit-logs-`);
  const context = buildPipelineContext({ cwd: root, ticket: "PROJ-1" });
  const runDir = join(pipelineRunsDir("feature", "PROJ-1", context), "copied-run");
  const attemptDir = join(runDir, "steps", "quality.tests", "attempt-001");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, "output.log"), "tests passed\n");
  const state: PersistedRun = {
    schemaVersion: 2,
    runId: "run-original",
    name: "feature",
    pipeline: "feature",
    ticket: "PROJ-1",
    updatedAt: "2026-07-03T00:00:00.000Z",
    status: "PASS",
    steps: [{ id: "quality.tests", status: "done", retries: 0 }],
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));

  const out: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const cwd = process.cwd();
  process.chdir(root);
  let code: number | Promise<number>;
  try {
    code = logsCommand.run({ ticket: "PROJ-1", step: "quality.tests" } as RunnerArgs, {
      composeRegistries: composeRunnerRegistries,
    });
  } finally {
    process.chdir(cwd);
    stdout.mockRestore();
  }

  expect(code).toBe(0);
  expect(out.join("")).toContain("tests passed");
});
