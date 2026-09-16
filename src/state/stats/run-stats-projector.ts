// Pure projection of run facts into the run-stats schema.
//
// This module knows neither filesystem nor Git. External facts arrive through
// RunEventStore/RunLogStore and path metadata through options.

import { basename } from "node:path";
import type { AgentSession } from "../../contracts/backends.js";
import { backendSpecForStep } from "../../contracts/backends.js";
import type { RunOutcomeState } from "../../model/persisted.js";
import type { Run, RunStep } from "../../model/run.js";
import type { RunEventStore, RunLogStore } from "../../model/storage-ports.js";
import { relativeRunPath } from "../run-journal.js";
import { deriveRunStatus, isResumableStatus } from "../run-verdict.js";
import {
  type ProjectionAccumulator,
  projectStepStats,
  runnerFixEvents,
  warningsForSteps,
} from "./run-stats-projection.js";
import { type RunStatsEntry, zeroTokens } from "./stats-core.js";

export type { PhaseStats, RunStatsEntry, TokenCounts, UsageStatus } from "./stats-core.js";

export interface RunStatsProjectionOptions {
  /** Preferred store; otherwise use the store attached to the run. */
  eventStore?: RunEventStore;
  /** Preferred store; otherwise use the store attached to the run. */
  logStore?: RunLogStore;
  /** Resolution supplied by the caller because it may depend on configuration. */
  ticketDir?: string | null;
  /** Resolve the logical outcome log path when no outcome is persisted. */
  logPathForStep?: (stepId: string) => string | null;
}

/** `finalizeRun` status is authoritative; otherwise derive it identically. */
function statusOf(run: Run): RunStatsEntry["status"] {
  if (run.status && run.status !== "RUNNING" && run.status !== "UNKNOWN") return run.status;
  return deriveRunStatus(run);
}

function outcomeOf(
  run: Run,
  status: RunStatsEntry["status"],
  failed: RunStep | undefined,
  options: RunStatsProjectionOptions,
): RunOutcomeState {
  const existing = run.outcome;
  if (existing) return { ...existing, logPath: relativeRunPath(run.run_dir, existing.logPath) };
  return {
    phase: failed?.id ?? null,
    reason: failed?.errors ?? run.stopped_reason ?? null,
    logPath: failed && options.logPathForStep ? relativeRunPath(run.run_dir, options.logPathForStep(failed.id)) : null,
    resumable: isResumableStatus(status),
  };
}

/** Calculate a run-stats entry without filesystem or Git access. */
/** Session of the last agent step that finished, by `finished_at`. Feeds the
 *  stats `sessionId`/`sessionProvider` pair now that runs no longer remember a
 *  dedicated coder session. */
function lastFinishedAgentSession(run: Run): AgentSession | undefined {
  let latest: { finishedAt: string; session: AgentSession } | undefined;
  for (const step of run.steps as RunStep[]) {
    if (!step.finished_at) continue;
    if (!backendSpecForStep(step.def)) continue;
    const session = step.session;
    if (!session) continue;
    if (!latest || step.finished_at >= latest.finishedAt) latest = { finishedAt: step.finished_at, session };
  }
  return latest?.session;
}

export function projectRunStatsEntry(run: Run, options: RunStatsProjectionOptions = {}): RunStatsEntry {
  const eventStore = options.eventStore ?? run.eventStore;
  const logStore = options.logStore ?? run.logStore;
  const aggregate: ProjectionAccumulator = {
    phases: {},
    models: {},
    profiles: {},
    totals: zeroTokens(),
  };
  let startedAt: string | null = run.createdAt ?? null;
  let endedAt: string | null = null;

  for (const step of run.steps as RunStep[]) {
    if (step.started_at && (!startedAt || step.started_at < startedAt)) startedAt = step.started_at;
    if (step.finished_at && (!endedAt || step.finished_at > endedAt)) endedAt = step.finished_at;
    projectStepStats(run, step, eventStore, aggregate);
  }

  const status = statusOf(run);
  const failed = run.steps.find((s) => s.status === "failed");
  const outcome = outcomeOf(run, status, failed, options);
  const warnings = warningsForSteps(run, eventStore);
  const runId = run.runId ?? basename(run.run_dir);
  const lastAgentSession = lastFinishedAgentSession(run);

  return {
    schemaVersion: 1,
    runId,
    pipeline: run.pipeline,
    ticket: run.ticket ?? null,
    ticketDir: options.ticketDir !== undefined ? options.ticketDir : (run.ticket ?? null),
    parentRunId: run.parentRunId ?? null,
    lot: run.lot?.id ?? null,
    lotTitle: run.lot?.title ?? null,
    sessionId: lastAgentSession?.id ?? null,
    ...(lastAgentSession?.provider ? { sessionProvider: lastAgentSession.provider } : {}),
    startedAt,
    endedAt: run.status && run.status !== "RUNNING" ? (run.updatedAt ?? endedAt) : endedAt,
    status,
    outcome,
    failPhase: outcome.phase,
    failReason: outcome.reason,
    phases: aggregate.phases,
    totals: aggregate.totals,
    ...(aggregate.usageStatus ? { usageStatus: aggregate.usageStatus } : {}),
    ...(aggregate.costStatus ? { costStatus: aggregate.costStatus } : {}),
    ...(aggregate.costUnknown ? { costUnknown: true } : {}),
    models: aggregate.models,
    profiles: aggregate.profiles,
    // Emission metadata is filled by emitRunStats.
    commit: null,
    branch: null,
    fixEvents: runnerFixEvents(run, eventStore, logStore),
    sourceRunDir: null,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(aggregate.costUsd != null ? { costUsd: aggregate.costUsd } : {}),
  };
}
