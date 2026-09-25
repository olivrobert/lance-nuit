// runner/state/cost-accounting.ts
//
// The one module that WRITES a spend figure, and the one that says what a figure
// proves.
//
// Every dollar, millisecond and token the runner accounts for moves through one of
// the `charge*` functions below. Nothing else adds to a step total, an attempt
// total, or the run ledger: `mergeControl`, `mergeUsage` and the cumulative
// arithmetic are private here on purpose, so changing a cost rule means changing
// this file and reading the behaviors it names, instead of searching for whoever
// else might touch a budget.
//
// The four facts that move money:
//
//  - `chargeClosedAttempt` — an attempt ends (loop, signal handler, or crash
//    settled on resume). Called only by `closeAttempt` (`state/attempt-closure.ts`),
//    which owns the rest of the attempt's ending.
//  - `chargeAttemptToLedger` — the same attempt reaches the run ledger. Purely
//    arithmetic and free of I/O: `finishAttempt` (`step/step-attempt.ts`) calls
//    it with the figures `closeAttempt` accepted, on every exit of a tracked
//    attempt.
//  - `chargeChildReconciliation` — a composed child run reports an aggregated cost
//    the parent never saw pass as attempts.
//  - `projectStepSpend` / `restoreAttemptSpend` / `restoreRunTotals` — figures
//    read back from the snapshot and the journal on resume. Projections, not
//    charges: the spend was accounted for when the attempt closed, and charging
//    it again would double it.
//
// The run's `total_control` / `total_usage` are DERIVED: `finalizeRun` and
// `abortRun` materialize them from the step totals, a resume trusts them only on
// a terminal snapshot (`restoreRunTotals`), and every charge that reaches the run
// (`chargeAttemptToLedger`, `chargeChildReconciliation`) drops them, so a reader
// through `controlForRun` never prefers a previous generation's total over the
// steps that have since spent more.
//
// What counts as EVIDENCE that a run spent money nobody can price.
//
// `cost_unknown` on a control has two very different origins and the strict stop
// must only react to one of them:
//
//  1. Real unpriceable consumption — tokens the provider counted with no rate to
//     apply, a reported `$0` over spent tokens, an invalid figure, or a partial
//     amount the backend itself flagged as incomplete. The ceiling has become
//     unenforceable: the run must stop.
//  2. A precaution taken at closure — `settleAttemptStats` flags any failed
//     metered attempt that reported NO spend figures at all (transport break,
//     timeout, signal before the first usage event). Such an attempt may well
//     have burned tokens, so the total stays a `≥` lower bound and the report
//     says so — but nothing was measured, so stopping the run on it would freeze
//     a pipeline on the first transient transport failure, retries included.
//
// This module is the single place that tells the two apart. Reporting keeps
// reading `cost_unknown` (case 1 AND case 2 are both lower bounds); the latch,
// the budget decision, and every gate built on it read `isUnpricedSpend`.

import type { StepControl, StepUsage } from "../contracts/backends.js";
import type {
  PersistedAttempt,
  PersistedPipelineChildRef,
  PersistedRun,
  PersistedStepState,
} from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunBudget } from "./budget.js";
import { appendRunEvent } from "./run-journal.js";
import { usageDelta } from "./stats/stats.js";

/** Anything that carries an attempt's or a step's settled figures. Structural on
 *  purpose: an in-memory `RunStep`, a `PersistedStepState`, and a
 *  `PersistedAttempt` all satisfy it without this module importing them. */
export interface SpendFigures {
  control?: StepControl;
  usage?: StepUsage;
}

/** A step, in memory (attempts projected from the journal) or as persisted (no
 *  attempt list: the snapshot deliberately keeps only the step totals). */
export interface SpendingStep extends SpendFigures {
  attempts?: SpendFigures[];
}

/** One attempt's normalized figures, as `settleAttemptStats` produces them. */
export interface SettledSpend {
  control: StepControl;
  usage?: StepUsage;
}

function addOptional(a?: number, b?: number): number | undefined {
  return a != null || b != null ? (a ?? 0) + (b ?? 0) : undefined;
}

/**
 * Sum two controls. Private: a total only ever grows through a `charge*` function,
 * so there is no way to add spend to a step or a run from outside this module.
 */
