//
// Import a pipeline file and build its definition with the project DSL.

import { dirname, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { humanReview } from "../builtin-steps/lib/human-review.js";
import { createPromptFile } from "../builtin-steps/lib/project-prompt.js";
import { requireCapabilitiesStep } from "../builtin-steps/lib/skill-preflight.js";
import { workItemDeliveryStep, workItemEscalateStep } from "../builtin-steps/lib/work-item-steps.js";
import { reject } from "../dsl/preconditions.js";
import {
  createProjectActionStep,
  artifact,
  createProjectBashStep,
  createProjectLlmStep,
  type Dsl,
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  forEachPipeline,
  mechanicalFix,
  parallelize,
  type PipelineFactory,
  pipeline as pipelineBuilder,
  requireArtifact,
  runPipeline,
  skip,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  source,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
  textArtifact,
  withBackend,
} from "../dsl.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import type { Pipeline } from "../definition.js";
import { decisionMatchesArtifact, pendingRejection } from "../../work-items/index.js";
import { materializePipeline } from "../materialize/materialize.js";
import { validatePipeline } from "../validation/pipeline.js";
import { buildPipelineContext } from "./context.js";

/**
 * Build the facade injected into a project factory.
 *
 * Load-dependent helpers are bound here, so two imported pipelines cannot share
 * contract context or prompt resolution roots.
 */
export function createProjectDsl(context: PipelineContext, pipelineDir: string): Dsl {
  const backendRegistry = requireAgentBackendRegistry(context);
  return {
    pipeline: pipelineBuilder,
    runPipeline,
    forEachPipeline,
    parallelize,
    llmStep: createProjectLlmStep(pipelineDir, backendRegistry),
    withBackend: (id, options) => withBackend(id, options, backendRegistry),
    bashStep: createProjectBashStep(backendRegistry),
    actionStep: createProjectActionStep(backendRegistry),
    workItemEscalateStep,
    humanReview,
    workItemDeliveryStep,
    requireCapabilitiesStep,
    promptFile: createPromptFile(pipelineDir),
    artifact,
    textArtifact,
    source,
    skip,
    fail,
    stop,
    skipIf,
    skipUnless,
    failIf,
    failUnless,
    failUnlessCommand,
    stopIf,
    stopUnless,
    stopUnlessCommand,
    requireArtifact,
    skipUnlessCommand,
    mechanicalFix,
    reject,
    decisionMatchesArtifact,
    pendingRejection,
  };
}

/** Import a .ts pipeline factory and build its definition, with nothing validated
 *  nor applied: what the author wrote. */
export async function buildPipelineDefinition(pipelinePath: string, context?: PipelineContext): Promise<Pipeline> {
  const abs = pathResolve(pipelinePath);
  const mod = await import(pathToFileURL(abs).href);
  if (mod.default === undefined) {
    throw new Error(`Invalid pipeline (${pipelinePath}): missing default export`);
  }
  if (typeof mod.default !== "function") {
    throw new Error(`Invalid pipeline (${pipelinePath}): default export must be a factory (dsl, context) => Pipeline`);
  }
  const buildContext = context ?? buildPipelineContext();
  return (mod.default as PipelineFactory)(createProjectDsl(buildContext, dirname(abs)), buildContext);
}

/** Build a pipeline, validate it with its configuration, then materialize its
 *  model/effort. Validation comes first: every refusal is reported before a step
 *  is written, and none is left to materialization. */
export async function loadPipelineDefinition(pipelinePath: string, context?: PipelineContext): Promise<Pipeline> {
  const buildContext = context ?? buildPipelineContext();
  const pipeline = await buildPipelineDefinition(pipelinePath, buildContext);
  const configuration = {
    profileOverrides: buildContext.config.profiles,
    stepOverrides: buildContext.config.steps,
  };
  validatePipeline(pipeline, pipelinePath, { ...configuration, context: buildContext });
  materializePipeline(pipeline, { ...configuration, context: buildContext });
  return pipeline;
}
