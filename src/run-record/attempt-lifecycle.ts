// runner/run-record/attempt-lifecycle.ts
//
// The two ends of a tracked attempt, as the step layer sees them: `openAttempt`
// before spawn and `settleAttempt` once the spawn returned or rejected. Each one
// writes every record its end touches, in a fixed order, and the snapshot last,
// so the step layer runs the attempt and reports it without sequencing the
// numbering, the journal, the verdict, the ledger and the stops by hand.
//
// The rules stay with their owners: closure in `attempt-closure.ts`, figures in
// `cost-accounting.ts`, stops in `cost-stop-events.ts`, the step verdict in
// `run-transitions.ts`. This file only orders them. Two other closers end an
// attempt without this file: the signal handler (`abortRun`), which has no ledger
// in scope, and crash settlement on resume (`settleCrashedAttempts`); the ledger
// of the next generation is seeded from the step totals they charge.

import type { AgentSession, AttemptStats, StepFailCause, StepFailKind } from "../contracts/backends.js";
import type { PersistedAttempt } from "../model/persisted.js";
import type { RunAttemptView, RunStepView, RunView } from "../model/run.js";
import type { Run, RunStep } from "./run.js";
import { writable } from "./run.js";
import { closeAttempt } from "./attempt-closure.js";
import type { RunBudget } from "./budget.js";
import { chargeAttemptToLedger, isUnpricedSpend } from "./cost-accounting.js";
import { recordCostStop } from "./cost-stop-events.js";
import { appendRunEvent, relativeRunPath } from "./run-journal.js";
import { saveRun } from "./run-repository.js";
import { attemptLogPath, logicalAttemptLogPath, nextAttemptNumber, writeAttemptCommand } from "./run-timeline.js";
import { recordStepVerdict } from "./run-transitions.js";

/** An attempt registered on its step, with the local path its log is written to. */
export interface OpenedAttempt {
  /** The running attempt: every closer identifies the attempt by this object. */
  attempt: RunAttemptView;
  /** Where the spawned process writes its output, on this machine. */
  logPath: string;
}

/**
 * Number the next attempt, allocate its log and register it `running` on the
 * step. Memory only: `openAttempt` journals and persists it.
 *
 * The number is set on `last_attempt` before the log is allocated, so a store
 * that refuses the allocation still burns the number rather than reusing it.
 */
export function allocateAttempt(run: Run, step: RunStep, kind: "step" | "fix" = "step"): OpenedAttempt {
  const number = nextAttemptNumber(step);
  step.last_attempt = number;
  const logPath = attemptLogPath(run, step, number);
  const attempt: PersistedAttempt = {
    attempt: number,
    kind,
    status: "running",
    started_at: new Date().toISOString(),
    log_path: logicalAttemptLogPath(step.id, number),
  };
  step.attempts ??= [];
  step.attempts.push(attempt);
  return { attempt, logPath };
}

export interface AttemptOpening {
  kind: "step" | "fix";
  /** Resolved step command or repair prompt, kept next to the log. */
  command: string;
  /** The session the attempt runs in or resumes, as the start event names it. */
  session?: AgentSession;
}

/**
 * Open an attempt: number and register it, keep its command beside its log,
 * journal `step.attempt.started`, and persist the snapshot BEFORE spawn — a kill
 * may come before the runner can persist anything else.
 */
export function openAttempt(runView: RunView, stepView: RunStepView, opening: AttemptOpening): OpenedAttempt {
  const run = writable(runView);
  const step = writable(stepView);
  const opened = allocateAttempt(run, step, opening.kind);
  if (opening.command) {
    try {
      writeAttemptCommand(opened.logPath, opening.command);
    } catch {
      // A diagnostic copy of the prompt: losing it costs the dashboard a view,
      // failing the attempt over it would cost the run.
    }
  }
  appendRunEvent(run, "step.attempt.started", {
    stepId: step.id,
    attempt: opened.attempt.attempt,
    kind: opening.kind,
    sessionId: opening.session?.id ?? null,
    logPath: opened.attempt.log_path,
  });
  saveRun(run);
  return opened;
}

