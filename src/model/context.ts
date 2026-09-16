// runner/model/context.ts
//
// Execution context handed to pipeline authors and the accessors of the
// registries a run attaches to it. Shapes only: assembling a context is
// `pipeline/context.ts`.

import type { AgentBackendRegistry } from "../contracts/backends.js";
import type { WorkItemGatewayRegistry } from "../contracts/registry.js";
import type { WorkItemGateway } from "../contracts/work-items.js";
import type { WorkItemArtifactStore } from "./artifact-ports.js";
import type { PipelineConfig } from "./config.js";

export interface PipelinePaths {
  /** Absolute directory of the current ticket or sub-work-item. */
  workItemDir?: string;
  /** Directory for business artifacts. */
  artifactsDir?: string;
  /** Directory for structured decisions. */
  decisionsDir?: string;
  /** Directory for timestamped reports (acceptance, constraints, e2e, screenshots, audit). */
  reportsDir?: string;
  /** Resolve an artifact under workItemDir, or fail clearly without a ticket. */
  artifact(name: string): string;
}

/** Functional scope passed to a batch execution sub-run. */
export interface PipelineLot {
  id: string;
  title: string;
  risk: number;
  steps: readonly number[];
  dependsOn: readonly string[];
  acceptanceCriteria: readonly string[];
}

/** Context available to a step's command/input functions. */
export interface PipelineContext {
  cwd: string;
  /** Raw ticket (e.g. PROJ-28-01). undefined when the runner has no ticket. */
  ticket?: string;
  /** Resolved ticket directory (for example PROJ-28-01 -> PROJ-28/US-01). Undefined without a ticket. */
  ticketDir?: string;
  /** Base branch passed through --base-branch. */
  baseBranch?: string;
  /** Current batch when a feature pipeline runs a bounded sub-run. */
  lot?: PipelineLot;
  /** Absolute path to runner.ts (process.argv[1]). */
  runnerBin: string;
  /** Directory containing runner.ts. */
  runnerDir: string;
  /** Normalized configuration, read once when the runner starts. */
  config: PipelineConfig;
  /** Paths derived from cwd, config.specPath, and ticketDir. */
  paths: PipelinePaths;
  /** Logical access to artifacts for the current ticket or sub-work-item. */
  readonly artifacts: WorkItemArtifactStore;
  /** Tracker control, resolved from `config.workItem.provider`.
   *
   *  LAZY access: the gateway is created only on the first `ctx.workItem` access
   *  and then memoized. The context is built on every runner path (and in dozens
   *  of tests), while only a handful of steps contact the tracker — instantiating
   *  an adapter for every construction would couple the entire engine to a
   *  provider for no reason. */
  readonly workItem: WorkItemGateway;
}

/** Enriched context available to fix_prompt functions. */
export interface FixContext extends PipelineContext {
  /** Complete output of the failed step. */
  stepOutput: string;
  /** Errors extracted through error_extractor (or truncated stepOutput). */
  errors: string;
  /** Path of the latest report written, when applicable. */
  reportPath?: string;
}

/** A value that can be literal or computed from context. */
export type Templated<TCtx, T = string> = T | ((ctx: TCtx) => T);

/** Same, but the computation may be `async`. Anything resolved by the runner
 *  BEFORE starting a step (command, preflight, fix prompt, loop ticket list) uses
 *  this form: these points are already asynchronous, and commands often need to
 *  read an artifact—`artifact.read()` is asynchronous. */
export type AsyncTemplated<TCtx, T = string> = T | ((ctx: TCtx) => T | Promise<T>);

/** In-process action for an `fn` step. Returns a readable log summary, or nothing
 *  when the action has no useful output. */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` lets actions simply not return instead of returning undefined explicitly
export type StepAction = (ctx: PipelineContext) => string | void | Promise<string | void>;

/**
 * Internal context dependencies. They are non-enumerable so project code does not
 * accidentally treat a registry as part of the author-facing context, while
 * deriveContext can still preserve them by copying property descriptors.
 */
export const WORK_ITEM_REGISTRY = Symbol("pipeline.workItemRegistry");
export const AGENT_BACKEND_REGISTRY = Symbol("pipeline.agentBackendRegistry");

function contextDependency<T>(context: PipelineContext, key: symbol): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(context, key);
  return descriptor && "value" in descriptor ? (descriptor.value as T) : undefined;
}

/** Read the registry attached to a context without forcing `ctx.workItem`. */
export function workItemRegistryOf(context: PipelineContext): WorkItemGatewayRegistry | undefined {
  return contextDependency<WorkItemGatewayRegistry>(context, WORK_ITEM_REGISTRY);
}

/** Read the backend registry attached to a context without importing providers. */
export function agentBackendRegistryOf(context: PipelineContext): AgentBackendRegistry | undefined {
  return contextDependency<AgentBackendRegistry>(context, AGENT_BACKEND_REGISTRY);
}

/**
 * Same, but for the callers that cannot run without one.
 *
 * Boot attaches the registry to the context it freezes, and every derivation
 * carries it. A context reaching an agent step without one is a composition bug
 * upstream, not a caller that should silently fall back to the built-in
 * providers: the fallback used to make a custom registry and the singleton two
 * sources of truth, with nothing failing when a caller landed on the wrong one.
 */
export function requireAgentBackendRegistry(context: PipelineContext): AgentBackendRegistry {
  const registry = agentBackendRegistryOf(context);
  if (!registry) {
    throw new Error("no agent backend registry attached to the pipeline context; boot must attach one");
  }
  return registry;
}
