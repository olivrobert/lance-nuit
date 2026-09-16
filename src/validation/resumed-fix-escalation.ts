import { backendSpecForStep } from "../contracts/backends.js";
import type { PipelineStep } from "../model/definition.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/**
 * A `bash` step repaired by resuming another step's session runs its fix on that
 * step's provider. `escalate.model` is a provider-specific name, written with the
 * default backend in mind; on another provider it would fail on the escalation rung.
 * Refuse the combination up front rather than discovering it two failed repairs later.
 */
export class ResumedFixEscalationValidator implements PipelineValidationRule {
  readonly id = "resumed-fix-escalation";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const registry = backendRegistryOf(context);
    const defaultId = registry.defaultBackendId();
    const steps = context.pipeline.steps;
    const findings: PipelineValidationFinding[] = [];
    for (const step of steps.filter(isResumedBashFixWithModelEscalation)) {
      const target = step.on_failure!.resume_session!;
      const targetStep = steps.find((candidate) => candidate.id === target);
      // A missing target is reported by `resume-session`; nothing to say about its provider.
      if (targetStep === undefined) continue;
      const backend = backendSpecForStep(targetStep)?.id ?? defaultId;
      if (backend === defaultId) continue;
      findings.push({
        rule: this.id,
        level: "error",
        message:
          `step "${step.id}": escalate.model "${step.on_failure!.escalate_model}" cannot apply: ` +
          `the repair resumes the session of "${target}" on ${backend}. ` +
          "Drop escalate.model or resumeSession.",
      });
    }
    return findings;
  }
}

function isResumedBashFixWithModelEscalation(step: PipelineStep): boolean {
  const failure = step.on_failure;
  return (
    failure !== undefined &&
    failure.resume_session !== undefined &&
    failure.escalate_model !== undefined &&
    backendSpecForStep(step) === undefined
  );
}
