import {
  type AgentBackend,
  type AgentBackendRegistry,
  type BackendSpec,
  backendForFix,
  backendOptionAxes,
  backendSpecForStep,
  isAgentStep,
} from "../../contracts/backends.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { isStepProfileName, type ProfileOverrides } from "../../shared/language/profiles.js";
import type { PipelineStep } from "../definition.js";
import { resolveProfileForBackend } from "../dsl/profiles.js";
import { pipelineSteps } from "./structure.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

type Resolution =
  | { kind: "unknown" }
  | { kind: "rejected"; message: string }
  | { kind: "resolved"; backend: AgentBackend };

function resolve(spec: BackendSpec, registry: AgentBackendRegistry): Resolution {
  if (!registry.has(spec.id)) return { kind: "unknown" };
  try {
    return { kind: "resolved", backend: registry.resolve(spec) };
  } catch (error) {
    return { kind: "rejected", message: errorMessage(error) };
  }
}

/** Why `role` cannot run on `backendId`, or undefined. */
function roleProblem(role: string, backendId: string, overrides: ProfileOverrides): string | undefined {
  if (!isStepProfileName(role)) return `unknown profile "${role}"`;
  if (resolveProfileForBackend(role, backendId, overrides) !== undefined) return undefined;
  return `profile "${role}" is not defined for backend "${backendId}"`;
}

/**
 * Verify that every role a step runs (its own, its fix pass's, its review's) has a
 * policy for the backend that runs it, so materialization cannot refuse a pipeline
 * the validator accepted.
 */
export class ProfileCoherenceValidator implements PipelineValidationRule {
  readonly id = "profile-coherence";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const registry = backendRegistryOf(context);
    return pipelineSteps(context).flatMap((step) =>
      [
        ...this.stepProblems(step, registry, context.profileOverrides),
        ...this.fixProblems(step, registry, context.profileOverrides),
        ...this.reviewProblems(step, registry, context.profileOverrides),
      ].map((message) => ({ rule: this.id, level: "error" as const, message: `step "${step.id}": ${message}` })),
    );
  }

  private stepProblems(step: PipelineStep, registry: AgentBackendRegistry, overrides: ProfileOverrides): string[] {
    const spec = backendSpecForStep(step);
    // A missing backend or profile, and an unknown backend, are the backend
    // validator's diagnostics; repeating them here would say nothing new.
    if (!isAgentStep(step) || !step.profile || !spec) return [];
    const resolution = resolve(spec, registry);
    if (resolution.kind === "unknown") return [];
    if (resolution.kind === "rejected") return [`backend "${spec.id}" rejects its options: ${resolution.message}`];
    const problem = roleProblem(step.profile, spec.id, overrides);
    if (problem === undefined) return [];
    return [
      isStepProfileName(step.profile)
        ? `${problem} (define profiles.${step.profile}.backends.${spec.id} or choose a compatible profile)`
        : problem,
    ];
  }

  /** A fix pass borrowing a role runs it on the step's backend, else on its
   *  `fixBackend` or the default one. An unknown `fixBackend` is the fix-backend
   *  validator's diagnostic. */
  private fixProblems(step: PipelineStep, registry: AgentBackendRegistry, overrides: ProfileOverrides): string[] {
    const role = step.on_failure?.fix_profile;
    if (!role || registry.known().length === 0) return [];
    const spec = backendForFix(step, registry);
    if (!registry.has(spec.id)) return [];
    const problem = roleProblem(role, spec.id, overrides);
    return problem === undefined ? [] : [`fix ${problem}`];
  }

  /** The review session runs its own role on its own backend, and its fix resumes
   *  the producing session: a step backend that cannot resume would always fix blind. */
  private reviewProblems(step: PipelineStep, registry: AgentBackendRegistry, overrides: ProfileOverrides): string[] {
    const review = step.review;
    if (!review) return [];
    const problems: string[] = [];
    const spec = backendSpecForStep(step);
    const stepBackend = spec ? resolve(spec, registry) : undefined;
    if (stepBackend?.kind === "resolved" && !stepBackend.backend.capabilities.resume) {
      problems.push(`review needs a backend that resumes sessions; "${spec!.id}" cannot`);
    }
    const forbiddenAxes = backendOptionAxes(review.backend.options);
    if (forbiddenAxes.length > 0) {
      problems.push(
        `review ${forbiddenAxes.join("/")} must come from ` +
          `profiles.${review.profile}.backends.${review.backend.id}, never from backend options`,
      );
    }
    const reviewBackend = resolve(review.backend, registry);
    if (reviewBackend.kind === "unknown") {
      problems.push(`unknown review backend "${review.backend.id}" (known: ${registry.known().join(", ") || "none"})`);
      return problems;
    }
    if (reviewBackend.kind === "rejected") {
      problems.push(`review backend "${review.backend.id}" rejects its options: ${reviewBackend.message}`);
      return problems;
    }
    const problem = roleProblem(review.profile, review.backend.id, overrides);
    if (problem !== undefined) problems.push(`review ${problem}`);
    return problems;
  }
}
