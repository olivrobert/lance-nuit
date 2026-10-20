// runner/run-record/cost-stop-events.ts
//
// The two run-level cost stops: how a `costDecision` that withholds work, or a
// live guard's kill, is RECORDED — on the shared ledger, on the run, and in the
// journal. `run-record/budget.ts` decides; `run-record/cost-accounting.ts` owns the figures
// and the uncertainty they prove; this module owns the stop itself, so no gate
// synchronizes those three writes by hand.
//
// Neither stop is machine-readable without this module: the console prints a
// sentence, `outcome.reason` keeps a copy of it, and the failing step carries
// `failKind: "technical"` — the guard's kill looks like any other broken process.
// `run.budget_exceeded` is not an answer either: a `--budget` resume deliberately
// wipes it, so a post-mortem run over the snapshots cannot tell a budget stop from
// a technical failure once the operator raised the ceiling.
//
// Every gate that withholds work therefore records the stop here, and records it
// where the decision is taken rather than where the run is finalized: the run
// journal is append-only, so the fact survives the next generation rewriting the
// snapshot. `outcome.stopKind` (`finalizeRun`, `run-record/run-transitions.ts`) is the same fact on the
// snapshot side.
//
// ONCE per stop, per generation. The ledger carries the latch: it is created once
// per execution (`openRunLedger`) and shared by admission, the retry and fix gates, the
// composed-launch gates, and the live guards, which are exactly the sites that can
// observe the same stop one after another. A resume decides again, on a new
// ledger, and journals again — that is a new stop, not a duplicate.
//
// Five facts, kept apart on purpose because they coexist:
//
// - `budget.costUnknown` / `run.cost_unaccounted` — PROOF of unpriceable
//   consumption. Written by cost accounting when it charges the figures; never
//   here. Uncertainty alone is not a stop.
// - `budget.exceeded` / `run.budget_exceeded` — a live guard established that the
//   ceiling was crossed, on an estimate the ledger may never confirm. Written
//   here (`live-guard` origin, and inherited from a stopped child); restored by
//   `openRunLedger` from the snapshot and wiped by a `--budget` resume in
//   `run-record/run-opening.ts`.
// - `budget.unaccountedStop` — work was actually WITHHELD over the uncertainty.
//   Written here only; read by the step loop to name the stop reason.
// - `exceededJournaled` / `unaccountedJournaled` — the one-fact-per-generation
//   latches of the two journal events. Written here only.
// - `budget.allowUnmetered` / `run.allow_unmetered` — the human authorization
//   that lifts the `unaccounted` stop. Owned by `run-record/run-opening.ts` and the CLI;
//   this module never touches it.

import type { RunView } from "../model/run.js";
import type { Run } from "./run.js";
import { writable } from "./run.js";
import { type CostDecision, costDecision, type RunBudget } from "./budget.js";
import { appendRunEvent } from "./run-journal.js";

/** A `costDecision` that stops the run. */
export type CostStop = Exclude<CostDecision, "continue">;

/**
 * Where a stop was observed. The origin decides which facts the stop
 * establishes; the caller reports it and nothing else.
 *
 * `gate` — a gate consulted `costDecision` before spending (step admission, a
 * retry, a fix pass, a composed child launch, a loop callback) and withholds the
 * next unit of work. The decision rests on facts already recorded: the ledger of
 * closed attempts, or a latch a previous kill left behind.
 *
 * `live-guard` — a live guard killed the attempt mid-flight. This is where the
 * `exceeded` latch is born: the guard fired on its own running total, which the
 * provider never confirmed, so the closed attempt's cost can land under the
 * ceiling and the ledger alone would replay — and repay — the killed step.
 */
export interface CostStopOrigin {
  /** Step whose gate, or whose attempt, observed the stop. `null` for a stop
   *  observed with no step in scope. */
  stepId: string | null;
  kind: "gate" | "live-guard";
}

/**
 * Record a cost stop: the ledger latches, the durable run field, and the journal
 * event, in one place. Callers pass the decision and its origin; they do not
 * synchronize the indicators of the same transition themselves.
 *
 * Both stops can be recorded for one attempt when a guard established both; each
 * is journaled once per generation regardless of how many sites observe it.
 */
export function recordCostStop(run: Run, budget: RunBudget, stop: CostStop, origin: CostStopOrigin): void {
  if (stop === "exceeded") {
    if (origin.kind === "live-guard") {
      // Journaled BEFORE the latch is set, so `estimated` is not read from a state
      // this very kill established.
      journalBudgetExceeded(run, budget, { stepId: origin.stepId, estimated: true });
      latchBudgetExceeded(run, budget);
      return;
    }
    // `estimated` distinguishes the two roads to a gate: a ledger that reached the
    // ceiling on closed attempts, or the flag a live guard's estimate left on the
    // run (`budget_exceeded`, restored by the resume). The gate itself latches
    // nothing: the ledger is the fact, and a resume reaches the same decision.
    journalBudgetExceeded(run, budget, { stepId: origin.stepId, estimated: budget.exceeded === true });
    return;
  }
  // An accounting stop is a STOP, not just the `costUnknown` latch: the gate (or
  // the guard) withheld work, which is what tells the final report the
  // uncertainty is the REASON the run ended and not a lower-bound total beside a
  // step that failed on its own. The bare latch is deliberately not recorded
  // here: it only says the total is a lower bound, and `step.cost.unaccounted`
  // already covers it per attempt.
  budget.unaccountedStop = true;
  journalCostUnaccounted(run, budget, origin.stepId);
}

