//
// Import a pipeline file and build its definition with the project DSL.

import { dirname, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineFactory } from "../dsl.js";
import { createProjectDsl } from "../project/create-project-dsl.js";
import type { PipelineContext } from "../../shared/language/context.js";
import type { Pipeline } from "../definition.js";
import { materializePipeline } from "../materialize/materialize.js";
import { validatePipeline } from "../validation/pipeline.js";
import { buildPipelineContext } from "./context.js";

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
