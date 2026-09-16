// runner/state/stats/stats.ts
//
// Turning what a backend reported into the figures the runner stores, plus the
// difference arithmetic a by-difference charge needs. Nothing here writes: the
// totals themselves are owned by `state/cost-accounting.ts`, which is the only
// module that can add spend to a step, an attempt, or the run ledger.

import type { AttemptStats, StepControl, StepUsage } from "../../contracts/backends.js";

/** Tokens an attempt is known to have consumed. Zero means "measured nothing",
 *  which is why an exact $0 alongside it stays exact. */
function spentTokens(stats?: AttemptStats): number {
  return (
    (stats?.input_tokens ?? 0) +
    (stats?.output_tokens ?? 0) +
    (stats?.cache_read_tokens ?? 0) +
    (stats?.cache_creation_tokens ?? 0)
  );
}

/** Split an attempt before persisting it in resumable state. */
export function splitAttemptStats(stats?: AttemptStats): { control: StepControl; usage?: StepUsage } {
  // Tokens without a price mean an unaccounted spend, not a free attempt: flag it
  // here, where control and usage are still side by side.
  const metered = stats?.input_tokens != null || stats?.output_tokens != null || stats?.cache_read_tokens != null;
  const rawCost = stats?.total_cost_usd;
  const validCost = rawCost != null && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
  const invalidCost = rawCost != null && validCost == null;
  // An explicit flag from the attempt layer (agent killed before its first usage
  // event) counts like tokens: spend happened even though nothing measured it.
  const unaccounted = validCost == null && (metered || stats?.cost_unknown === true);
  // A reported $0 over consumed tokens is the same gap as a missing price, only
  // dressed as a measurement: a backend that cannot price a model writes zero.
  // Tokens alone do not establish a price, so the attempt is unknown rather than
  // free. Two zeros stay truthful and are excluded: an exact measured zero (no
  // tokens at all — a shell step, an agent that never called its provider) and a
  // zero a pricing table produced from explicit zero rates, which arrives here
  // already marked `cost_estimated`.
  const freeOverSpentTokens = validCost === 0 && spentTokens(stats) > 0 && stats?.cost_estimated !== true;
  // The flag also survives beside a price: a backend that sums the discarded
  // transport attempts under a final attempt it could not measure reports a lower
  // bound, the same shape a merged step total produces for a step mixing priced
  // and unpriced attempts.
  const explicit = stats?.cost_unknown === true;
  const control: StepControl = {
    duration_ms: stats?.duration_ms ?? 0,
    total_cost_usd: validCost,
    cost_estimated: stats?.cost_estimated,
    ...(unaccounted || invalidCost || explicit || freeOverSpentTokens ? { cost_unknown: true } : {}),
    model: stats?.model,
    last_turn_context_tokens: stats?.last_turn_context_tokens,
    context_window: stats?.context_window,
  };
  if (stats?.provider != null) control.provider = stats.provider;
  const usage: StepUsage = {
    duration_api_ms: stats?.duration_api_ms,
    num_turns: stats?.num_turns,
    input_tokens: stats?.input_tokens,
    output_tokens: stats?.output_tokens,
    cache_read_tokens: stats?.cache_read_tokens,
    cache_creation_tokens: stats?.cache_creation_tokens,
    tools_used: stats?.tools_used,
  };
  if (stats?.reasoning_tokens != null) usage.reasoning_tokens = stats.reasoning_tokens;
  return {
    control,
    ...(Object.values(usage).some((value) => value != null && (!Array.isArray(value) || value.length > 0))
      ? { usage }
      : {}),
  };
}

const NUMERIC_USAGE_FIELDS = [
  "duration_api_ms",
  "num_turns",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
] as const;

/**
 * Usage a cumulative total has gained since it was last accounted for.
 *
 * Child usage is reconciled by difference, exactly like child cost: a resumed
 * child reports its whole history again, and charging that history a second time
 * would double every token of the first pass. Counters only grow, so a negative
 * difference means the child restarted its own counting; clamp it to zero rather
 * than subtracting from the parent.
 */
export function usageDelta(total?: StepUsage, accounted?: StepUsage): StepUsage | undefined {
  if (!total) return undefined;
  if (!accounted) return total;
  const delta: StepUsage = {};
  for (const field of NUMERIC_USAGE_FIELDS) {
    const gained = Math.max(0, (total[field] ?? 0) - (accounted[field] ?? 0));
    if (gained > 0) delta[field] = gained;
  }
  // Tool names are a set, not a counter: merging is already idempotent.
  if (total.tools_used?.length) delta.tools_used = [...total.tools_used];
  return Object.values(delta).some((value) => value != null && (!Array.isArray(value) || value.length > 0))
    ? delta
    : undefined;
}
