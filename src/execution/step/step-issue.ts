//
// What became of a step, as a value. Produced where the issue is known and handed
// up unchanged: no level re-derives it from the abort flag or the ledger.

import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";

/** The cost stops an issue carries up to the run's outcome. */
export interface CostStops {
  budgetExceeded: boolean;
  /** Spending became unaccountable under a ceiling: the ledger is a lower bound. */
  costUnaccounted: boolean;
  /** The accounting stop is the REASON the work stopped (a gate withheld it), not
   *  just a caveat on the total next to a failure of the step's own. */
  costUnaccountedStop: boolean;
}

export const NO_COST_STOPS: CostStops = { budgetExceeded: false, costUnaccounted: false, costUnaccountedStop: false };

/** Why a step or a child run ended without succeeding, as the one that ran
 *  established it: a quality verdict is not a technical error, and an obstacle
 *  outside the code is not worth a fix. */
export interface StepHalt {
  cost: CostStops;
  reason?: string;
  failKind?: StepFailKind;
  failCause?: StepFailCause;
}

export type StepIssue =
  /** Succeeded; `suffix` says how ("after 2 reruns"). The pass writes `done`. */
  | { kind: "done"; suffix?: string }
  /** A non-blocking failure was absorbed into `step.errors`; the run goes on. */
  | { kind: "absorbed" }
  | ({ kind: "failed" } & StepHalt)
  | ({ kind: "stopped" } & StepHalt)
  /** A replay declared an obstacle outside the code; the outcome phase stops the
   *  run on it, as it does for a first attempt. */
  | { kind: "blocked"; failReason?: string }
  | { kind: "budget-exceeded" }
  /** An admission gate refused: the ledger stopped being a ceiling. */
  | { kind: "cost-unaccounted" }
  | { kind: "interrupted" }
  /** The members of a `parallelize` group, which answer together. */
  | { kind: "group"; members: readonly StepIssue[] };

export const DONE: StepIssue = { kind: "done" };
export const ABSORBED: StepIssue = { kind: "absorbed" };
export const INTERRUPTED: StepIssue = { kind: "interrupted" };

export function failed(halt: Partial<StepHalt> = {}): StepIssue {
  return { kind: "failed", cost: NO_COST_STOPS, ...halt };
}

export function stopped(halt: Partial<StepHalt> = {}): StepIssue {
  return { kind: "stopped", cost: NO_COST_STOPS, ...halt };
}

/** Whether the loop must not go on after this issue. */
export function haltsLoop(issue: StepIssue): boolean {
  switch (issue.kind) {
    case "done":
    case "absorbed":
      return false;
    case "group":
      return issue.members.some(haltsLoop);
    default:
      return true;
  }
}

/** The signals an issue adds to the run's outcome. Interrupted adds none: the run's
 *  `aborted` flag carries that verdict. */
export interface IssueSignals extends CostStops {
  failed: boolean;
  stopped: boolean;
}

export function signalsOf(issue: StepIssue): IssueSignals {
  const none: IssueSignals = { ...NO_COST_STOPS, failed: false, stopped: false };
  switch (issue.kind) {
    case "failed":
      return { ...issue.cost, failed: true, stopped: false };
    case "stopped":
      return { ...issue.cost, failed: false, stopped: true };
    case "budget-exceeded":
      return { ...none, budgetExceeded: true };
    case "cost-unaccounted":
      return { ...none, costUnaccounted: true, costUnaccountedStop: true };
    case "group":
      return issue.members.map(signalsOf).reduce(
        (all, member) => ({
          failed: all.failed || member.failed,
          stopped: all.stopped || member.stopped,
          budgetExceeded: all.budgetExceeded || member.budgetExceeded,
          costUnaccounted: all.costUnaccounted || member.costUnaccounted,
          costUnaccountedStop: all.costUnaccountedStop || member.costUnaccountedStop,
        }),
        none,
      );
    default:
      return none;
  }
}
