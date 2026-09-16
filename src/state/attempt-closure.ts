// runner/state/attempt-closure.ts
//
// The single writer of an attempt's end. Normal completion (`finishAttempt`), a
// SIGINT/SIGTERM interruption (`abortRun`) and a hard crash detected on resume
// (`settleCrashedAttempts`) all close their attempt through `closeAttempt`, so the
// status, the stats and the `step.attempt.finished` event have one shape and one
// set of rules.
//
// The spend the attempt reports is not written here: `chargeClosedAttempt`
// (`state/cost-accounting.ts`) records it on the attempt and adds it to the step
// total, so that every figure in the ledger has one owner. This module keeps what
// is not money: the status, the timestamps, the session, the log path, and the
// event.
//
// Synchronous and free of I/O beyond the journal: `abortRun` calls it from the
// signal handler. Persisting the snapshot (`saveRun`) is left to the callers.

import type { AgentSession, AttemptStats, StepControl, StepUsage } from "../contracts/backends.js";
import { isAgentStep } from "../contracts/backends.js";
import type { PersistedAttempt } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import { chargeClosedAttempt, type SettledSpend } from "./cost-accounting.js";
import { appendRunEvent } from "./run-journal.js";
import { splitAttemptStats } from "./stats/stats.js";

/** True when the backend measured anything at all: a token count or a price. */
export function hasSpendFigures(stats?: AttemptStats): boolean {
  return (
    stats?.input_tokens != null ||
    stats?.output_tokens != null ||
    stats?.cache_read_tokens != null ||
    stats?.total_cost_usd != null
  );
}

/**
 * Normalize the stats of one attempt before they reach the ledger or the step.
 *
 * An agent attempt (a step with a backend, or any fix pass) that failed before
 * reporting any usage — killed by the timeout, the straggler check, a signal, or
 * broken by the transport before the first usage event — still spent tokens.
 * Without `cost_unknown` the ledger reads it as free and `max_cost_usd` stops
 * meaning anything. This is the only place that rule lives.
 */
export function settleAttemptStats(
  step: RunStep,
  kind: "step" | "fix",
  ok: boolean,
  stats?: AttemptStats,
): { control: StepControl; usage?: StepUsage } {
  const metered = kind === "fix" || isAgentStep(step.def);
  if (!ok && metered && !hasSpendFigures(stats)) {
    return splitAttemptStats({ ...(stats ?? { duration_ms: 0 }), cost_unknown: true });
  }
  return splitAttemptStats(stats);
}

export interface AttemptOutcome {
  status: "done" | "failed" | "aborted";
  /** Raw backend figures; normalized through `settleAttemptStats`. */
  stats?: AttemptStats;
  /** Already-computed control (abort: duration and live estimate). Takes
   * precedence over `stats`; the `cost_unknown` rule still applies to it. */
  control?: StepControl;
  session?: AgentSession;
  reason?: string;
  /** Logical or run-relative log path; the attempt keeps its own when absent. */
  logPath?: string;
}

/**
 * Close one attempt: status, timestamps, the charge onto the attempt and the step
 * total, and the `step.attempt.finished` event. Returns `undefined` without
 * touching anything when the attempt is no longer `running`: the first closer
 * wins, whichever path it came from (loop, signal handler, resume).
 *
 * An accepted closure returns the figures it stored, so whatever else the attempt
 * must reach (the in-loop ledger, for a tracked attempt) is fed the same numbers
 * instead of normalizing the raw stats a second time.
 *
 * Only the attempt and the step totals are written here. `step.status`,
 * `step.fail_kind` and every `run.*` field are step or run transitions and stay
 * with their callers.
 */
export function closeAttempt(
  run: Run,
  step: RunStep,
  attempt: PersistedAttempt,
  outcome: AttemptOutcome,
): SettledSpend | undefined {
  if (attempt.status !== "running") return undefined;
  const ok = outcome.status === "done";
  const settled = outcome.control
    ? settleAttemptStats(step, attempt.kind, ok, outcome.control)
    : settleAttemptStats(step, attempt.kind, ok, outcome.stats);

  attempt.status = outcome.status;
  attempt.finished_at = new Date().toISOString();
  if (outcome.session !== undefined) attempt.session = outcome.session;
  // Cost accounting owns the figures: it stores them on the attempt, adds them to
  // the step total that seeds the budget ledger on resume, and returns what it
  // wrote for the event below.
  const charged = chargeClosedAttempt(step, attempt, settled);
  const { control, usage } = charged;
  if (outcome.reason !== undefined) attempt.errors = outcome.reason;
  if (outcome.logPath !== undefined) attempt.log_path = outcome.logPath;

  // Every field is passed unconditionally, never through a conditional spread:
  // excess-property checking does not reach a spread, so a misspelled field name
  // would compile and land in the journal. `undefined` is dropped by
  // `JSON.stringify`, so the shape written to disk is unchanged.
  appendRunEvent(run, "step.attempt.finished", {
    stepId: step.id,
    attempt: attempt.attempt,
    kind: attempt.kind,
    status: attempt.status,
    sessionId: attempt.session?.id,
    // The full session, so resume can project the attempt without the snapshot.
    session: attempt.session,
    provider: control.provider ?? attempt.session?.provider,
    model: control.model,
    costUsd: control.total_cost_usd,
    control,
    usage,
    logPath: attempt.log_path,
    reason: attempt.errors,
  });
  return charged;
}
