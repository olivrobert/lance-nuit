// runtime/live-cost.ts
//
// Last cost estimate of the attempt currently executing, published by backend
// execution loops as usage ticks arrive. The SIGINT abort path reads it so the
// spend of a killed attempt still reaches the persisted budget ledger — without
// it, a run repeatedly interrupted mid-attempt can exceed max_cost_usd while
// the ledger stays under the ceiling.

let currentAttemptCostUsd: number | undefined;

/** Publish the running cost estimate of the in-flight attempt. */
export function reportLiveAttemptCost(costUsd: number | undefined): void {
  currentAttemptCostUsd = costUsd;
}

export function clearLiveAttemptCost(): void {
  currentAttemptCostUsd = undefined;
}

/** Read the last published estimate; undefined when no attempt is in flight. */
export function liveAttemptCost(): number | undefined {
  return currentAttemptCostUsd;
}
