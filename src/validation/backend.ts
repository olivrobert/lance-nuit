import { backendOptionAxes, backendSpecForStep, isAgentStep } from "../contracts/backends.js";
import { pipelineSteps } from "./structure.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/** Validate backend declaration and registration before any spawn. */
export class AgentBackendValidator implements PipelineValidationRule {
  readonly id = "agent-backend";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const registry = backendRegistryOf(context);

    for (const step of pipelineSteps(context)) {
      if ((step.runner === "agent" || step.backend) && !step.backend) {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": an agent step must declare its backend through the backend field`,
        });
      }
      if (isAgentStep(step) && !step.profile) {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": an agent step must declare its profile through the profile field`,
        });
      }
      if (!isAgentStep(step)) continue;

      const spec = backendSpecForStep(step);
      if (!spec) continue;
      const optionSources = [
        { label: "backend options", options: step.backend?.options },
        { label: "on_failure.backend_options", options: step.on_failure?.backend_options },
      ];
      for (const source of optionSources) {
        for (const axis of backendOptionAxes(source.options)) {
          findings.push({
            rule: this.id,
            level: "error",
            message:
              `step "${step.id}": ${axis} is not allowed in ${source.label} "${spec.id}"; ` +
              `utiliser profiles.${step.profile ?? "<role>"}.backends.${spec.id}.${axis}`,
          });
        }
      }
      if (!registry.has(spec.id)) {
        findings.push({
          rule: this.id,
          level: "error",
          message:
            `step "${step.id}": unknown agent backend "${spec.id}" ` +
            `(known: ${registry.known().join(", ") || "none"})`,
        });
      }
    }

    return findings;
  }
}
