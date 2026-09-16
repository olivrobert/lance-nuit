// runner/state/attempt-projection.ts
//
// Rebuild step attempts from the journal. `state.json` keeps only the state a
// resume needs; `step.attempt.started` and `step.attempt.finished` already carry
// the full history, so attempts are projected here instead of being written a
// second time into every snapshot.

import type { AgentSession, StepControl, StepUsage } from "../contracts/backends.js";
import type { PersistedAttempt } from "../model/persisted.js";
import { restoreAttemptSpend } from "./cost-accounting.js";
import type { RunJournalEvent } from "./run-journal.js";

type AttemptFinishedEvent = Extract<RunJournalEvent, { type: "step.attempt.finished" }>;

const ATTEMPT_STARTED = "step.attempt.started";
const ATTEMPT_FINISHED = "step.attempt.finished";

type AttemptStatus = PersistedAttempt["status"];

const ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "aborted"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function object<T>(value: unknown): T | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : undefined;
}

function attemptNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function attemptKind(value: unknown, fallback: PersistedAttempt["kind"] = "step"): PersistedAttempt["kind"] {
  return value === "fix" || value === "step" ? value : fallback;
}

/** An unknown status means the producer died between the two events; treat the
 *  attempt as failed rather than leaving it eternally `running`. */
function attemptStatus(value: unknown): AttemptStatus {
  return typeof value === "string" && ATTEMPT_STATUSES.has(value) ? (value as AttemptStatus) : "failed";
}

/** Session carried by the event, when the producer emitted one. */
function attemptSession(event: AttemptFinishedEvent): AgentSession | undefined {
  const session = object<AgentSession>(event.session);
  return session?.id ? session : undefined;
}

function applyFinished(attempt: PersistedAttempt, event: AttemptFinishedEvent): void {
  attempt.kind = attemptKind(event.kind, attempt.kind);
  attempt.status = attemptStatus(event.status);
  attempt.finished_at = text(event.ts);

  const session = attemptSession(event);
  if (session) attempt.session = session;

  // The spend this attempt was already charged for, put back as the journal
  // recorded it. Cost accounting owns the write; nothing is charged again here.
  restoreAttemptSpend(attempt, object<StepControl>(event.control), object<StepUsage>(event.usage));

  // The journal names the failure `reason`; the attempt keeps it as `errors`.
  const errors = text(event.reason);
  if (errors) attempt.errors = errors;

  const logPath = text(event.logPath);
  if (logPath) attempt.log_path = logPath;
}

/**
 * Project the attempts of every step from a run journal, keyed by step id and
 * ordered by attempt number.
 *
 * Attempt numbering depends on this projection: `nextAttemptLogPath` derives the
 * next number from the list length, so a resume that lost the history would
 * restart at 1 and overwrite the logs of the previous attempts.
 */
export function projectStepAttempts(events: readonly RunJournalEvent[]): Map<string, PersistedAttempt[]> {
  const byStep = new Map<string, Map<number, PersistedAttempt>>();

  for (const event of events) {
    if (event.type !== ATTEMPT_STARTED && event.type !== ATTEMPT_FINISHED) continue;
    const stepId = text(event.stepId);
    const number = attemptNumber(event.attempt);
    if (!stepId || number === undefined) continue;

    let attempts = byStep.get(stepId);
    if (!attempts) {
      attempts = new Map();
      byStep.set(stepId, attempts);
    }

    if (event.type === ATTEMPT_STARTED) {
      attempts.set(number, {
        attempt: number,
        kind: attemptKind(event.kind),
        status: "running",
        started_at: text(event.ts) ?? "",
        log_path: text(event.logPath) ?? "",
      });
      continue;
    }

    // A finish without its start belongs to a truncated or older journal. Keep
    // the attempt: losing it would shift the numbering of every later attempt.
    const attempt = attempts.get(number) ?? {
      attempt: number,
      kind: attemptKind(event.kind),
      status: "running" as AttemptStatus,
      started_at: text(event.ts) ?? "",
      log_path: "",
    };
    applyFinished(attempt, event);
    attempts.set(number, attempt);
  }

  const projected = new Map<string, PersistedAttempt[]>();
  for (const [stepId, attempts] of byStep) {
    projected.set(
      stepId,
      [...attempts.values()].sort((left, right) => left.attempt - right.attempt),
    );
  }
  return projected;
}