function mergeControl(existing?: StepControl, incoming?: StepControl): StepControl {
  if (!existing) return incoming ?? { duration_ms: 0 };
  if (!incoming) return existing;
  return {
    duration_ms: existing.duration_ms + incoming.duration_ms,
    total_cost_usd: addOptional(existing.total_cost_usd, incoming.total_cost_usd),
    // Context-window usage and model: the latest attempt wins.
    last_turn_context_tokens: incoming.last_turn_context_tokens ?? existing.last_turn_context_tokens,
    context_window: incoming.context_window ?? existing.context_window,
    model: incoming.model ?? existing.model,
    ...(incoming.provider != null || existing.provider != null
      ? { provider: incoming.provider ?? existing.provider }
      : {}),
    cost_estimated: existing.cost_estimated || incoming.cost_estimated || undefined,
    // Sticky like cost_estimated: one unpriced attempt makes the whole step total
    // an underestimate, however many priced attempts follow it.
    ...(existing.cost_unknown || incoming.cost_unknown ? { cost_unknown: true } : {}),
  };
}

/** Token counterpart of `mergeControl`, private for the same reason. */
function mergeUsage(existing?: StepUsage, incoming?: StepUsage): StepUsage | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const tools = [...(existing.tools_used ?? [])];
  for (const tool of incoming.tools_used ?? []) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return {
    duration_api_ms: addOptional(existing.duration_api_ms, incoming.duration_api_ms),
    num_turns: addOptional(existing.num_turns, incoming.num_turns),
    input_tokens: addOptional(existing.input_tokens, incoming.input_tokens),
    output_tokens: addOptional(existing.output_tokens, incoming.output_tokens),
    cache_read_tokens: addOptional(existing.cache_read_tokens, incoming.cache_read_tokens),
    cache_creation_tokens: addOptional(existing.cache_creation_tokens, incoming.cache_creation_tokens),
    ...(existing.reasoning_tokens != null || incoming.reasoning_tokens != null
      ? { reasoning_tokens: addOptional(existing.reasoning_tokens, incoming.reasoning_tokens) }
      : {}),
    tools_used: tools.length > 0 ? tools : undefined,
  };
}

// ---------------------------------------------------------------------------
// Derived totals. Reads: they compute, they never store.
// ---------------------------------------------------------------------------

export function aggregateControl(steps: readonly RunStep[]): StepControl {
  let total: StepControl = { duration_ms: 0 };
  for (const step of steps) total = mergeControl(total, step.control);
  return total;
}

export function aggregateUsage(steps: readonly RunStep[]): StepUsage | undefined {
  let total: StepUsage | undefined;
  for (const step of steps) total = mergeUsage(total, step.usage);
  return total;
}

/**
 * Return the run-level control when it is already materialized, otherwise derive
 * it from the steps. Resume snapshots can contain either form: using this one
 * fallback keeps budget seeding and child reconciliation from repeating their own
 * step reductions (and from disagreeing about the fallback semantics).
 */
export function controlForRun(run: Pick<Run, "steps" | "total_control">): StepControl {
  return run.total_control ?? aggregateControl(run.steps);
}

/** Token counterpart of `controlForRun`: the run's materialized usage when it has
 *  one, otherwise the sum of its steps. */
export function usageForRun(run: Pick<Run, "steps" | "total_usage">): StepUsage | undefined {
  return run.total_usage ?? aggregateUsage(run.steps);
}

/** A run's measured cost, or `fallback` when it measured nothing. A child that
 *  died before pricing anything still reports the ledger the loop kept for it. */
export function measuredRunCost(run: Pick<Run, "steps" | "total_control">, fallback: number): number {
  const measured = controlForRun(run).total_cost_usd ?? 0;
  return measured || fallback;
}

// ---------------------------------------------------------------------------
// What the figures prove.
// ---------------------------------------------------------------------------

/** Tokens a provider actually counted. */
function consumedTokens(usage?: StepUsage): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_tokens ?? 0) +
    (usage?.cache_creation_tokens ?? 0)
  );
}

/**
 * Whether these figures prove unpriceable CONSUMPTION, the only thing that stops
 * a capped run.
 *
 * `cost_unknown` is necessary and not sufficient: something must also have been
 * measured. Tokens the provider counted are the primary evidence; an amount it
 * reported beside the part it could not price is the same evidence in dollars (a
 * lower bound is still a measurement). Neither present means the flag is the
 * closure precaution over an attempt that died before reporting anything: it
 * keeps the total honest (`≥`) without stopping the run.
 */
