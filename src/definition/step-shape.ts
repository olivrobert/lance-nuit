/** Shape rules of a definition, each written once. The builders throw the first
 *  one when a step or pipeline is built; the structure validator reports them all,
 *  for raw definitions that never met a builder. */
import type { JsonSchema } from "../contracts/backends.js";
import { VERDICT_FIELD_NAMES } from "../contracts/verdict.js";
import { isLogicalSegment } from "../shared/language/artifact-ports.js";
import { isEffort } from "../shared/language/profiles.js";
import { sourceDeclarationError } from "../work-items/index.js";
import {
  onStaleDeclarationError,
  type Pipeline,
  type PipelineStep,
  reviewDeclarationError,
  STEP_RUNNERS,
} from "./definition.js";

const OUTPUT_FORMATS = ["text", "json"] as const;

export function stepShapeErrors(step: PipelineStep): string[] {
  return [
    ...identityErrors(step),
    ...runnerErrors(step),
    ...declarationErrors(step),
    ...captureErrors(step),
    ...failureErrors(step),
  ];
}

function identityErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  if (!isLogicalSegment(step.id)) errors.push("id must be a non-empty safe logical value");
  if (typeof step.name !== "string" || !step.name.trim()) errors.push("name is required");
  return errors;
}

function runnerErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  if (step.runner != null && !(STEP_RUNNERS as readonly string[]).includes(step.runner)) {
    errors.push(`unknown runner "${step.runner}" (expected: ${STEP_RUNNERS.join(", ")})`);
  }
  const commandMissing = step.command == null || (typeof step.command === "string" && !step.command.trim());
  if (step.runner !== "pipeline" && commandMissing) {
    errors.push(step.runner === "fn" ? ".describe() is required" : ".command() is required");
  }
  if (step.runner === "fn" && typeof step.action !== "function") errors.push(".run() is required");
  if (step.runner === "pipeline" && (!step.orchestration || typeof step.orchestration !== "object")) {
    errors.push('runner "pipeline" requires an orchestration definition');
  }
  if (step.runner !== "pipeline" && step.orchestration) errors.push('orchestration is reserved for runner "pipeline"');
  // Orchestration options do not extend the step options base, so an untyped
  // JavaScript pipeline is the only way `input` can reach a composition node.
  if (step.runner === "pipeline" && step.sources) errors.push('input is not supported by runner "pipeline"');
  if (step.backend && step.runner != null && step.runner !== "agent") {
    errors.push("an agent backend can only be used with runner agent");
  }
  if (step.output_format != null && !(OUTPUT_FORMATS as readonly string[]).includes(step.output_format)) {
    errors.push(`unknown output_format "${step.output_format}" (expected: ${OUTPUT_FORMATS.join(", ")})`);
  }
  return errors;
}

function declarationErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  // A step replayed on every invocation has no stamp to compare its inputs to.
  if (step.sources?.length && step.rerun_on_resume) errors.push("rerunOnResume cannot be combined with input");
  for (const error of [reviewDeclarationError(step), onStaleDeclarationError(step), sourceDeclarationError(step)]) {
    if (error) errors.push(error);
  }
  return errors;
}

function captureErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  const captures = step.captures ?? [];
  if (!Array.isArray(captures)) return ["captures must be an array"];
  // A capture reads the agent's structured output; only an agent step has one.
  if (captures.length > 0 && step.runner !== "agent") errors.push("capture applies only to an agent step (llmStep)");
  const seenFields = new Set<string>();
  const seenArtifacts = new Set<string>();
  for (const capture of captures) {
    const field = typeof capture?.field === "string" ? capture.field : "";
    if (!field.trim()) {
      errors.push("capture field names must be non-empty");
      continue;
    }
    // A capture named after a verdict field would overwrite that field's type in
    // the verdict schema and break the contract in silence.
    if ((VERDICT_FIELD_NAMES as readonly string[]).includes(field)) {
      errors.push(`capture "${field}" is reserved by the verdict contract (${VERDICT_FIELD_NAMES.join(", ")})`);
    }
    if (seenFields.has(field)) errors.push(`capture "${field}" is declared twice`);
    seenFields.add(field);
    const artifactName = capture.artifact?.name;
    if (typeof artifactName !== "string" || !artifactName) {
      errors.push(`capture "${field}" needs an artifact`);
    } else if (seenArtifacts.has(artifactName)) {
      errors.push(`capture "${field}" targets artifact "${artifactName}" already captured by another field`);
    } else {
      seenArtifacts.add(artifactName);
    }
    const schemaError = strictSchemaError(capture.schema, `capture "${field}".schema`);
    if (schemaError) errors.push(schemaError);
  }
  if (step.review?.capture) {
    const schemaError = strictSchemaError(step.review.capture.schema, "review capture.schema");
    if (schemaError) errors.push(schemaError);
  }
  return errors;
}

function failureErrors(step: PipelineStep): string[] {
  const failure = step.on_failure;
  if (failure === undefined) return [];
  if (!failure || typeof failure !== "object") return ["onFail must be an object"];
  const errors: string[] = [];
  const retries = failure.max_retries;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0) {
    errors.push("onFail.retries must be an integer >= 0");
  }
  if (failure.fix_prompt === undefined) {
    if (failure.resume_session !== undefined) errors.push("onFail.resumeSession requires fix");
    if (failure.stop_if_unchanged !== undefined) errors.push("onFail.stopIfUnchanged requires fix");
  } else if (retries === 0) {
    // A fix policy that never loops would fail the step without ever repairing it.
    errors.push("onFail.retries must be >= 1 when fix is set");
  }
  // An agent step is repaired by its own backend: a second one would be ignored.
  if (step.backend && failure.fix_backend !== undefined) {
    errors.push("fixBackend applies only to a step without a backend (bashStep, actionStep)");
  }
  // The gate reads the extraction result; without an extractor there is none.
  if (failure.fix_only_when_extracted && !step.error_extractor) {
    errors.push("fixOnlyWhenExtracted requires errorExtractor");
  }
  if (failure.replay_after_fix === false) errors.push(...unverifiedRepairErrors(step));
  errors.push(...escalationErrors(step));
  return errors;
}

/** Without the replay, nothing checks the repair: letting it open a blocking gate
 *  would ship an unverified fix, and a second repair would work blind on the first. */
function unverifiedRepairErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  if (step.blocking !== false) errors.push("replayAfterFix: false requires blocking: false");
  if (step.on_failure?.max_retries !== 1) errors.push("replayAfterFix: false requires retries: 1");
  // The option decides whether to skip the replay; without one it has nothing to skip.
  if (step.on_failure?.stop_if_unchanged) {
    errors.push("stopIfUnchanged cannot be combined with replayAfterFix: false");
  }
  // A pass that settles on an unverified repair is never stamped over outputs.
  if (step.outputs?.length) errors.push("replayAfterFix: false requires a step without output; use llmStep review");
  return errors;
}

function escalationErrors(step: PipelineStep): string[] {
  const errors: string[] = [];
  const { escalate_model: model, escalate_effort: effort, escalate_after: after } = step.on_failure ?? {};
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    errors.push("escalate.model must be a non-empty string");
  }
  if (effort !== undefined && !isEffort(effort))
    errors.push(`escalate.effort is invalid (received: ${String(effort)})`);
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
    errors.push(`escalate.after must be a non-negative integer (received: ${String(after)})`);
  }
  return errors;
}

/** Keywords the guard cannot see through. A combinator or a reference may carry an
 *  object node that breaks the strict-mode rules, and `$ref` cannot be checked
 *  without resolving it; refusing them outright is honest about what the guard
 *  proves, while letting them pass would move the 400 to the first spawn. */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "$defs",
  "definitions",
  "patternProperties",
] as const;

