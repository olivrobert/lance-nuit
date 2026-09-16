import { basename } from "node:path";
import type { StepControl, StepUsage } from "../../contracts/backends.js";
import type { PersistedAttempt } from "../../model/persisted.js";
import type { Run, RunStep } from "../../model/run.js";
import { createLogRef, type RunEventStore, type RunLogStore, runRefFromRun } from "../../model/storage-ports.js";
import { type RunJournalEvent, relativeRunPath } from "../run-journal.js";
import type { PhaseStats, RunStatsEntry, TokenCounts, UsageStatus } from "./stats-core.js";
import { addTokens, zeroTokens } from "./stats-core.js";

/** Facts used by phase and diagnostic projections. */
export interface AttemptFact {
  attempt: number;
  kind: PersistedAttempt["kind"];
  status: PersistedAttempt["status"];
  logPath?: string;
}

export interface ProjectionAccumulator {
  phases: RunStatsEntry["phases"];
  models: RunStatsEntry["models"];
  profiles: RunStatsEntry["profiles"];
  totals: TokenCounts;
  usageStatus?: UsageStatus;
  costStatus?: UsageStatus;
  costUnknown?: true;
  costUsd?: number;
}

/**
 * Cost provenance of one step. `cost_unknown` counts like `cost_estimated`: both
 * mean the step total is not the provider's figure. Without this, a step whose
 * tokens no pricing table could price left no trace at all, and the run's
 * `costUsd` — a partial sum — read as exact.
 */
function costStatusOf(control: StepControl | undefined): UsageStatus | undefined {
  if (!control?.cost_unknown && !control?.cost_estimated) return undefined;
  return control.total_cost_usd != null ? "partial" : "unavailable";
}

export function tokensOf(usage?: StepUsage): TokenCounts {
  return {
    in: usage?.input_tokens ?? 0,
    out: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_tokens ?? 0,
    cacheWrite: usage?.cache_creation_tokens ?? 0,
  };
}

export function mergeMeasurementStatus(current: UsageStatus | undefined, next: UsageStatus): UsageStatus {
  if (!current) return next;
  return current === "partial" || next === "partial" ? "partial" : "unavailable";
}

function isAttemptKind(value: unknown): value is AttemptFact["kind"] {
  return value === "step" || value === "fix";
}

function isAttemptStatus(value: unknown): value is AttemptFact["status"] {
  return value === "running" || value === "done" || value === "failed" || value === "aborted";
}

function eventsOf(run: Run, eventStore?: RunEventStore): RunJournalEvent[] {
  const store = eventStore ?? run.eventStore;
  if (!store) return [];
  const runId = run.runId ?? basename(run.run_dir);
  try {
    return store.read(runId);
  } catch {
    // Projection remains available from the snapshot when event telemetry is unavailable.
    return [];
  }
}

type AttemptEvent = Extract<RunJournalEvent, { type: "step.attempt.started" | "step.attempt.finished" }>;

/** The closed union no longer lets a `startsWith` narrow the event; the two
 *  attempt types are named instead. */
const ATTEMPT_TYPES: ReadonlySet<RunJournalEvent["type"]> = new Set<RunJournalEvent["type"]>([
  "step.attempt.started",
  "step.attempt.finished",
]);

function isAttemptEvent(event: RunJournalEvent): event is AttemptEvent {
  return ATTEMPT_TYPES.has(event.type);
}

/** Return execution facts without reconstructing attempts from `step.retries`. The
 * journal is preferred; snapshots provide fallback for in-memory projections. */
export function attemptFacts(run: Run, step: RunStep, eventStore?: RunEventStore): AttemptFact[] {
  const facts = new Map<number, AttemptFact>();
  for (const event of eventsOf(run, eventStore)) {
    if (!isAttemptEvent(event) || event.stepId !== step.id) continue;
    const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
    if (attempt == null || !Number.isInteger(attempt) || attempt < 1) continue;
    const previous = facts.get(attempt);
    const kind = isAttemptKind(event.kind) ? event.kind : previous?.kind;
    if (!kind) continue;
    const status =
      event.type === "step.attempt.started"
        ? "running"
        : isAttemptStatus(event.status)
          ? event.status
          : (previous?.status ?? "running");
    facts.set(attempt, {
      attempt,
      kind,
      status,
      ...(typeof event.logPath === "string"
        ? { logPath: relativeRunPath(run.run_dir, event.logPath) ?? undefined }
        : previous?.logPath
          ? { logPath: previous.logPath }
          : {}),
    });
  }
  if (facts.size > 0) return [...facts.values()].sort((a, b) => a.attempt - b.attempt);
  return (step.attempts ?? []).map((attempt) => ({
    attempt: attempt.attempt,
    kind: attempt.kind,
    status: attempt.status,
    ...(attempt.log_path ? { logPath: relativeRunPath(run.run_dir, attempt.log_path) ?? undefined } : {}),
  }));
}

