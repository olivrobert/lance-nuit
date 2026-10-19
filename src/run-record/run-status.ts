// runner/run-record/run-status.ts
//
// What a run status means, in one place.
//
// Every reader that turns a status into a decision (the dashboard, `--inspect`,
// `clean --keep-failed`, `close`, the stack stop, the signal handler, the
// statistics, a composing parent) asks this file, so a status cannot mean one
// thing on the dashboard and another in the CLI. Two tables hold the rules:
// `MEANING`, what a written status says, and `ENDINGS`, the precedence that picks
// the status, the report headline and the exit code of a run that ends.
//
// Everything here is pure. Whether a live process holds the run is a parameter:
// the lock belongs to `stores/run-storage.ts`, and a reader that cannot ask it
// (an archived run) says so by passing its own answer.

import type { PersistedRun, RunStatus } from "../model/persisted.js";

/** Final verdict; an active run is never derived and remains `RUNNING`. */
export type RunVerdict = Exclude<RunStatus, "RUNNING">;

interface StatusMeaning {
  /** `finalizeRun` (or an interruption) stamped it, and readers take it as is.
   *  `UNKNOWN` is stamped too, but only says the steps did not settle without
   *  saying why: readers treat it like a snapshot nobody finished. */
  verdict: boolean;
  /** The run did all of its work. */
  completed: boolean;
  /** The run ended without its work, through a failure or an interruption. */
  failure: boolean;
  /** The run stopped short of its work without a failure of its own: a clean
   *  stop, or an interruption. A composing parent stops in turn. */
  halted: boolean;
  /** Somebody has to act on the run: rerun it, decide, or close it. */
  awaitsHuman: boolean;
  /** Left by a crash (`RUNNING`) or an interruption (`ABORTED`), not a judgment
   *  of the work: once every step is settled, a later invocation still owes the
   *  run its verdict. */
  provisional: boolean;
  /** A resume continues the run. Never asked of `RUNNING`, which is no verdict. */
  resumable: boolean;
}

const MEANING: Readonly<Record<RunStatus, StatusMeaning>> = {
  RUNNING: {
    verdict: false,
    completed: false,
    failure: false,
    halted: false,
    awaitsHuman: false,
    provisional: true,
    resumable: false,
  },
  PASS: {
    verdict: true,
    completed: true,
    failure: false,
    halted: false,
    awaitsHuman: false,
    provisional: false,
    resumable: false,
  },
  FAIL: {
    verdict: true,
    completed: false,
    failure: true,
    halted: false,
    awaitsHuman: true,
    provisional: false,
    resumable: true,
  },
  STOPPED: {
    verdict: true,
    completed: false,
    failure: false,
    halted: true,
    awaitsHuman: true,
    provisional: false,
    resumable: true,
  },
  ABORTED: {
    verdict: true,
    completed: false,
    failure: true,
    halted: true,
    awaitsHuman: true,
    provisional: true,
    resumable: true,
  },
  UNKNOWN: {
    verdict: false,
    completed: false,
    failure: false,
    halted: false,
    awaitsHuman: false,
    provisional: false,
    resumable: true,
  },
};

/** The meaning of `status`; nothing holds for a missing status or one a newer
 *  runner wrote, since a snapshot is read without trusting its writer. */
function meaningOf(status: RunStatus | undefined): StatusMeaning | undefined {
  return status !== undefined && Object.hasOwn(MEANING, status) ? MEANING[status] : undefined;
}

/** A status that readers take as the run's verdict. */
export type StampedVerdict = Exclude<RunVerdict, "UNKNOWN">;

/** Statuses a reader takes as the run's verdict, in table order. */
export const VERDICT_STATUSES: readonly StampedVerdict[] = (Object.keys(MEANING) as RunStatus[]).filter(
  (status): status is StampedVerdict => MEANING[status].verdict,
);

export function hasVerdict(status: RunStatus | undefined): status is StampedVerdict {
  return meaningOf(status)?.verdict === true;
}

