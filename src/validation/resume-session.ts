import { backendSpecForStep } from "../contracts/backends.js";
import type { PipelineStep } from "../model/definition.js";
import type { PipelineValidationContext, PipelineValidationFinding, PipelineValidationRule } from "./types.js";

/**
 * `resumeSession: "<stepId>"` repairs inside the session recorded by an earlier agent
 * step. The target must exist, be another step, be an agent step (the only kind that
 * records a session) and run before the resuming step; otherwise the repair would
 * always fall back to a fresh session, a silently degraded policy. Refuse it at load
 * time.
 *
 * The runtime fallback in `chooseFixBackend` stays: a session can still be missing
 * for reasons this rule cannot see (a skipped target step, a non-resumable session).
 */
export class ResumeSessionValidator implements PipelineValidationRule {
  readonly id = "resume-session";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const steps = Array.isArray(context.pipeline.steps)
      ? context.pipeline.steps.filter((step): step is PipelineStep => !!step && typeof step === "object")
      : [];
    const findings: PipelineValidationFinding[] = [];
    steps.forEach((step, index) => {
      const target = step.on_failure?.resume_session;
      if (target === undefined) return;
      const problem = this.problemWith(step, target, index, steps);
      if (problem) {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": resumeSession "${target}": ${problem}`,
        });
      }
    });
    return findings;
  }

  private problemWith(step: PipelineStep, target: string, index: number, steps: PipelineStep[]): string | undefined {
    const targetIndex = steps.findIndex((candidate) => candidate.id === target);
    if (targetIndex === -1) return "no step with this id";
    if (target === step.id) return "cannot resume its own session";
    if (backendSpecForStep(steps[targetIndex]) === undefined) {
      return `step "${target}" is not an agent step, it has no session`;
    }
    if (targetIndex > index) return `step "${target}" runs after "${step.id}": its session does not exist yet`;
    return undefined;
  }
}