function logTail(run: Run, stepId: string, attempt: number, logStore?: RunLogStore): string | null {
  if (!logStore) return null;
  try {
    const runRef = runRefFromRun({
      runId: run.runId ?? basename(run.run_dir),
      pipeline: run.pipeline,
      ticket: run.ticket,
    });
    const text = logStore.read(createLogRef(runRef, stepId, attempt));
    const tail = text?.slice(-300).trim();
    return tail || null;
  } catch {
    // A missing log only removes diagnostic detail from the projection.
    return null;
  }
}

export function runnerFixEvents(run: Run, eventStore?: RunEventStore, logStore?: RunLogStore): unknown[] {
  const out: unknown[] = [];
  for (const step of run.steps) {
    for (const attempt of attemptFacts(run, step, eventStore).filter((item) => item.status === "failed")) {
      out.push({
        kind: attempt.kind === "fix" ? "fix" : "fail",
        phase: step.id,
        iter: attempt.attempt,
        contract: step.id,
        details: logTail(run, step.id, attempt.attempt, logStore),
        ...(attempt.logPath ? { logPath: attempt.logPath } : {}),
      });
    }
  }
  return out;
}

function addModelUsage(models: Record<string, TokenCounts>, model: string, usage: StepUsage | undefined): void {
  models[model] ??= zeroTokens();
  addTokens(models[model], tokensOf(usage));
}

/** Projects one step into phase, model, profile and total aggregates. */
export function projectStepStats(
  run: Run,
  step: RunStep,
  eventStore: RunEventStore | undefined,
  aggregate: ProjectionAccumulator,
): void {
  const facts = attemptFacts(run, step, eventStore);
  const hasAbortedAttempt = step.status === "aborted" || facts.some((attempt) => attempt.status === "aborted");
  if (!step.control && !step.usage) {
    if (hasAbortedAttempt) aggregate.usageStatus = mergeMeasurementStatus(aggregate.usageStatus, "unavailable");
    return;
  }

  const tokens = tokensOf(step.usage);
  const phaseUsageStatus: UsageStatus | undefined = hasAbortedAttempt
    ? Object.values(tokens).some((value) => value > 0)
      ? "partial"
      : "unavailable"
    : undefined;
  const phaseCostStatus = costStatusOf(step.control);
  const phaseCostUnknown = step.control?.cost_unknown === true;
  const phase: PhaseStats = {
    agents: 1,
    fixLoops: facts.filter((attempt) => attempt.kind === "fix").length,
    tokens,
    ...(step.control?.provider ? { provider: step.control.provider } : {}),
    ...(step.profile ? { profile: step.profile } : {}),
    ...(step.control?.total_cost_usd != null ? { costUsd: step.control.total_cost_usd } : {}),
    ...(phaseUsageStatus ? { usageStatus: phaseUsageStatus } : {}),
    ...(phaseCostStatus ? { costStatus: phaseCostStatus } : {}),
    ...(phaseCostUnknown ? { costUnknown: true } : {}),
  };
  aggregate.phases[step.id] = phase;
  if (phaseUsageStatus) aggregate.usageStatus = mergeMeasurementStatus(aggregate.usageStatus, phaseUsageStatus);
  if (phaseCostStatus) aggregate.costStatus = mergeMeasurementStatus(aggregate.costStatus, phaseCostStatus);
  if (phaseCostUnknown) aggregate.costUnknown = true;
  addTokens(aggregate.totals, tokens);

  if (step.profile) {
    aggregate.profiles[step.profile] ??= { steps: 0, tokens: zeroTokens() };
    aggregate.profiles[step.profile].steps += 1;
    addTokens(aggregate.profiles[step.profile].tokens, tokens);
    if (step.control?.total_cost_usd != null) {
      aggregate.profiles[step.profile].costUsd =
        (aggregate.profiles[step.profile].costUsd ?? 0) + step.control.total_cost_usd;
    }
  }

  const attemptsWithModel = (step.attempts ?? []).filter((attempt) => !!attempt.control?.model);
  if (attemptsWithModel.length > 0) {
    for (const attempt of attemptsWithModel) addModelUsage(aggregate.models, attempt.control!.model!, attempt.usage);
  } else if (step.control?.model) {
    // Snapshots without attempt detail remain grouped under the last known model;
    // do not reconstruct retries.
    addModelUsage(aggregate.models, step.control.model, step.usage);
  }
  if (step.control?.total_cost_usd != null) {
    aggregate.costUsd = (aggregate.costUsd ?? 0) + step.control.total_cost_usd;
  }
}

export function warningsForSteps(run: Run, eventStore?: RunEventStore): Array<{ phase: string; reason: string }> {
  const warnings = run.steps
    .filter((step) => step.def.blocking === false && !!step.errors)
    .map((step) => ({ phase: step.id, reason: step.errors! }));
  for (const step of run.steps) {
    if (
      step.status === "aborted" ||
      attemptFacts(run, step, eventStore).some((attempt) => attempt.status === "aborted")
    ) {
      warnings.push({
        phase: step.id,
        reason: "usage/cost unavailable or partial: attempt interrupted before its usage report",
      });
    }
  }
  return warnings;
}
