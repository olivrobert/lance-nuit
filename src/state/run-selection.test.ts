import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineContext } from "../model/context.js";
import { discardedResumeNotice, resolveExplicitRunDir } from "./run-selection.js";
import { pipelineRunsDir, resolveLatestRunSnapshot, resolveRunDir, wouldResumeLatest } from "./stores/run-storage.js";

function fixtureContext(): PipelineContext {
  const cwd = mkdtempSync(join(tmpdir(), "run-selection-"));
  return { cwd, config: { specPath: ".lance-nuit/work-items" } } as unknown as PipelineContext;
}

function writeRun(
  context: PipelineContext,
  pipeline: string,
  ticket: string,
  runId: string,
  state: Record<string, unknown>,
): string {
  const runDir = join(pipelineRunsDir(pipeline, ticket, context), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({ schemaVersion: 1, runId, name: pipeline, pipeline, ticket, ...state }),
  );
  return runDir;
}

function pointLatest(context: PipelineContext, pipeline: string, ticket: string, runId: string): void {
  symlinkSync(runId, join(pipelineRunsDir(pipeline, ticket, context), "latest"));
}

const ABORTED_LOT_RUN = {
  status: "ABORTED",
  aborted: true,
  outcome: { phase: "implement-lots", reason: "SIGINT", logPath: null, resumable: false },
  steps: [
    { id: "plan", status: "done" },
    { id: "implement-lots", status: "aborted" },
    { id: "create-mr", status: "pending" },
  ],
};

test("run-selection: validates the integration contract", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  expect(resolveExplicitRunDir("feature", "DEMO-1", "run-abort", context)).toBe(runDir);
});

test("--run takes the run lock and refuses a run held by a live runner", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  // `process.ppid` is alive and is not us: the same shape as a second runner
  // holding the directory (a worktree sharing `runs/` with the main clone).
  writeFileSync(join(runDir, "runner.lock"), String(process.ppid));

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "run-abort", context)).toThrow(
    /already held by another runner process/,
  );
});

// The lock path being unusable is not something to wait for, so the message must
// not describe a writer that does not exist.
test("--run reports an unusable lock path instead of a phantom holder", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  mkdirSync(join(runDir, "runner.lock"));

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "run-abort", context)).toThrow(
    /the lock of run "run-abort" cannot be used\. Lock path .*runner\.lock is not a regular file/,
  );
});

test("--run claims the lock so a second process cannot write the same run", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  expect(resolveExplicitRunDir("feature", "DEMO-1", "run-abort", context)).toBe(runDir);
  expect(JSON.parse(readFileSync(join(runDir, "runner.lock"), "utf-8")).pid).toBe(process.pid);
});

test("wouldResumeLatest answers what resolveRunDir will actually do, lock included", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-live", {
    status: "RUNNING",
    steps: [
      { id: "plan", status: "done" },
      { id: "build", status: "pending" },
    ],
  });
  pointLatest(context, "feature", "DEMO-1", "run-live");

  expect(wouldResumeLatest("feature", "DEMO-1", false, context)).toBe(true);
  expect(wouldResumeLatest("feature", "DEMO-1", true, context)).toBe(false);

  // Held by a live runner: resolveRunDir starts a NEW run, so this invocation is
  // not resuming and the clean-tree guard must apply to it.
  writeFileSync(join(runDir, "runner.lock"), String(process.ppid));
  expect(wouldResumeLatest("feature", "DEMO-1", false, context)).toBe(false);
  expect(resolveRunDir("feature", "DEMO-1", undefined, false, context)).not.toBe(runDir);
});

test("run-storage rejects reserved pipeline names before path normalization", () => {
  const context = fixtureContext();

  for (const name of [".", ".."]) {
    expect(() => pipelineRunsDir(name, "DEMO-1", context)).toThrow(/Invalid pipeline name/);
  }
});

test("--run repoints latest to the selected run: validates the contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-neuf", { steps: [{ id: "plan", status: "pending" }] });
  pointLatest(context, "feature", "DEMO-1", "run-neuf");
  writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  resolveExplicitRunDir("feature", "DEMO-1", "run-abort", context);

  expect(readlinkSync(join(pipelineRunsDir("feature", "DEMO-1", context), "latest"))).toBe("run-abort");
});

test("run-selection: validates the integration contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "absent", context)).toThrow(/not found/);
});

test("run-selection: validates the integration contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "../other-pipeline/run-abort", context)).toThrow(
    /invalid run identity/,
  );
});

test("run-selection: validates the integration contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-finished", {
    status: "PASS",
    steps: [
      { id: "plan", status: "done" },
      { id: "create-mr", status: "skipped" },
    ],
  });

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "run-finished", context)).toThrow(/no remaining step/);
});

test("--run resumes a run whose only missing piece is the verdict", () => {
  // Crash between the last step snapshot and finalizeRun: nothing left to
  // execute, but the run still owes its verdict. Automatic resume accepts it,
  // so the explicit path must too.
  const running = fixtureContext();
  const runningDir = writeRun(running, "feature", "DEMO-1", "run-crash", {
    status: "RUNNING",
    steps: [
      { id: "plan", status: "done" },
      { id: "create-mr", status: "skipped" },
    ],
  });
  expect(resolveExplicitRunDir("feature", "DEMO-1", "run-crash", running)).toBe(runningDir);

  const aborted = fixtureContext();
  const abortedDir = writeRun(aborted, "feature", "DEMO-1", "run-sigint", {
    status: "ABORTED",
    aborted: true,
    outcome: { phase: "create-mr", reason: "SIGINT", logPath: null, resumable: true },
    steps: [
      { id: "plan", status: "done" },
      { id: "create-mr", status: "done" },
    ],
  });
  expect(resolveExplicitRunDir("feature", "DEMO-1", "run-sigint", aborted)).toBe(abortedDir);
});

