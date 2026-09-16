import type { AgentBackendRegistry } from "../contracts/backends.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import type { ProfileOverrides, StepOverride } from "../model/profiles.js";

export type PipelineValidationLevel = "error" | "warning";

export interface PipelineValidationFinding {
  readonly rule: string;
  readonly level: PipelineValidationLevel;
  readonly message: string;
}

/** Data shared by consistency rules for a definition. */
export interface PipelineValidationContext {
  readonly source: string;
  readonly pipeline: Pipeline;
  readonly profileOverrides: ProfileOverrides;
  /** Configuration overrides to validate before materialization. */
  readonly stepOverrides?: Readonly<Record<string, StepOverride>>;
  /** Context required by rules that inspect capabilities. */
  readonly pipelineContext?: PipelineContext;
  /** Source shown in configuration error messages. */
  readonly stepOverrideSource?: string;
  /** Extractor registry injectable for contract tests. */
  readonly availableExtractors?: ReadonlySet<string>;
}

/** The registry selected by boot. Validating a pipeline is validating it against
 * the backends the run will actually use, so the caller must supply the context
 * that carries them; there is no built-in registry to fall back on. */
export function backendRegistryOf(context: PipelineValidationContext): AgentBackendRegistry {
  if (!context.pipelineContext) {
    throw new Error(
      `Validation (${context.source}): a pipeline context carrying the agent backend registry is required`,
    );
  }
  return requireAgentBackendRegistry(context.pipelineContext);
}

export interface PipelineValidationRule {
  readonly id: string;
  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[];
}