export function isUnpricedSpend(control?: StepControl, usage?: StepUsage): boolean {
  if (control?.cost_unknown !== true) return false;
  return consumedTokens(usage) > 0 || control.total_cost_usd != null;
}

/**
 * Whether one step proves unpriceable consumption.
 *
 * Attempts win over the step total whenever they are available: a step total
 * merges every attempt, so a priced attempt that spent tokens plus a failed
 * attempt that measured nothing produce a total carrying both `cost_unknown` and
 * tokens — evidence of nothing at all. An orchestration node has no attempts and
 * its reconciled child figures ARE its totals, so the fallback is the right read
 * there and on any snapshot (attempts live in the journal, not the snapshot).
 */
export function stepProvesUnpricedSpend(step: SpendingStep): boolean {
  const settled = step.attempts?.filter((attempt) => attempt.control !== undefined) ?? [];
  if (settled.length > 0) return settled.some((attempt) => isUnpricedSpend(attempt.control, attempt.usage));
  return isUnpricedSpend(step.control, step.usage);
}

/**
 * Whether the run's own history proves unpriceable consumption.
 *
 * This is what upgrades a snapshot written before the run-level latch existed:
 * the attempts (or the step totals standing in for them) are the evidence, and a
 * bare `total_control.cost_unknown` no longer is — an aggregate cannot say which
 * attempt the flag came from.
 */
export function runProvesUnpricedSpend(run: { steps?: SpendingStep[] } | null | undefined): boolean {
  return (run?.steps ?? []).some(stepProvesUnpricedSpend);
}

// ---------------------------------------------------------------------------
// The charges. Every spend figure the runner stores is written here.
// ---------------------------------------------------------------------------

/**
 * An attempt closes: record its own figures and add them to the step total.
 *
 * Purely arithmetic — the journal event, the status and the timestamps belong to
 * `closeAttempt` (`state/attempt-closure.ts`), the only caller. Returns the
 * figures actually stored, which the caller journals.
 */
export function chargeClosedAttempt(step: SpendFigures, attempt: SpendFigures, settled: SettledSpend): SettledSpend {
  // An unpriced attempt is an estimate by construction: the total that carries it
  // is a lower bound, and the report must say so.
  const control: StepControl = settled.control.cost_unknown
    ? { ...settled.control, cost_estimated: true }
    : settled.control;
  const usage = settled.usage;

  attempt.control = control;
  attempt.usage = usage;

  // The step total seeds the budget ledger on resume, so every closed attempt
  // reaches it, including the uncertainty flags.
  step.control = mergeControl(step.control, control);
  step.usage = mergeUsage(step.usage, usage);

  return { control, usage };
}

/** The run fields a charge updates: the ledger's authority over materialized
 *  totals, and the accounting latch a resume reads back. */
type ChargedRun = Pick<Run, "total_control" | "total_usage" | "cost_unaccounted">;

/**
 * Materialized totals describe the generation that finalized them. Any charge
 * reaching the run makes the steps the more complete record, so the totals are
 * dropped and `controlForRun` / `usageForRun` derive them until the next
 * finalization writes them again.
 */
function invalidateRunTotals(run: Pick<Run, "total_control" | "total_usage">): void {
  delete run.total_control;
  delete run.total_usage;
}

/**
 * The same attempt reaches the run ledger.
 *
 * PURELY ARITHMETIC and free of I/O: `finishAttempt` calls it from the attempt
 * lifecycle, which carries no `RunOutput`. Whoever holds the stop decision
 * journals it, not this function.
 *
 * `guardProvedUnpriced` is the second road to the accounting latch: a live guard
 * proved the usage unpriceable and killed the process before it could report
 * figures a mapper could normalize, so the proof is read from the attempt record
 * rather than inferred from the figures.
 *
 * What is deliberately NOT a latch: a failed attempt that reported nothing at
 * all. `settleAttemptStats` flags it `cost_unknown` so the total stays a lower
 * bound, but a transient transport break before the first message must not
 * freeze a capped run — with the latch it would deny its own retries, which are
 * the very thing that would have produced a priced attempt.
 */
