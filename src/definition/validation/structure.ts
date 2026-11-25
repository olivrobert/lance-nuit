import { isLogicalSegment } from "../../shared/language/artifact-ports.js";
import {
  ignoringErrors,
  type Pipeline,
  type PipelineStep,
  producerConflicts,
  stepsWithoutDeliverable,
  withoutDeliverableMessage,
} from "../definition.js";
import { pipelineBudgetErrors, reworkErrors, stepShapeErrors } from "../step-shape.js";
import type { PipelineValidationContext, PipelineValidationFinding, PipelineValidationRule } from "./types.js";

function stepId(step: PipelineStep): string {
  return typeof step.id === "string" && step.id ? step.id : "?";
}

/** Shape rules that depend on neither a backend nor configuration. The rules that
 *  follow it read steps it has vouched for, so the chain stops when it fails. */
export class PipelineStructureValidator implements PipelineValidationRule {
  readonly id = "pipeline-structure";

  readonly haltsOnError = true;

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    return this.messages(context.pipeline).map((message) => ({ rule: this.id, level: "error", message }));
  }

  private messages(pipeline: Pipeline): string[] {
    const header = headerErrors(pipeline);
    if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) return header;
    const malformed = pipeline.steps.flatMap((step, index) =>
      step && typeof step === "object" ? [] : [`steps[${index}] must be a step object`],
    );
    if (malformed.length > 0) return [...header, ...malformed];
    return [
      ...header,
      ...pipelineBudgetErrors(pipeline),
      ...crossStepErrors(pipeline),
      ...pipeline.steps.flatMap((step) => stepShapeErrors(step).map((error) => `step "${stepId(step)}": ${error}`)),
    ];
  }
}

function headerErrors(pipeline: Pipeline): string[] {
  const errors: string[] = [];
  if (!pipeline.name || typeof pipeline.name !== "string") errors.push('missing "name" field');
  else if (!isLogicalSegment(pipeline.name)) errors.push("pipeline name must be a non-empty safe logical value");
  if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) errors.push('"steps" must be a non-empty array');
  return errors;
}

function crossStepErrors(pipeline: Pipeline): string[] {
  const errors: string[] = [];
  const unclassified = stepsWithoutDeliverable(pipeline);
  if (unclassified.length > 0) errors.push(withoutDeliverableMessage(unclassified));
  errors.push(...producerConflicts(pipeline), ...ignoringErrors(pipeline), ...reworkErrors(pipeline));
  const seenIds = new Set<string>();
  for (const step of pipeline.steps) {
    if (typeof step.id !== "string") continue;
    if (seenIds.has(step.id)) errors.push(`duplicate id "${step.id}"`);
    seenIds.add(step.id);
  }
  return errors;
}

/** The one reading of a definition's steps for every rule. Behind the chain the
 *  structure rule has vouched for them; a rule run alone still gets objects only. */
export function pipelineSteps(context: PipelineValidationContext): PipelineStep[] {
  return Array.isArray(context.pipeline.steps)
    ? context.pipeline.steps.filter((step): step is PipelineStep => !!step && typeof step === "object")
    : [];
}