/**
 * The one cost gate: decide whether a capped run may spend on the next unit of
 * work, and record the stop when it may not.
 *
 * Every site that is about to spend asks here — step admission, the re-ask of a
 * refused capture, a rerun, a repair pass, the replay after a repair, and a
 * composed launch (child or callback) — and keeps only its own message, so the
 * same budget gives the same stop record whichever site observed it. The stop is
 * recorded on `run`: for a composed launch that is the parent, the scope that
 * owns the ceiling.
 */
export function costGate(runView: RunView, budget: RunBudget, stepId: string | null): CostStop | undefined {
  const run = writable(runView);
  const decision = costDecision(run.max_cost_usd, budget);
  if (decision === "continue") return undefined;
  recordCostStop(run, budget, decision, { kind: "gate", stepId });
  return decision;
}

/** The cost stops the step loop reports once it returns. */
export interface LedgerStops {
  budgetExceeded: boolean;
  costUnaccounted: boolean;
  costUnaccountedStop: boolean;
}

/**
 * What the shared ledger says about the run when the step loop returns: the
 * stops reached inside the retry and fix loops, which break on the gate's
 * decision without reporting it upward. Reads only, records nothing: each stop
 * was recorded where it was observed.
 *
 * Only unfinished work can be stopped. A run that completed every step under an
 * unenforceable ceiling has nothing left to withhold, and turning its verdict
 * into a stop after the fact would fail a pipeline that did its job; the same
 * holds for a guard stop restored from the snapshot once a resume skipped the
 * step the guard killed. "Unfinished" is the caller's reading of the steps
 * (`hasUnfinishedWork`). `exceeded` keeps its precedence over `unaccounted`, as
 * in `costDecision`.
 */
export function ledgerStops(run: RunView, budget: RunBudget, unfinished: boolean): LedgerStops {
  const decision = unfinished ? costDecision(run.max_cost_usd, budget) : "continue";
  return {
    budgetExceeded: budget.exceeded === true && unfinished,
    costUnaccounted: decision === "unaccounted",
    costUnaccountedStop: budget.unaccountedStop === true && decision === "unaccounted",
  };
}

/**
 * A composed child was stopped by its own guard. The parent latches the ceiling
 * stop the same durable way: the child's partial cost is folded into this ledger,
 * yet may leave it under the ceiling, and a plain resume would then rerun the
 * child and pay again. The fact itself lives in the CHILD's journal (its guard
 * recorded it there) and on the parent's `run.finished` outcome; the parent
 * appends no event of its own for it.
 */
export function inheritChildBudgetStop(parentView: RunView, budget: RunBudget): void {
  const parent = writable(parentView);
  latchBudgetExceeded(parent, budget);
}

/** The guard verdict, on the ledger the retry loops read and on the run a resume
 *  without `--budget` restores. `cumulative` may still sit under the ceiling. */
function latchBudgetExceeded(run: Run, budget: RunBudget): void {
  budget.exceeded = true;
  run.budget_exceeded = true;
}

/** Steps left to fund, counted the way the console blocks count them: work not
 *  started yet. A step in flight is already paid for. */
function remainingSteps(run: Run): number {
  return run.steps.filter((step) => step.status === "pending").length;
}

/** A ceiling stop: the ledger reached `max_cost_usd`, or a live guard killed an
 *  attempt for crossing what was left of it. `estimated` is true when the figure
 *  that triggered the stop is one the provider never confirmed. */
function journalBudgetExceeded(run: Run, budget: RunBudget, fact: { stepId: string | null; estimated: boolean }): void {
  if (budget.exceededJournaled === true) return;
  budget.exceededJournaled = true;
  appendRunEvent(run, "run.budget.exceeded", {
    stepId: fact.stepId,
    cumulativeUsd: budget.cumulative,
    maxCostUsd: run.max_cost_usd ?? null,
    estimated: fact.estimated,
    remainingSteps: remainingSteps(run),
  });
}

/** An accounting stop: spend was measured that no pricing table could price, so
 *  the ceiling is unenforceable and this gate withheld the next unit of work.
 *  `cumulativeUsd` is a LOWER BOUND, unlike the budget event's figure. */
function journalCostUnaccounted(run: Run, budget: RunBudget, stepId: string | null): void {
  if (budget.unaccountedJournaled === true) return;
  budget.unaccountedJournaled = true;
  appendRunEvent(run, "run.cost.unaccounted", {
    stepId,
    cumulativeUsd: budget.cumulative,
    maxCostUsd: run.max_cost_usd ?? null,
    remainingSteps: remainingSteps(run),
  });
}