export function chargeAttemptToLedger(
  run: ChargedRun,
  budget: RunBudget,
  control: StepControl,
  usage: StepUsage | undefined,
  proof: { guardProvedUnpriced?: boolean } = {},
): void {
  budget.cumulative += control.total_cost_usd ?? 0;
  // A finalized run resumed into new work carries materialized totals from its
  // previous generation. They cease to be authoritative after any new attempt.
  invalidateRunTotals(run);
  if (isUnpricedSpend(control, usage) || proof.guardProvedUnpriced === true) {
    budget.costUnknown = true;
    // Latched on the run like `budget_exceeded`: a resume must reach the same stop
    // even if a later generation rewrites the totals this attempt contributed to.
    run.cost_unaccounted = true;
  }
}

export interface ChildReconciliation {
  parent: Run;
  /** Orchestration node the child hangs from; it carries the child's spend. */
  step: RunStep;
  /** The parent's record of what it has already charged for this child. */
  ref: PersistedPipelineChildRef;
  child: Run;
  budget: RunBudget;
  /** Cost the loop kept for a child whose own totals measured nothing. */
  fallbackCost: number;
}

/**
 * A composed child run reports an aggregated cost to its parent.
 *
 * The dedicated entry point for the one legitimate writer outside the attempt
 * path: the parent never saw this spend pass as attempts of its own, so nothing
 * in the attempt lifecycle can account for it. Charged BY DIFFERENCE — a resumed
 * child re-reports its whole history, and charging that twice would repay every
 * dollar and every token of the first pass.
 *
 * Returns the cost delta charged, and journals the reconciliation.
 */
