import { backendSpecForStep, isAgentStep } from "../contracts/backends.js";
import { pipelineSteps } from "./structure.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/** Verify that every agent step carries the DSL's implicit JSON verdict and that
 * its backend can produce it. Explicit `output_format` checking also protects
 * raw `Pipeline` definitions, which bypass builders and their defaults. */
export class AgentOutputContractValidator implements PipelineValidationRule {
  readonly id = "agent-output-contract";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const registry = backendRegistryOf(context);

    for (const step of pipelineSteps(context)) {
      if (!isAgentStep(step)) continue;
      if (step.output_format !== "json") {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": an agent step must use output_format "json" (implicit via llmStep)`,
        });
        continue;
      }

      const spec = backendSpecForStep(step);
      if (!spec || !registry.has(spec.id)) continue;
      try {
        const backend = registry.resolve(spec);
        if (!backend.capabilities.structuredOutput) {
          findings.push({
            rule: this.id,
            level: "error",
            message: `step "${step.id}": agent backend "${spec.id}" does not support structured JSON output`,
          });
        }
      } catch {
        // The agent-backend rule already reports an unresolvable backend.
      }
    }

    return findings;
  }
}
