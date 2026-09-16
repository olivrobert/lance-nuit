// runner/state/run-repository.ts
//
// Run snapshot repository: project memory state and write atomically. Transitions
// and resume logic live in their own modules.
// respectively.

import { basename, isAbsolute, relative } from "node:path";
import type { PersistedRun, PersistedStepState } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import { FileRunStateStore } from "./stores/file-run-state-store.js";

/** Extract persistable step state without its definition.
 *
 * `attempts` and `last_command` are deliberately absent: the journal already holds
 * every attempt, and `last_command` is the full agent prompt. Both were rewritten
 * in full on every transition and made up the majority of the snapshot. */
function persistedStep(step: RunStep): PersistedStepState {
  return {
    id: step.id,
    status: step.status,
    retries: step.retries,
    timeout_retries: step.timeout_retries,
    last_attempt: step.last_attempt,
    excluded: step.excluded,
    started_at: step.started_at,
    finished_at: step.finished_at,
    session: step.session,
    profile: step.profile,
    control: step.control,
    usage: step.usage,
    errors: step.errors,
    fail_kind: step.fail_kind,
    fail_cause: step.fail_cause,
    orchestration: step.orchestration,
  };
}

function persistedRun(run: Run): PersistedRun {
  const pipelinePath = isAbsolute(run.pipeline_path)
    ? relative(process.cwd(), run.pipeline_path).replaceAll("\\", "/")
    : run.pipeline_path;
  return {
    schemaVersion: 1,
    runId: run.runId,
    name: run.name,
    ticket: run.ticket,
    pipeline: run.pipeline,
    pipeline_path: pipelinePath,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    outcome: run.outcome,
    max_cost_usd: run.max_cost_usd,
    parentRunId: run.parentRunId,
    parentNodeId: run.parentNodeId,
    rootRunId: run.rootRunId,
    budgetScopeId: run.budgetScopeId,
    lot: run.lot,
    pipelineLineage: run.pipelineLineage,
    steps: run.steps.map(persistedStep),
    total_control: run.total_control,
    total_usage: run.total_usage,
    aborted: run.aborted,
    stopped_reason: run.stopped_reason,
    worktree: run.worktree,
    cwd: run.cwd,
    budget_exceeded: run.budget_exceeded,
    budget_approved: run.budget_approved,
    // Both accounting facts persist here, and are restored by `boot/resume.ts`
    // alone: one owner for the write, one for the read, exactly as for
    // `budget_exceeded` / `budget_approved`.
    cost_unaccounted: run.cost_unaccounted,
    allow_unmetered: run.allow_unmetered,
    specPath: run.specPath,
  };
}

/**
 * Write a complete snapshot through a temporary file and atomic rename. A kill
 * during the write must never leave truncated resume JSON.
 */
export function saveRun(run: Run): void {
  // SIGINT/SIGTERM persists ABORTED first. In-flight awaits may then save their
  // result; do not let them overwrite the abort snapshot with transient state.
  // abortRun and finalizeRun have already set status=ABORTED and are allowed through.
  if (run.aborted && run.status !== "ABORTED") return;
  run.schemaVersion = 1;
  run.runId ??= basename(run.run_dir);
  run.updatedAt = new Date().toISOString();
  const snapshot = persistedRun(run);
  const store = run.stateStore ?? new FileRunStateStore({ pipeline: run.pipeline, ticket: run.ticket });
  if (store.saveAt) store.saveAt(snapshot, run.run_dir);
  else store.save(snapshot);
}