export function isCompleted(status: RunStatus | undefined): boolean {
  return meaningOf(status)?.completed === true;
}

export function isFailure(status: RunStatus | undefined): boolean {
  return meaningOf(status)?.failure === true;
}

export function isHalted(status: RunStatus | undefined): boolean {
  return meaningOf(status)?.halted === true;
}

/** The statuses a person may close, keep the logs of with `--keep-failed`, and
 *  find under "Needs you". */
export function awaitsHuman(status: RunStatus | undefined): boolean {
  return meaningOf(status)?.awaitsHuman === true;
}

export function isProvisionalStatus(status: RunStatus | undefined): boolean {
  return meaningOf(status)?.provisional === true;
}

/** Completed (PASS) runs do not resume; interrupted or failed runs do. */
export function isResumableStatus(status: RunVerdict): boolean {
  return meaningOf(status)?.resumable === true;
}

/**
 * The snapshot owes a verdict once its steps are all settled: a crash left it
 * `RUNNING`, or an interruption left it `ABORTED` without opting out of resuming.
 * A `RUNNING` snapshot carries no outcome (a live resume drops it), so the
 * opt-out only ever reads an `ABORTED` one.
 */
export function awaitsFinalization(state: Pick<PersistedRun, "status" | "outcome">): boolean {
  return isProvisionalStatus(state.status) && state.outcome?.resumable !== false;
}

/** The statuses a reader shows: `UNKNOWN` is read as a run nobody finished. */
export type EffectiveRunStatus = Exclude<RunStatus, "UNKNOWN">;

export interface EffectiveStatus {
  status: EffectiveRunStatus;
  /** The snapshot carries no verdict and no live process holds the run: its
   *  runner died (crash, kill, reboot). `status` is then `ABORTED`. */
  interrupted: boolean;
}

/**
 * Status of a run as the runner itself would judge it.
 *
 * A snapshot without a verdict (`RUNNING`, `UNKNOWN`, missing, or a value this
 * runner does not know) is only live while a process holds the run: a runner
 * killed without a chance to clean up leaves `RUNNING` behind forever. Such a
 * run is served as `ABORTED`, the status the runner persists for an interruption
 * it lived to record, so every reader and a later resume agree on what is live.
 * `holderAlive` is asked only for a snapshot without a verdict.
 */
export function effectiveStatus(state: Pick<PersistedRun, "status">, holderAlive: () => boolean): EffectiveStatus {
  if (hasVerdict(state.status)) return { status: state.status, interrupted: false };
  return holderAlive() ? { status: "RUNNING", interrupted: false } : { status: "ABORTED", interrupted: true };
}

/** What is known about a run as it ends. A fact the caller cannot know is left
 *  out and reads false. */
export interface RunEndingFacts {
  /** The run was interrupted. */
  aborted?: boolean;
  /** The run stopped cleanly (a gate, a block, the `--until` bound). */
  stopped?: boolean;
  failed?: boolean;
  /** The failure is a judgment on the work (`failKind: "verdict"`), not an
   *  incident. */
  verdictFailure?: boolean;
  budgetExceeded?: boolean;
  /** The ledger is a lower bound: some spending could not be priced. */
  costUnaccounted?: boolean;
  /** The accounting gate is what withheld the work: the ledger is the REASON
   *  the run ended, not only a caveat on its total. */
  costUnaccountedStop?: boolean;
  /** The run stopped at the `--until` bound the operator asked for. */
  untilStop?: boolean;
  /** Every step settled. */
  settled?: boolean;
}

/** Why a run ended, as its report headlines it. */
export type RunEndingKind = "success" | "verdict" | "failure" | "stopped" | "aborted" | "budget" | "cost" | "unknown";

/** The class of exit code: the entry point maps it to a number. */
export type RunExit = "interrupted" | "failure" | "until" | "success";