/** What a spawn returned about one attempt, or what its rejection amounts to. */
export interface AttemptResult {
  ok: boolean;
  stats?: AttemptStats;
  session?: AgentSession;
  failReason?: string;
  failKind?: StepFailKind;
  failCause?: StepFailCause;
  /** A live cost guard killed the attempt for crossing the remaining budget. */
  budgetExceeded?: boolean;
  /** A live accounting guard killed the attempt on provably unpriceable usage. */
  costUnaccounted?: boolean;
}

/** Spend the attempt left at an unknown price. The step layer words the warning;
 *  the `step.cost.unaccounted` event is already journaled. */
export interface CostWarning {
  model?: string;
  /** `unpriced`: figures were measured and no price covers them. `unreported`:
   *  the attempt died before reporting any figure. */
  cause: "unpriced" | "unreported";
}

/**
 * Settle an attempt opened by `openAttempt`, whether its spawn returned or
 * rejected: closure, then — for an accepted closure only — the step verdict, the
 * ledger charge, the stops a live guard established, the unaccounted-cost event,
 * and the snapshot.
 *
 * A refused closure means another closer already settled the attempt — the
 * signal handler, or crash settlement — and this late result no longer describes
 * the step: nothing is charged, no verdict is rewritten, and the snapshot that
 * closer wrote stands.
 */
export function settleAttempt(
  runView: RunView,
  stepView: RunStepView,
  opened: OpenedAttempt,
  result: AttemptResult,
  budget: RunBudget,
): { costWarning?: CostWarning } {
  const run = writable(runView);
  const step = writable(stepView);
  const attempt = writable(opened.attempt);
  const logPath = run.logStore
    ? logicalAttemptLogPath(step.id, attempt.attempt)
    : (relativeRunPath(run.run_dir, opened.logPath) ?? attempt.log_path);
  const settled = closeAttempt(run, step, attempt, {
    status: result.ok ? "done" : "failed",
    stats: result.stats,
    session: result.session,
    reason: result.failReason,
    logPath,
  });
  if (!settled) return {};
  // A fix pass repairs rather than judging; only a step attempt carries the
  // command verdict.
  if (attempt.kind === "step") {
    recordStepVerdict(run, step, { ok: result.ok, failKind: result.failKind, failCause: result.failCause });
  }
  // The ledger is charged with the figures the closure stored, so the ledger, the
  // attempt and the step total agree on what the attempt cost. Two roads to the
  // accounting latch: figures that prove unpriceable consumption, or a live guard
  // that proved it and killed the process before it could report them.
  chargeAttemptToLedger(run, budget, settled.control, settled.usage, {
    guardProvedUnpriced: result.costUnaccounted === true,
  });
  // A guard kill is a stop, not a technical break: recorded like a gate's, so the
  // retry loops stop and the report names the cost stop instead of the process
  // the guard had to kill to reach it.
  const origin = { kind: "live-guard", stepId: step.id } as const;
  if (result.budgetExceeded) recordCostStop(run, budget, "exceeded", origin);
  if (result.costUnaccounted === true) recordCostStop(run, budget, "unaccounted", origin);
  const control = result.costUnaccounted === true ? { ...settled.control, cost_unknown: true } : settled.control;
  // Once per attempt, on the uncertainty itself rather than on the strict stop:
  // silence would read as a free attempt, whose spend the ceiling never sees.
  let costWarning: CostWarning | undefined;
  if (control.cost_unknown === true) {
    costWarning = {
      ...(control.model !== undefined ? { model: control.model } : {}),
      cause: isUnpricedSpend(control, settled.usage) ? "unpriced" : "unreported",
    };
    appendRunEvent(run, "step.cost.unaccounted", { stepId: step.id, model: control.model ?? null });
  }
  saveRun(run);
  return costWarning ? { costWarning } : {};
}
