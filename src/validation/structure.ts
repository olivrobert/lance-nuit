import { VERDICT_FIELD_NAMES } from "../contracts/verdict.js";
import { isLogicalSegment } from "../model/artifact-ports.js";
import type { PipelineStep } from "../model/definition.js";
import type { PipelineValidationContext, PipelineValidationFinding, PipelineValidationRule } from "./types.js";

const VALID_RUNNERS = new Set(["agent", "bash", "noop", "fn", "pipeline"]);
const VALID_OUTPUT_FORMAT = new Set(["text", "json"]);

function stepsOf(context: PipelineValidationContext): PipelineStep[] {
  return Array.isArray(context.pipeline.steps)
    ? context.pipeline.steps.filter((step): step is PipelineStep => !!step && typeof step === "object")
    : [];
}

function stepId(step: PipelineStep): string {
  return typeof step.id === "string" && step.id ? step.id : "?";
}

/** Shape rules that depend on neither a backend nor configuration. */
export class PipelineStructureValidator implements PipelineValidationRule {
  readonly id = "pipeline-structure";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const fail = (message: string): void => {
      findings.push({ rule: this.id, level: "error", message });
    };

    if (!context.pipeline.name || typeof context.pipeline.name !== "string") {
      fail('missing "name" field');
    } else if (!isLogicalSegment(context.pipeline.name)) {
      fail("pipeline name must be a non-empty safe logical value");
    }
    if (!Array.isArray(context.pipeline.steps) || context.pipeline.steps.length === 0) {
      fail('"steps" must be a non-empty array');
      return findings;
    }

    if (context.pipeline.max_cost_usd != null && context.pipeline.max_cost_per_work_item_usd != null) {
      fail("max_cost_usd and max_cost_per_work_item_usd are incompatible");
    }
    for (const [field, value] of [
      ["max_cost_usd", context.pipeline.max_cost_usd],
      ["max_cost_per_work_item_usd", context.pipeline.max_cost_per_work_item_usd],
    ] as const) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
        fail(`${field} must be a strictly positive number`);
      }
    }

    const seenIds = new Set<string>();
    for (const step of stepsOf(context)) {
      const id = stepId(step);
      if (!isLogicalSegment(step.id)) {
        fail(`step "${id}": id must be a non-empty safe logical value`);
      }
      if (!step.id || !step.name || (step.command == null && step.runner !== "pipeline")) {
        fail("every step must have id, name, and command");
      }
      if (typeof step.id === "string" && seenIds.has(step.id)) {
        fail(`duplicate id "${step.id}"`);
      }
      if (typeof step.id === "string") seenIds.add(step.id);

      if (step.runner != null && !VALID_RUNNERS.has(step.runner)) {
        fail(`step "${id}": unknown runner "${step.runner}" (expected: ${[...VALID_RUNNERS].join(", ")})`);
      }
      if (step.runner === "fn" && typeof step.action !== "function") {
        fail(`step "${id}": runner "fn" requires an action`);
      }
      if (step.runner === "pipeline" && (!step.orchestration || typeof step.orchestration !== "object")) {
        fail(`step "${id}": runner "pipeline" requires an orchestration definition`);
      }
      if (step.runner !== "pipeline" && step.orchestration) {
        fail(`step "${id}": orchestration is reserved for runner "pipeline"`);
      }
      // Orchestration options do not extend the step options base, so an untyped
      // JavaScript pipeline is the only way `input` can reach a composition node.
      if (step.runner === "pipeline" && step.sources) {
        fail(`step "${id}": input is not supported by runner "pipeline"`);
      }
      if (step.sources?.length && !step.outputs?.length) {
        fail(`step "${id}": input requires output`);
      }
      if (step.captures?.length && step.runner !== "agent") {
        fail(`step "${id}": capture applies only to runner "agent"`);
      }
      // The builder refuses these shapes; a raw definition reaches the runner
      // without it. A capture named after a verdict field would overwrite that
      // field's type in the verdict schema and break the contract in silence.
      const seenFields = new Set<string>();
      const seenArtifacts = new Set<string>();
      for (const capture of step.captures ?? []) {
        const field = typeof capture?.field === "string" ? capture.field : "";
        if (!field.trim()) {
          fail(`step "${id}": capture field names must be non-empty`);
          continue;
        }
        if ((VERDICT_FIELD_NAMES as readonly string[]).includes(field)) {
          fail(
            `step "${id}": capture "${field}" is reserved by the verdict contract (${VERDICT_FIELD_NAMES.join(", ")})`,
          );
        }
        if (seenFields.has(field)) fail(`step "${id}": capture "${field}" is declared twice`);
        seenFields.add(field);
        const artifactName = capture.artifact?.name;
        if (typeof artifactName !== "string" || !artifactName) {
          fail(`step "${id}": capture "${field}" needs an artifact`);
        } else if (seenArtifacts.has(artifactName)) {
          fail(`step "${id}": capture "${field}" targets artifact "${artifactName}" already captured by another field`);
        } else {
          seenArtifacts.add(artifactName);
        }
      }
      if (step.backend && step.runner != null && step.runner !== "agent") {
        fail(`step "${id}": an agent backend can only be used with runner agent`);
      }
      if (step.output_format != null && !VALID_OUTPUT_FORMAT.has(step.output_format)) {
        fail(
          `step "${id}": unknown output_format "${step.output_format}" (expected: ${[...VALID_OUTPUT_FORMAT].join(", ")})`,
        );
      }
      if (!step.on_failure) continue;
      const { max_retries, fix_prompt, resume_session } = step.on_failure;
      if (typeof max_retries !== "number" || !Number.isInteger(max_retries) || max_retries < 0) {
        fail(`step "${id}": on_failure.max_retries must be a finite integer >= 0`);
      }
      if (resume_session !== undefined && !fix_prompt) {
        fail(`step "${id}": on_failure.resume_session requires fix_prompt`);
      }
      // A fix policy that never loops would fail the step without ever repairing it.
      if (fix_prompt && max_retries === 0) {
        fail(`step "${id}": on_failure.max_retries must be >= 1 when fix_prompt is set`);
      }
    }

    return findings;
  }
}

export function pipelineSteps(context: PipelineValidationContext): PipelineStep[] {
  return stepsOf(context);
}
