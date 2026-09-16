// runner/state/run-timeline.ts
//
// Step logs and informative markdown rendering for a run.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isLogicalSegment } from "../model/artifact-ports.js";
import type { Run, RunStep } from "../model/run.js";
import { type LogRef, type RunLogStore, type RunRef, runRefFromRun } from "../model/storage-ports.js";

type RunLogStoreWithLatest = RunLogStore & {
  findLatest?(run: RunRef, stepId: string): LogRef | null;
};

function runtimeRunRef(run: Run): RunRef {
  return runRefFromRun({
    runId: run.runId ?? basename(run.run_dir),
    pipeline: run.pipeline,
    ticket: run.ticket,
  });
}

function requiredLocalPath(log: LogRef): string {
  if (!log.localPath) {
    throw new Error("RunLogStore must provide localPath for local execution");
  }
  return log.localPath;
}

/** Persisted reference for an attempt. It describes the log's logical identity
 * in the store, independently of any local path allocated by the adapter. */
export function logicalAttemptLogPath(stepId: string, attempt: number): string {
  if (!isLogicalSegment(stepId)) throw new Error("stepId must be a non-empty safe logical value");
  return join("steps", stepId, `attempt-${String(attempt).padStart(3, "0")}`, "output.log").replaceAll("\\", "/");
}

/** Path for the next attempt, retained for callers that explicitly request a path
 *  before spawning. Attempt registration remains the responsibility of
 *  `nextAttemptLogPath`/`beginAttempt`. */
export function stepLogPath(run: Run, step: RunStep): string {
  return attemptLogPath(run, step, nextAttemptNumber(step));
}

/** Next attempt number is max(existing)+1, not length+1: a journal with a lost
 *  head can leave holes (e.g. attempts [1, 3]), and length+1 would collide with
 *  an existing attempt directory and append into its log. */
function nextAttemptNumber(step: RunStep): number {
  const attempts = step.attempts ?? [];
  let max = step.last_attempt ?? 0;
  for (const entry of attempts) {
    if (typeof entry.attempt === "number" && entry.attempt > max) max = entry.attempt;
  }
  return Math.max(max, attempts.length) + 1;
}

/** Attempt path: each attempt has its own directory and cannot overwrite a
 * previous execution's diagnostics. */
export function attemptLogPath(run: Run, step: RunStep, attempt: number): string {
  if (run.logStore) {
    return requiredLocalPath(run.logStore.allocate(runtimeRunRef(run), step.id, attempt));
  }
  const dir = join(run.run_dir, dirname(logicalAttemptLogPath(step.id, attempt)));
  mkdirSync(dir, { recursive: true });
  return join(dir, "output.log");
}

/** Allocate and register the next attempt before spawning. */
export function nextAttemptLogPath(run: Run, step: RunStep, kind: "step" | "fix" = "step"): string {
  const attempt = nextAttemptNumber(step);
  step.last_attempt = attempt;
  const path = attemptLogPath(run, step, attempt);
  step.attempts ??= [];
  step.attempts.push({
    attempt,
    kind,
    status: "running",
    started_at: new Date().toISOString(),
    log_path: logicalAttemptLogPath(step.id, attempt),
  });
  return path;
}

export function latestAttemptLog(run: Run, step: RunStep): string | null {
  const attempts = step.attempts ?? [];
  const latest = attempts.at(-1);
  if (latest?.log_path) {
    if (run.logStore) {
      return requiredLocalPath(run.logStore.allocate(runtimeRunRef(run), step.id, latest.attempt));
    }
    return join(run.run_dir, latest.log_path);
  }
  return run.logStore ? findStepLog(run, step.id) : findStepLog(run.run_dir, run.pipeline, step.id);
}

export function findStepLog(run: Run, stepId: string): string | null;
export function findStepLog(runDir: string, pipeline: string, stepId: string): string | null;
export function findStepLog(runOrDir: Run | string, pipelineOrStep: string, explicitStepId?: string): string | null {
  if (typeof runOrDir !== "string") {
    const run = runOrDir;
    const stepId = pipelineOrStep;
    const store = run.logStore;
    if (!store) return findStepLog(run.run_dir, run.pipeline, stepId);

    const runRef = runtimeRunRef(run);
    const finder = (store as RunLogStoreWithLatest).findLatest;
    if (finder) {
      const latest = finder.call(store, runRef, stepId);
      return latest ? requiredLocalPath(latest) : null;
    }

    const attempts = run.steps.find((step) => step.id === stepId)?.attempts ?? [];
    for (const attempt of [...attempts].sort((left, right) => right.attempt - left.attempt)) {
      const log = store.allocate(runRef, stepId, attempt.attempt);
      if (store.read(log) !== null) return requiredLocalPath(log);
    }
    return null;
  }

  const runDir = runOrDir;
  const stepId = explicitStepId!;
  const safeId = stepId.replace(/[^A-Za-z0-9._-]/g, "_");
  const attemptsDir = join(runDir, "steps", safeId);
  if (existsSync(attemptsDir)) {
    const attempts = readdirSync(attemptsDir)
      .filter((f) => /^attempt-\d+$/.test(f))
      .sort()
      .reverse();
    for (const attempt of attempts) {
      const output = join(attemptsDir, attempt, "output.log");
      if (existsSync(output)) return output;
    }
  }
  return null;
}

/** CLI selector: `quality` targets the whole phase, `quality.*` is its explicit
 *  alias, and a full ID retains exact matching. */
export function matchesStepSelector(stepId: string, selector: string): boolean {
  const prefix = selector.endsWith(".*") ? selector.slice(0, -2) : selector;
  return stepId === selector || stepId.startsWith(`${prefix}.`);
}