/**
 * Strict-mode compatibility of a captured field's schema, the invariant the
 * providers enforce on the whole verdict schema: on every object node, `required`
 * lists exactly the declared properties and `additionalProperties` is `false`. A
 * schema refused here would otherwise be refused by the provider with a 400 at
 * the first spawn, far from the declaration.
 */
export function strictSchemaError(schema: unknown, where: string): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${where} must be a schema object`;
  const node = schema as JsonSchema;
  const unsupported = UNSUPPORTED_SCHEMA_KEYWORDS.filter((keyword) => node[keyword] !== undefined);
  if (unsupported.length > 0) {
    return `${where}: ${unsupported.join(", ")} ${unsupported.length > 1 ? "are" : "is"} not supported by capture schemas (allowed: type, properties, required, additionalProperties, items, enum, description)`;
  }
  if (node.type === "object" || node.properties !== undefined) {
    const objectError = strictObjectError(node, where);
    if (objectError) return objectError;
  }
  if (node.items === undefined) return undefined;
  const items = Array.isArray(node.items) ? (node.items as readonly unknown[]) : [node.items];
  for (const item of items) {
    const itemError = strictSchemaError(item, `${where}[]`);
    if (itemError) return itemError;
  }
  return undefined;
}

function strictObjectError(node: JsonSchema, where: string): string | undefined {
  const declared = node.properties ?? {};
  if (typeof declared !== "object" || Array.isArray(declared)) return `${where}.properties must be an object`;
  const properties = Object.keys(declared).sort();
  const required = (Array.isArray(node.required) ? [...node.required] : []).sort();
  if (properties.join("\0") !== required.join("\0")) {
    return `${where}: schema.required must list every property (properties: ${properties.join(", ") || "none"}; required: ${required.join(", ") || "none"})`;
  }
  if (node.additionalProperties !== false)
    return `${where}: schema must set additionalProperties: false on every object`;
  for (const [name, child] of Object.entries(declared)) {
    const childError = strictSchemaError(child, `${where}.${name}`);
    if (childError) return childError;
  }
  return undefined;
}

/** Why a budget value is refused; `label` names it the way its author wrote it. */
export function budgetError(label: string, value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return undefined;
  return `${label} must be a strictly positive number`;
}

export function pipelineBudgetErrors(
  pipeline: Pick<Pipeline, "max_cost_usd" | "max_cost_per_work_item_usd">,
): string[] {
  const errors: string[] = [];
  if (pipeline.max_cost_usd != null && pipeline.max_cost_per_work_item_usd != null) {
    errors.push("max_cost_usd and max_cost_per_work_item_usd are incompatible");
  }
  for (const [field, value] of [
    ["max_cost_usd", pipeline.max_cost_usd],
    ["max_cost_per_work_item_usd", pipeline.max_cost_per_work_item_usd],
  ] as const) {
    const error = value == null ? undefined : budgetError(field, value);
    if (error) errors.push(error);
  }
  return errors;
}

/** A rework step must exist and write the artifact its subject approves; otherwise
 *  a rejection would replay nothing that can answer it. That it runs before its
 *  gate is known only to the builder that saw the gate. */
export function reworkErrors(pipeline: Pick<Pipeline, "steps" | "approvals" | "reworks">): string[] {
  const errors: string[] = [];
  for (const [subject, rework] of pipeline.reworks ?? []) {
    const fail = (why: string) => `rework step "${rework.stepId}" of subject "${subject}" ${why}`;
    const target = pipeline.steps.find((step) => step.id === rework.stepId);
    if (!target) {
      errors.push(fail("is not declared"));
      continue;
    }
    const artifact = pipeline.approvals?.get(subject);
    if (artifact && !target.outputs?.some((output) => output.name === artifact.name)) {
      errors.push(fail(`does not declare ${artifact.name} as an output`));
    }
  }
  return errors;
}
