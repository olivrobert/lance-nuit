import { backendSpecForStep, isAgentStep } from "../contracts/backends.js";
import { resolveProfileForBackend } from "../dsl/profiles.js";
import { isStepProfileName } from "../model/profiles.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/** Verify that a role has a policy for the actually selected backend. */
export class ProfileCoherenceValidator implements PipelineValidationRule {
  readonly id = "profile-coherence";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const registry = backendRegistryOf(context);

    for (const step of context.pipeline.steps) {
      if (!isAgentStep(step) || !step.profile) continue;

      const spec = backendSpecForStep(step);
      // Missing backend is the structural validator's invariant. Do not
      // would produce a duplicate here; this rule stays focused on role coherence.
      if (!spec) continue;
      // The backend validator owns the canonical unknown-backend diagnostic; avoid
      // duplicating it with a false profile incompatibility.
      if (!registry.has(spec.id)) continue;

      if (!isStepProfileName(step.profile)) {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": unknown profile "${step.profile}"`,
        });
        continue;
      }

      if (resolveProfileForBackend(step.profile, spec.id, context.profileOverrides) !== undefined) continue;

      findings.push({
        rule: this.id,
        level: "error",
        message:
          `step "${step.id}": profile "${step.profile}" is not defined for backend "${spec.id}" ` +
          `(define profiles.${step.profile}.backends.${spec.id} or choose a compatible profile)`,
      });
    }

    return findings;
  }
}
