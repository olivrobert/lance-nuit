// runtime/live-cost.ts
//
// Last cost estimate of the attempt currently executing, published by backend
// execution loops as usage ticks arrive. The SIGINT abort path reads it so the
// spend of a killed attempt still reaches the persisted budget ledger — without
// it, a run repeatedly interrupted mid-attempt can exceed max_cost_usd while
// the ledger stays under the ceiling. The model travels with it: a step whose
// only agent work is a killed fix pass has no other record of what it ran on,
// and its spend would be attributed to no model.

let currentAttemptCostUsd: number | undefined;
let currentAttemptModel: string | undefined;

/** Publish the running cost estimate of the in-flight attempt. */
export function reportLiveAttemptCost(costUsd: number | undefined, model?: string): void {
  currentAttemptCostUsd = costUsd;
  if (model) currentAttemptModel = model;
}

export function clearLiveAttemptCost(): void {
  currentAttemptCostUsd = undefined;
  currentAttemptModel = undefined;
}

/** Read the last published estimate; undefined when no attempt is in flight. */
export function liveAttemptCost(): number | undefined {
  return currentAttemptCostUsd;
}

/** The model the in-flight attempt reported running on, if it named one. */
export function liveAttemptModel(): string | undefined {
  return currentAttemptModel;
}
