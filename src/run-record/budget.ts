// runner/run-record/budget.ts
//
// The run cost ledger and the stop decisions read off it. PURE helpers: the cost
// gate (`costGate`, `run-record/cost-stop-events.ts`) decides through them, the
// live guards and the dashboard read the strict policy from them.
//
// This module declares the ledger; it does not fill it. Every figure in it is
// written by `run-record/cost-accounting.ts` (`openRunLedger`,
// `chargeAttemptToLedger`, `chargeChildReconciliation`), which is the only place
// spend moves.

/**
 * MUTABLE ledger for run spending. Opened once per execution (`openRunLedger`) and shared by
 * all phases (admission, attempts, verdict, repair, child runs): no signature
 * passes `cumulativeCost` back and forth, and each phase can update the value it
 * changed without rewriting the whole budget.
 *
 * `remaining` is recalculated as close to spawn as possible (`budgetGateMiddleware`), never
 * captured before spawn: `cumulative` changes between attempts of the same step.
 */
export interface RunBudget {
  /** Cumulative run cost, in dollars: what the steps carried when the ledger was
   * opened, plus every charge since. A counter rather than a sum read off the
   * steps: the two agree on every charge, and differ only where a counter is
   * the safer figure — a total the previous generation materialized seeds it
   * whole, and the order of the additions is the order the spend happened. One
   * closer moves a step total without it: the signal handler (`abortRun`), which
   * holds no ledger and after which the loop spends nothing more; the console
   * report reads the larger of the two for that run, and the next execution
   * seeds from the step totals. */
  cumulative: number;
  /** Budget remaining passed to spawn; `undefined` = no limit defined. */
  remaining?: number;
  /** At least one attempt PROVED unpriceable consumption (`isUnpricedSpend`):
   * tokens or an amount were measured and no usable price covers them.
   * `cumulative` is a LOWER BOUND from then on, and any ceiling built on it is
   * advisory. An attempt that died before reporting any figure is not evidence:
   * its control keeps `cost_unknown` for the report, but the run keeps going. */
  costUnknown?: boolean;
  /** A gate already WITHHELD work over that uncertainty: step admission, a retry,
   * a fix pass, a composed child launch, a loop callback, or a live accounting
   * guard. The retry loops break on the decision without reporting upward, so the
   * shared ledger is where the stop is recorded; the step loop reads it to name
   * the stop reason in the report instead of blaming the step that happens to be
   * red. Written by `recordCostStop` (`run-record/cost-stop-events.ts`) only. */
  unaccountedStop?: boolean;
  /** `run.cost.unaccounted` has already been journaled for this generation.
   * Several gates observe the same stop in a row (admission after a retry gate,
   * a composed launch after admission), and the journal must carry one fact per
   * stop, not one per observer. Owned by `run-record/cost-stop-events.ts`. */
  unaccountedJournaled?: boolean;
  /** A live cost guard killed an attempt mid-flight for crossing `remaining`.
   * `cumulative` may still sit under the ceiling — the guard fires on an estimate
   * the provider never confirmed — so this flag, not the ledger, is what stops the
   * retry loops and what makes the report read "Budget exceeded". It is mirrored
   * into `run.budget_exceeded` so a resume without `--budget` stops the same way.
   * Latched by `recordCostStop` on a live-guard stop and by
   * `inheritChildBudgetStop` when a composed child stopped at its guard; restored
   * from the snapshot by `openRunLedger`. */
  exceeded?: boolean;
  /** `run.budget.exceeded` has already been journaled for this generation, with
   * the same one-fact-per-stop rule as `unaccountedJournaled`. */
  exceededJournaled?: boolean;
  /** The operator explicitly authorized spending nobody can price (`--allow-unmetered`).
   * It lifts the `unaccounted` stop only; the known lower bound still obeys the
   * ceiling, and no unknown marker is cleared. Fed by the CLI and the persisted
   * run-level authorization; `undefined` means strict. */
  allowUnmetered?: boolean;
}

/**
 * Why a capped run may or may not admit more work.
 *
 * `exceeded` — the ledger reached the ceiling, or a live guard already killed an
 * attempt for crossing it. `unaccounted` — an attempt spent tokens no pricing
 * table could price, so the ceiling is unenforceable and the run stops with a
 * reason of its own instead of pretending the remainder is affordable.
 * `continue` — spending may go on.
 */
export type CostDecision = "continue" | "exceeded" | "unaccounted";

/** Whether a limit is defined and already reached/exceeded. No limit → false. */
export function isBudgetExceeded(maxCost: number | undefined, cumulativeCost: number): boolean {
  return maxCost != null && cumulativeCost >= maxCost;
}

/**
 * The one stop decision every retry, fix, admission gate, and orchestration node
 * reads. Reading the ledger alone is not enough: a killed attempt whose partial
 * cost lands under the ceiling would be replayed and paid again, and an unpriced
 * attempt would leave the ceiling looking affordable forever.
 *
 * Precedence: a reached ceiling wins over uncertainty. Both are stops, and the
 * known lower bound is the harder fact — an authorization for unmetered spend
 * must not turn a genuinely exceeded budget into a continue.
 *
 * Uncertainty only stops a CAPPED run: with no ceiling to enforce there is
 * nothing for unknown spend to invalidate, and the run keeps its warning.
 */
export function costDecision(maxCost: number | undefined, budget: RunBudget): CostDecision {
  if (budget.exceeded === true || isBudgetExceeded(maxCost, budget.cumulative)) return "exceeded";
  if (budget.costUnknown === true && strictCostAccountingFor(maxCost, budget.allowUnmetered)) return "unaccounted";
  return "continue";
}

/**
 * Whether unpriceable spend stops this run: a ceiling exists, and no human
 * authorized spend nobody can price. Without the ceiling there is nothing to
 * enforce; with the authorization the run has already accepted the uncertainty.
 *
 * The one statement of the strict policy, read by the stop decision above, by
 * the live guards at spawn time, and by the dashboard over a persisted run.
 */
export function strictCostAccountingFor(
  maxCost: number | null | undefined,
  allowUnmetered: boolean | undefined,
): boolean {
  return maxCost != null && allowUnmetered !== true;
}

/** Remaining budget (>= 0), or undefined when no limit is set. */
export function remainingBudget(maxCost: number | undefined, cumulativeCost: number): number | undefined {
  return maxCost != null ? Math.max(0, maxCost - cumulativeCost) : undefined;
}