export interface RunEnding {
  kind: RunEndingKind;
  status: RunVerdict;
  exit: RunExit;
}

type Facts = Required<RunEndingFacts>;

interface EndingRow {
  kind: RunEndingKind;
  when: (facts: Facts) => boolean;
  status: (facts: Facts) => RunVerdict;
  exit: (facts: Facts) => RunExit;
}

// A clean stop names the run's status over the failure or the cost stop that came
// with it: the status says what the run waits on, and resuming reads it. The
// headline and the exit code still say why it ended.
const stoppedOrFailed = (facts: Facts): RunVerdict => (facts.stopped ? "STOPPED" : "FAIL");

// An unpriced ledger makes the exit non-zero whatever else ended the run: an
// unattended caller (--scan, cron, a parent dispatch) must not read unfinished
// work as success. A stop at the `--until` bound has a code of its own, so a
// caller tells it from a failure.
const quietExit = (facts: Facts): RunExit =>
  facts.costUnaccounted ? "failure" : facts.untilStop ? "until" : "success";

/**
 * Precedence of a run's ending, first match wins: interruption > budget stop >
 * failure > accounting stop > clean stop > success > unknown.
 *
 * - An interruption outranks everything: it is why the run stopped, and the
 *   steps it cut short cannot be judged.
 * - A budget stop outranks a failed step: the step that carries the guard's kill
 *   is the consequence of the stop, and calling it a technical error would send
 *   an operator to a fix loop. `budget` also outranks `cost`, the precedence
 *   `costDecision` settled.
 * - The accounting stop ranks below a genuine failure: a step that failed for its
 *   own reason on an unpriced attempt is a failure. It wins only when the gate
 *   itself withheld the work, and then the failed step (an orchestration node
 *   refused at its own gate) is the carrier of the stop.
 */
const ENDINGS: readonly EndingRow[] = [
  { kind: "aborted", when: (f) => f.aborted, status: () => "ABORTED", exit: () => "interrupted" },
  { kind: "budget", when: (f) => f.budgetExceeded, status: stoppedOrFailed, exit: () => "failure" },
  {
    kind: "verdict",
    when: (f) => f.failed && !f.costUnaccountedStop && f.verdictFailure,
    status: stoppedOrFailed,
    exit: () => "failure",
  },
  { kind: "failure", when: (f) => f.failed && !f.costUnaccountedStop, status: stoppedOrFailed, exit: () => "failure" },
  { kind: "cost", when: (f) => f.costUnaccountedStop, status: stoppedOrFailed, exit: () => "failure" },
  { kind: "stopped", when: (f) => f.stopped, status: () => "STOPPED", exit: quietExit },
  // A lower-bound ledger with no stop to show for it: the work is not proven
  // finished, so it is no pass, and nothing names a cause either.
  { kind: "unknown", when: (f) => f.costUnaccounted, status: () => "FAIL", exit: () => "failure" },
  { kind: "success", when: (f) => f.settled, status: () => "PASS", exit: quietExit },
  { kind: "unknown", when: () => true, status: () => "UNKNOWN", exit: quietExit },
];

/** The ending of a run: its status, its report headline and its exit class, all
 *  read from the same row of `ENDINGS`. */
export function runEnding(facts: RunEndingFacts): RunEnding {
  const known: Facts = {
    aborted: facts.aborted === true,
    stopped: facts.stopped === true,
    failed: facts.failed === true,
    verdictFailure: facts.verdictFailure === true,
    budgetExceeded: facts.budgetExceeded === true,
    costUnaccounted: facts.costUnaccounted === true,
    costUnaccountedStop: facts.costUnaccountedStop === true,
    untilStop: facts.untilStop === true,
    settled: facts.settled === true,
  };
  // The last row matches every set of facts.
  const row = ENDINGS.find((candidate) => candidate.when(known)) as EndingRow;
  return { kind: row.kind, status: row.status(known), exit: row.exit(known) };
}
