import { type AgentStepBuilder, StepBuilder } from "./dsl-steps.js";
import type { ParallelizeOptions } from "./dsl-types.js";
import { requiredText } from "./dsl-utils.js";

/**
 * Mark agent steps as one group that runs side by side. The steps stay flat in the
 * pipeline: each keeps its status, attempts, log, session and cost, and the group is
 * only a mark on each of them. What a group may contain is checked when the pipeline
 * loads.
 */
export function parallelize(options: ParallelizeOptions): AgentStepBuilder[] {
  // Only what placing the mark needs. The rest belongs to `ParallelGroupValidator`,
  // which also sees raw definitions and the rework loops bound at pipeline build.
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("parallelize() expects an options object");
  }
  const group = { id: requiredText(options.id, "id"), name: requiredText(options.name, "name") };
  if (!Array.isArray(options.steps)) throw new Error(`Parallel group "${group.id}": steps must be an array`);
  return options.steps.map((step: unknown, index: number) => {
    if (!(step instanceof StepBuilder)) {
      throw new Error(`Parallel group "${group.id}": steps[${index}] must be a step built by llmStep`);
    }
    return step.parallelGroup(group) as AgentStepBuilder;
  });
}
