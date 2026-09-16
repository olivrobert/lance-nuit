import type { BackendSpec } from "../contracts/backends.js";

/** A provider-neutral extension bag for an adapter or authoring tool. */
export type ExtensionOptions = Readonly<Record<string, unknown>>;

/** Construct a backend selection without coupling authoring to an adapter. */
export function backend(id: string, options?: unknown): BackendSpec {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("SDK backend id must be non-empty");
  return options === undefined ? { id: normalizedId } : { id: normalizedId, options };
}

/** Identity helpers preserve the host DSL's inferred authoring types. */
export function definePipeline<T>(factory: T): T {
  return factory;
}

export function defineStep<T>(step: T): T {
  return step;
}

export interface AuthoringStep<T = unknown> {
  readonly kind: string;
  readonly options: T;
}

export interface StepOptionsBase {
  readonly id: string;
  readonly name: string;
  readonly when?: unknown;
  readonly require?: unknown;
  readonly input?: readonly unknown[];
  readonly output?: readonly unknown[];
  readonly report?: string | readonly string[];
  readonly timeout?: number;
  readonly blocking?: boolean;
  readonly rerunOnResume?: boolean;
  readonly onFail?: OnFailPolicy;
}

export type OnFailPolicy =
  | { readonly retries: number; readonly escalate?: unknown; readonly fix?: never; readonly resumeSession?: never }
  | {
      readonly fix: unknown;
      readonly resumeSession?: string;
      readonly retries?: number;
      readonly escalate?: unknown;
    };

/** Provider-specific options remain opaque and extensible to the host. */
export interface LlmStepOptions extends StepOptionsBase {
  readonly profile?: string;
  readonly backend: string | BackendSpec;
  readonly options?: unknown;
  readonly prompt?: string;
  readonly command?: unknown;
  /** Captured verdict fields, persisted as artifacts by the runner. */
  readonly capture?: Readonly<Record<string, unknown>>;
}

export interface BashStepOptions extends StepOptionsBase {
  readonly command: unknown;
}

export interface ActionStepOptions extends StepOptionsBase {
  readonly run: unknown;
  readonly describe?: unknown;
}

export interface AuthoringContext {
  readonly cwd?: string;
  readonly runnerDir?: string;
  readonly workItem?: unknown;
  readonly config?: ExtensionOptions;
}

export type PipelineFactory<TDsl = unknown, TPipeline = unknown> = (dsl: TDsl) => TPipeline;

export type {
  AgentBackend,
  AgentBackendFactory,
  AgentCapabilities,
  AgentConfigAxis,
  AgentEscalation,
  AgentEscalationRung,
  AgentIntent,
  AgentRequest,
  AgentResult,
  AgentSession,
  AgentUsageAccounting,
  AttemptStats,
  BackendSpec,
  EffortLevel,
  ModelPricing,
  RunnerResult,
  StepControl,
  StepFailKind,
  StepUsage,
} from "../contracts/backends.js";
export {
  AgentBackendRegistry,
  backendForFix,
  backendOptionAxes,
  backendSpecForStep,
  declaredBackendAxes,
  isAgentStep,
} from "../contracts/backends.js";

export type {
  AutomationQueue,
  RefValidation,
  WorkItem,
  WorkItemGateway,
  WorkItemNote,
  WorkItemNoteField,
  WorkItemRef,
  WorkItemState,
  WorkQueue,
} from "../contracts/work-items.js";