test("--run rejects a snapshot whose persisted identity differs from its directory", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-mismatch", {
    runId: "other-run",
    pipeline: "other-pipeline",
    ticket: "OTHER-1",
    steps: [{ id: "plan", status: "pending" }],
  });

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "run-mismatch", context)).toThrow(
    /snapshot identity mismatch/,
  );
});

test("run-selection: validates the integration contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-abort", ABORTED_LOT_RUN);
  pointLatest(context, "feature", "DEMO-1", "run-abort");

  const notice = discardedResumeNotice("feature", "DEMO-1", context);

  expect(notice).toContain("--run run-abort");
  expect(notice).toContain("interrupted manually");
  expect(notice).toContain("2 step(s)");
});

test("no warning is emitted for resumable or completed latest runs: validates the contract", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-ok", {
    status: "FAIL",
    steps: [
      { id: "plan", status: "done" },
      { id: "implement", status: "failed" },
    ],
  });
  pointLatest(context, "feature", "DEMO-1", "run-ok");
  expect(discardedResumeNotice("feature", "DEMO-1", context)).toBeUndefined();

  const other = fixtureContext();
  writeRun(other, "feature", "DEMO-2", "run-finished", {
    status: "PASS",
    steps: [{ id: "plan", status: "done" }],
  });
  pointLatest(other, "feature", "DEMO-2", "run-finished");
  expect(discardedResumeNotice("feature", "DEMO-2", other)).toBeUndefined();
});

test("a damaged latest selector fails without creating a run or moving latest", () => {
  const context = fixtureContext();
  const runDir = writeRun(context, "feature", "DEMO-1", "run-damaged", ABORTED_LOT_RUN);
  pointLatest(context, "feature", "DEMO-1", "run-damaged");
  writeFileSync(join(runDir, "state.json"), "{");
  const pipelineDir = pipelineRunsDir("feature", "DEMO-1", context);

  expect(() => wouldResumeLatest("feature", "DEMO-1", false, context)).toThrow(/invalid JSON/);
  expect(() => resolveRunDir("feature", "DEMO-1", undefined, false, context)).toThrow(/invalid JSON/);
  expect(readlinkSync(join(pipelineDir, "latest"))).toBe("run-damaged");
  expect(readdirSync(pipelineDir).filter((entry) => entry !== "latest")).toEqual(["run-damaged"]);
});

test("a dangling latest selector and an incompatible snapshot fail, while --fresh deliberately starts over", () => {
  const dangling = fixtureContext();
  const danglingDir = pipelineRunsDir("feature", "DEMO-1", dangling);
  mkdirSync(danglingDir, { recursive: true });
  symlinkSync("gone", join(danglingDir, "latest"));
  expect(() => resolveRunDir("feature", "DEMO-1", undefined, false, dangling)).toThrow(/dangling/);
  expect(readlinkSync(join(danglingDir, "latest"))).toBe("gone");

  const incompatible = fixtureContext();
  const runDir = writeRun(incompatible, "feature", "DEMO-1", "run-old", ABORTED_LOT_RUN);
  pointLatest(incompatible, "feature", "DEMO-1", "run-old");
  writeFileSync(join(runDir, "state.json"), JSON.stringify({ schemaVersion: 99 }));
  expect(() => resolveRunDir("feature", "DEMO-1", undefined, false, incompatible)).toThrow(
    /unsupported schema version/,
  );
  const fresh = resolveRunDir("feature", "DEMO-1", undefined, true, incompatible);
  expect(fresh).not.toBe(runDir);
  expect(readlinkSync(join(pipelineRunsDir("feature", "DEMO-1", incompatible), "latest"))).toBe(
    fresh.slice(fresh.lastIndexOf("/") + 1),
  );
});

test("an invalid explicit selection preserves the existing latest target", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-live", ABORTED_LOT_RUN);
  pointLatest(context, "feature", "DEMO-1", "run-live");
  const broken = writeRun(context, "feature", "DEMO-1", "run-broken", ABORTED_LOT_RUN);
  unlinkSync(join(broken, "state.json"));

  expect(() => resolveExplicitRunDir("feature", "DEMO-1", "run-broken", context)).toThrow(/not found/);
  expect(readlinkSync(join(pipelineRunsDir("feature", "DEMO-1", context), "latest"))).toBe("run-live");
});

test("latest selection exposes an injected read denial instead of treating it as a fresh run", () => {
  const context = fixtureContext();
  writeRun(context, "feature", "DEMO-1", "run-live", ABORTED_LOT_RUN);
  pointLatest(context, "feature", "DEMO-1", "run-live");

  expect(() =>
    resolveLatestRunSnapshot("feature", "DEMO-1", context, {
      readFile: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    }),
  ).toThrow(/EACCES/);
  expect(readlinkSync(join(pipelineRunsDir("feature", "DEMO-1", context), "latest"))).toBe("run-live");
});
