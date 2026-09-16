import { backendSpecForStep } from "../contracts/backends.js";
import type { PipelineStep } from "../model/definition.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/**
 * `fixBackend` names the provider that repairs a step without a backend of its own,
 * in a fresh session. Two combinations are refused up front: an unknown provider,
 * which would only fail at the first repair, and `resumeSession`, where the repair
 * must land on the resumed session's provider because a session cannot be injected
 * into another backend.
 */
export class FixBackendValidator implements PipelineValidationRule {
  readonly id = "fix-backend";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const registry = backendRegistryOf(context);
    const findings: PipelineValidationFinding[] = [];
    for (const step of context.pipeline.steps) {
      const fixBackend = step.on_failure?.fix_backend;
      if (fixBackend === undefined) continue;
      if (backendSpecForStep(step)) {
        findings.push(this.error(step, "fixBackend applies only to a step without a backend"));
        continue;
      }
      if (!registry.has(fixBackend)) {
        findings.push(
          this.error(
            step,
            `fixBackend "${fixBackend}" is not a registered backend (known: ${registry.known().join(", ")})`,
          ),
        );
      }
      if (step.on_failure!.resume_session !== undefined) {
        findings.push(
          this.error(
            step,
            `fixBackend "${fixBackend}" cannot apply with resumeSession: ` +
              "the repair lands on the resumed session's provider. " +
              "Drop fixBackend or resumeSession.",
          ),
        );
      }
    }
    return findings;
  }

  private error(step: PipelineStep, message: string): PipelineValidationFinding {
    return { rule: this.id, level: "error", message: `step "${step.id}": ${message}` };
  }
}