export function chargeChildReconciliation(input: ChildReconciliation): number {
  const { parent, step, ref, child, budget } = input;
  const totalCost = Math.max(0, measuredRunCost(child, input.fallbackCost));
  const previousCost = Math.max(0, ref.accountedCostUsd ?? 0);
  const delta = Math.max(0, totalCost - previousCost);
  const totalDuration = Math.max(0, controlForRun(child).duration_ms);
  const previousDuration = Math.max(0, ref.accountedDurationMs ?? 0);
  const durationDelta = Math.max(0, totalDuration - previousDuration);
  // Tokens travel with the dollars. Accounting only `control` left the parent's
  // dollars including its children and its tokens excluding them, so every
  // per-token reading of an orchestrating pipeline was short by a whole subtree.
  const totalUsage = usageForRun(child);
  const gainedUsage = usageDelta(totalUsage, ref.accountedUsage);
  if (gainedUsage) step.usage = mergeUsage(step.usage, gainedUsage);
  // An unpriced attempt inside the child makes the charge here a lower bound
  // whatever the deltas are. A resumed child that re-reports history it was
  // already charged for posts a delta of zero and would otherwise take the flag
  // away with it — a run reading `$0.00` exact over spend nobody priced.
  const unknown = child.total_control?.cost_unknown === true || step.control?.cost_unknown === true;
  if (delta > 0 || durationDelta > 0) {
    step.control = {
      duration_ms: (step.control?.duration_ms ?? 0) + durationDelta,
      ...(step.control?.total_cost_usd !== undefined || delta > 0
        ? { total_cost_usd: (step.control?.total_cost_usd ?? 0) + delta }
        : {}),
      // No `model`: a child runs as many models as it has agent steps, and its
      // `total_control.model` is only the last one. Copied here it labelled the
      // whole subtree's spend with, say, the commit-message extractor's model.
      ...(child.total_control?.provider
        ? { provider: child.total_control.provider }
        : step.control?.provider
          ? { provider: step.control.provider }
          : {}),
      ...(child.total_control?.cost_estimated
        ? { cost_estimated: true }
        : step.control?.cost_estimated
          ? { cost_estimated: true }
          : {}),
      ...(unknown ? { cost_unknown: true } : {}),
    };
  } else if (!step.control) {
    step.control = { duration_ms: 0, total_cost_usd: 0, ...(unknown ? { cost_unknown: true } : {}) };
  } else if (unknown && step.control.cost_unknown !== true) {
    step.control = { ...step.control, cost_unknown: true };
  }
  ref.accountedCostUsd = Math.max(previousCost, totalCost);
  ref.accountedDurationMs = Math.max(previousDuration, totalDuration);
  if (totalUsage) ref.accountedUsage = totalUsage;
  // Same rule as an attempt reaching the ledger: the node total just moved, so a
  // total the parent materialized earlier no longer covers its steps.
  invalidateRunTotals(parent);
  appendRunEvent(parent, "pipeline.child.cost.reconciled", {
    parentNodeId: step.id,
    childRunId: ref.runId ?? null,
    childKey: ref.key,
    accountedCostUsd: ref.accountedCostUsd,
    deltaCostUsd: delta,
  });
  budget.cumulative += delta;
  // Composed spend counts like an attempt of the parent: a subtree that could not
  // price itself makes the parent's ledger a lower bound too, whatever the delta
  // was. Two proofs, either of which is enough: the reconciled figures show
  // unpriceable consumption (so a resumed child re-reporting its history cannot
  // lose the flag, and is not charged for it twice), or the child latched the
  // condition itself — its own attempts are the evidence, and a subtree deep
  // inside it may be where the tokens were spent.
  if (isUnpricedSpend(step.control, step.usage) || child.cost_unaccounted === true) {
    budget.costUnknown = true;
    // Latched on the parent snapshot too, so the stop survives a resume that
    // reconciles the child by delta and re-derives nothing from its attempts.
    parent.cost_unaccounted = true;
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Projections. Figures read back from the journal, never a new charge.
// ---------------------------------------------------------------------------

/**
 * Step spend to seed the budget ledger with: the snapshot total, unless the
 * journal knows of more.
 *
 * `finishAttempt` appends the finish event before it writes the snapshot. A hard
 * death in that window leaves an attempt priced in the journal but absent from
 * the step total, and the ledger — seeded from step totals — would then read that
 * attempt as free and let the resume spend past the ceiling. The journal is what
 * resume projects attempts from; when its cost sum exceeds the snapshot's, it is
 * the more complete record of what was spent, so the step total is rebuilt from it.
 *
 * A reprojection, not a charge: it rebuilds a total already accounted for and
 * returns it, so the caller decides what to do with it.
 */
export function projectStepSpend(
  state: PersistedStepState | undefined,
  attempts: PersistedAttempt[] | undefined,
): { control?: StepControl; usage?: StepUsage } {
  if (!attempts?.length) return { control: state?.control, usage: state?.usage };
  let control: StepControl | undefined;
  let usage: StepUsage | undefined;
  for (const attempt of attempts) {
    control = attempt.control ? mergeControl(control, attempt.control) : control;
    usage = mergeUsage(usage, attempt.usage);
  }
  if ((control?.total_cost_usd ?? 0) <= (state?.control?.total_cost_usd ?? 0)) {
    return { control: state?.control, usage: state?.usage };
  }
  return { control, usage: usage ?? state?.usage };
}

/**
 * Put back the figures a closed attempt already carried, as its
 * `step.attempt.finished` event recorded them.
 *
 * A projection and not a charge: the spend reached the step total and the ledger
 * when the attempt closed, so nothing is merged and no total moves. It lives here
 * so that every write of a spend figure is in this one file.
 */
export function restoreAttemptSpend(attempt: SpendFigures, control?: StepControl, usage?: StepUsage): void {
  if (control) attempt.control = control;
  if (usage) attempt.usage = usage;
}

/**
 * The run totals a resume may trust: those of a snapshot whose generation was
 * finalized and left nothing to execute (`terminal`). A live resume gets none and
 * derives them from the step totals through `controlForRun` / `usageForRun`: a
 * crash between an attempt snapshot and `finalizeRun` would otherwise hide the
 * spend of that attempt behind a total written before it.
 *
 * A projection like the two above: it restores or drops, it charges nothing. The
 * `terminal` decision itself belongs to `boot/resume.ts`, which knows whether the
 * definition leaves the snapshot executable work.
 */
export function restoreRunTotals(
  persisted: Pick<PersistedRun, "total_control" | "total_usage">,
  terminal: boolean,
): Pick<Run, "total_control" | "total_usage"> {
  if (!terminal) return { total_control: undefined, total_usage: undefined };
  return { total_control: persisted.total_control, total_usage: persisted.total_usage };
}
