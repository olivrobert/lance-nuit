import type { AsyncTemplated, PipelineContext } from "../model/context.js";
import type { PipelineInvocationDefinition, PipelineOrchestrationDefinition } from "../model/definition.js";
import { PipelineOrchestrationStepBuilder } from "./dsl-orchestration-step.js";
import type { ForEachPipelineOptions, PipelineAfterOptions, RunPipelineOptions } from "./dsl-types.js";
import { requiredText } from "./dsl-utils.js";
import { freezeOnStart, type InputPredicate, normalizeWhen, type When } from "./input.js";

function validatePipelinePredicate(value: unknown, field: string): InputPredicate | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new Error(`Pipeline composition: ${field} must be a function`);
  return value as InputPredicate;
}

function validatePipelineTicket(
  value: unknown,
  field: string,
): AsyncTemplated<PipelineContext, string | undefined> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "function") {
    throw new Error(`Pipeline composition: ${field} must be a string or function`);
  }
  return value as AsyncTemplated<PipelineContext, string | undefined>;
}

function normalizePipelineAfter(
  value: PipelineAfterOptions | undefined,
  field: string,
): PipelineInvocationDefinition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pipeline composition: ${field} must be an object`);
  }
  const ticket = validatePipelineTicket(value.ticket, `${field}.ticket`);
  const when = validatePipelinePredicate(value.when, `${field}.when`);
  return {
    pipeline: requiredText(value.pipeline, `${field}.pipeline`),
    ...(ticket !== undefined ? { ticket } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

function normalizeRunPipelineOptions(options: RunPipelineOptions): PipelineOrchestrationDefinition {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("runPipeline() expects an options object");
  }
  const ticket = validatePipelineTicket(options.ticket, "ticket");
  return {
    kind: "runPipeline",
    pipeline: requiredText(options.pipeline, "pipeline"),
    ...(ticket !== undefined ? { ticket } : {}),
  };
}

function normalizeForEachPipelineOptions(options: ForEachPipelineOptions): PipelineOrchestrationDefinition {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("forEachPipeline() expects an options object");
  }
  const items = options.items;
  if (typeof items !== "function" && (!Array.isArray(items) || !items.every((item) => typeof item === "string"))) {
    throw new Error("forEachPipeline().items must be a ticket list or function");
  }
  if (options.lot !== undefined && typeof options.lot !== "function") {
    throw new Error("forEachPipeline().lot must be a function");
  }
  const afterEach = normalizePipelineAfter(options.afterEach, "afterEach");
  const afterAll = normalizePipelineAfter(options.afterAll, "afterAll");
  const ticket = validatePipelineTicket(options.ticket, "ticket");
  return {
    kind: "forEachPipeline",
    items: items as AsyncTemplated<PipelineContext, readonly string[]>,
    ...(ticket !== undefined ? { ticket } : {}),
    ...(options.lot !== undefined ? { lot: options.lot } : {}),
    pipeline: requiredText(options.pipeline, "pipeline"),
    ...(afterEach ? { afterEach } : {}),
    ...(afterAll ? { afterAll } : {}),
  };
}

function buildOrchestrationStep(
  id: string,
  name: string,
  orchestration: PipelineOrchestrationDefinition,
  when: When | readonly When[] | undefined,
): PipelineOrchestrationStepBuilder {
  const builder = new PipelineOrchestrationStepBuilder(id, name, orchestration);
  const admissions = normalizeWhen(when).map(freezeOnStart);
  return admissions.length > 0 ? builder.applyInputs(...admissions) : builder;
}

export function runPipeline(options: RunPipelineOptions): PipelineOrchestrationStepBuilder {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("runPipeline() expects an options object");
  }
  return buildOrchestrationStep(
    requiredText(options.id, "id"),
    requiredText(options.name, "name"),
    normalizeRunPipelineOptions(options),
    options.when,
  );
}

export function forEachPipeline(options: ForEachPipelineOptions): PipelineOrchestrationStepBuilder {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("forEachPipeline() expects an options object");
  }
  return buildOrchestrationStep(
    requiredText(options.id, "id"),
    requiredText(options.name, "name"),
    normalizeForEachPipelineOptions(options),
    options.when,
  );
}
