import { readFileSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import type { AgentBackendRegistry, BackendSpec } from "../contracts/backends.js";
import type { ClaudeStepOptions } from "../contracts/backends/claude-code.js";
import { backendForFix, type JsonSchema } from "../contracts/backends.js";
import { VERDICT_FIELD_NAMES } from "../contracts/verdict.js";
import { isLogicalSegment } from "../model/artifact-ports.js";
import type { AsyncTemplated, PipelineContext, StepAction, Templated } from "../model/context.js";
import type { PipelineStep, StepCapture, StepFailure } from "../model/definition.js";
import type { Artifact } from "./artifact.js";
import type {
  ActionStepOptions,
  BackendOptionsFor,
  BashStepOptions,
  CaptureSpec,
  Escalate,
  LlmStepOptions,
  OnFail,
  StepOptionsBase,
} from "./dsl-types.js";
import { requiredText } from "./dsl-utils.js";
import { normalizeWhen, type StepInputCondition } from "./input.js";
import { type BackendFor, isEffort, type StepProfileName } from "./profiles.js";

export type {
  ActionStepOptions,
  BackendAuthorOptions,
  BackendOptionsFor,
  BashStepOptions,
  CaptureSpec,
  Escalate,
  LlmStepOptions,
  OnFail,
  StepOptionsBase,
} from "./dsl-types.js";
export type { BackendFor, StepProfileName } from "./profiles.js";

/** Author-facing `withBackend`, already bound to the run's backend registry. */
export type WithBackendFactory = (id: string, options?: unknown) => BackendSpec;

/** Author-facing `llmStep`, already bound to the run's backend registry. */
export type LlmStepFactory = <const P extends StepProfileName, const B extends BackendFor<P>>(
  options: LlmStepOptions<P, B>,
) => AgentStepBuilder;

export function withBackend(id: string, options: unknown, registry: AgentBackendRegistry): BackendSpec {
  if (!id.trim()) throw new Error("Backend id must be a non-empty string");
  const normalized = registry.normalizeAuthorOptions(id, options);
  return normalized === undefined ? { id } : { id, options: normalized };
}

export function llmStep<const P extends StepProfileName, const B extends BackendFor<P>>(
  options: LlmStepOptions<P, B>,
  registry: AgentBackendRegistry,
): AgentStepBuilder;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature behind the const-generic overload
export function llmStep(options: LlmStepOptions<any, any>, registry: AgentBackendRegistry): AgentStepBuilder {
  return createLlmStepFromOptions(options, undefined, registry);
}

export function createProjectLlmStep(baseDir: string, registry: AgentBackendRegistry): LlmStepFactory {
  const pipelineDir = pathResolve(baseDir);
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the const-generic overload of `llmStep`
  return ((options: LlmStepOptions<any, any>) =>
    createLlmStepFromOptions(options, pipelineDir, registry)) as LlmStepFactory;
}

export function bashStep(options: BashStepOptions): BashStepBuilder;
export function bashStep(options: BashStepOptions): BashStepBuilder {
  return createBashStepFromOptions(options, undefined);
}

/** `bashStep` bound to the run's registry: a bash step whose fix carries Claude
 *  options needs it to know which backend the fix runs on. */
export function createProjectBashStep(registry: AgentBackendRegistry): (options: BashStepOptions) => BashStepBuilder {
  return (options: BashStepOptions) => createBashStepFromOptions(options, registry);
}

export function actionStep(options: ActionStepOptions): ActionStepBuilder;
export function actionStep(options: ActionStepOptions): ActionStepBuilder {
  return createActionStepFromOptions(options, undefined);
}

/** `actionStep` bound to the run's registry, same reason as `bashStep`. */
export function createProjectActionStep(
  registry: AgentBackendRegistry,
): (options: ActionStepOptions) => ActionStepBuilder {
  return (options: ActionStepOptions) => createActionStepFromOptions(options, registry);
}

function createBashStepFromOptions(
  options: BashStepOptions,
  registry: AgentBackendRegistry | undefined,
): BashStepBuilder {
  const builder = new BashStepBuilder(
    requiredText(options.id, "id"),
    requiredText(options.name, "name"),
    registry,
  ).command(options.command);
  return normalizeStepOptions(builder, options);
}

function createActionStepFromOptions(
  options: ActionStepOptions,
  registry: AgentBackendRegistry | undefined,
): ActionStepBuilder {
  const builder = new ActionStepBuilder(requiredText(options.id, "id"), requiredText(options.name, "name"), registry)
    .run(options.run)
    .describe(options.describe);
  return normalizeStepOptions(builder, options);
}

function createLlmStepFromOptions(
  // biome-ignore lint/suspicious/noExplicitAny: internal normalization accepts every profile/backend pair
  options: LlmStepOptions<any, any>,
  promptBaseDir: string | undefined,
  registry: AgentBackendRegistry,
): AgentStepBuilder {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("llmStep() expects an options object");
  }
  const builder = new AgentStepBuilder(
    requiredText(options.id, "id"),
    requiredText(options.name, "name"),
    promptBaseDir,
    registry,
  ).profile(options.profile);
  builder.using(withBackend(requiredText(options.backend, "backend"), options.options, registry));
  const hasPrompt = options.prompt !== undefined;
  const hasCommand = options.command !== undefined;
  if (hasPrompt === hasCommand) throw new Error(`Step "${options.id}": define exactly one prompt or command field`);
  if (hasPrompt) builder.prompt(options.prompt!);
  else builder.command(options.command!);
  normalizeStepOptions(builder, options);
  // After `output`: a captured artifact already listed there is not added twice.
  if (options.capture !== undefined) builder.capture(options.capture);
  return builder;
}

function normalizeStepOptions<T extends StepBuilder>(builder: T, options: StepOptionsBase): T {
  builder.applyCanonicalOptions(options);
  return builder;
}

export abstract class StepBuilder {
  protected step: PipelineStep;

  constructor(
    id: string,
    name: string,
    runner: NonNullable<PipelineStep["runner"]>,
    /** Registry the step was declared against. Only steps that can carry a fix
     *  backend need one, which is why bash and action steps may be built without. */
    protected readonly registry?: AgentBackendRegistry,
  ) {
    this.step = { id, name, command: "", runner };
  }

  applyCanonicalOptions(options: StepOptionsBase): this {
    const admissions = normalizeWhen(options.when);
    if (admissions.length > 0) this.applyInputs(...admissions);
    if (options.require !== undefined) this.step.preflight = options.require;
    if (options.input !== undefined) this.input(...options.input);
    if (options.output !== undefined) this.output(...options.output);
    if (options.report !== undefined)
      this.report(typeof options.report === "string" ? options.report : [...options.report]);
    if (options.errorExtractor !== undefined) this.errorExtractor(options.errorExtractor);
    if (options.timeout !== undefined) this.timeout(options.timeout);
    if (options.blocking !== undefined) this.blocking(options.blocking);
    if (options.rerunOnResume) this.rerunOnResume();
    if (options.onFail !== undefined) this.onFail(options.onFail);
    return this;
  }

  applyInputs(...conditions: StepInputCondition[]): this {
    this.step.inputs = [...(this.step.inputs ?? []), ...conditions];
    return this;
  }

  command(value: AsyncTemplated<PipelineContext>): this {
    this.step.command = value;
    return this;
  }

  errorExtractor(name: string): this {
    this.step.error_extractor = name;
    return this;
  }

  report(paths: string | string[]): this {
    this.step.report_paths = Array.isArray(paths) ? paths : [paths];
    return this;
  }

  output(...artifacts: Artifact<unknown>[]): this {
    this.step.outputs = [...(this.step.outputs ?? []), ...artifacts];
    return this;
  }

  input(...artifacts: Artifact<unknown>[]): this {
    this.step.sources = [...(this.step.sources ?? []), ...artifacts];
    return this;
  }

  timeout(seconds: number): this {
    this.step.timeout = seconds;
    return this;
  }

  blocking(value: boolean): this {
    this.step.blocking = value;
    return this;
  }

  rerunOnResume(): this {
    this.step.rerun_on_resume = true;
    return this;
  }

  onFail(policy: OnFail): this {
    this.pendingFixClaudeOptions = undefined;
    if (policy.fix === undefined) {
      if (policy.resumeSession !== undefined) throw new Error("onFail: resumeSession requires fix");
      this.step.on_failure = applyEscalate({ max_retries: policy.retries ?? 1 }, policy.escalate);
      return this;
    }
    // A fix policy that never loops would fail the step without ever repairing it.
    if (policy.retries === 0) throw new Error("onFail: retries must be >= 1 when fix is set");
    const failure: StepFailure = {
      fix_prompt: policy.fix,
      max_retries: policy.retries ?? 1,
    };
    if (policy.resumeSession !== undefined)
      failure.resume_session = requiredText(policy.resumeSession, "resumeSession");
    // Claude options are Claude-shaped: they only apply when the fix actually runs
    // on the Claude backend. That backend is inherited from the step, which may not
    // be declared yet — resolution is deferred to build().
    if (policy.claude && policy.backendOptions === undefined) this.pendingFixClaudeOptions = policy.claude;
    if (policy.backendOptions !== undefined) failure.backend_options = policy.backendOptions;
    if (policy.fixProfile !== undefined) failure.fix_profile = policy.fixProfile;
    if (policy.fixBackend !== undefined) failure.fix_backend = requiredText(policy.fixBackend, "fixBackend");
    if (policy.resumeSizeThresholdKb != null) failure.resume_size_threshold_kb = policy.resumeSizeThresholdKb;
    if (policy.fixOnlyWhenExtracted !== undefined) failure.fix_only_when_extracted = policy.fixOnlyWhenExtracted;
    applyEscalate(failure, policy.escalate);
    this.step.on_failure = failure;
    return this;
  }

  private pendingFixClaudeOptions?: ClaudeStepOptions;

  build(): PipelineStep {
    if (this.pendingFixClaudeOptions && this.step.on_failure) {
      if (!this.registry) {
        throw new Error(
          `Step "${this.step.id}": onFail({ claude }) needs the pipeline's agent backend registry — declare this step through the loaded DSL`,
        );
      }
      const fixBackendId = backendForFix(this.step, this.registry).id;
      if (fixBackendId === "claude") {
        this.step.on_failure.backend_options = withBackend(
          "claude",
          this.pendingFixClaudeOptions,
          this.registry,
        ).options;
      }
    }
    validatePipelineStep(this.step);
    return this.step;
  }
}

function applyEscalate(failure: StepFailure, escalate: Escalate | undefined): StepFailure {
  if (!escalate) return failure;
  if (escalate.model !== undefined) {
    if (!escalate.model.trim()) throw new Error("Escalation: model must be a non-empty string");
    failure.escalate_model = escalate.model;
  }
  if (escalate.effort !== undefined) {
    if (!isEffort(escalate.effort))
      throw new Error(`Escalation: invalid effort (received: ${String(escalate.effort)})`);
    failure.escalate_effort = escalate.effort;
  }
  if (escalate.after !== undefined) {
    if (!Number.isInteger(escalate.after) || escalate.after < 0) {
      throw new Error(`Escalation: after must be a non-negative integer (received: ${escalate.after})`);
    }
    failure.escalate_after = escalate.after;
  }
  return failure;
}

function validatePipelineStep(step: PipelineStep): void {
  if (!isLogicalSegment(step.id)) throw new Error(`Step "${step.id}": id must be a non-empty safe logical value`);
  const commandMissing = !step.command || (typeof step.command === "string" && !step.command.trim());
  if (step.runner === "fn" && commandMissing) throw new Error(`Step "${step.id}": .describe() is required`);
  if ((step.runner === "agent" || step.runner === "bash") && commandMissing) {
    throw new Error(`Step "${step.id}": .command() is required`);
  }
  if (step.runner === "fn" && !step.action) throw new Error(`Step "${step.id}": .run() is required`);
  // An agent step is repaired by its own backend: a second one would be ignored.
  if (step.backend && step.on_failure?.fix_backend) {
    throw new Error(`Step "${step.id}": fixBackend applies only to a step without a backend (bashStep, actionStep)`);
  }
  // The gate reads the extraction result; without an extractor there is none, and
  // the option would sit in the pipeline doing nothing.
  if (step.on_failure?.fix_only_when_extracted && !step.error_extractor) {
    throw new Error(`Step "${step.id}": fixOnlyWhenExtracted requires errorExtractor`);
  }
  if (step.runner === "pipeline" && !step.orchestration) {
    throw new Error(`Step "${step.id}": orchestration definition is missing`);
  }
  // Freshness is decided on the outputs: without one, `input` would declare a
  // dependency the runner has nothing to compare it against.
  if (step.sources?.length && !step.outputs?.length) {
    throw new Error(`Step "${step.id}": input requires output`);
  }
  // A capture reads the agent's structured output; only an agent step has one.
  if (step.captures?.length && step.runner !== "agent") {
    throw new Error(`Step "${step.id}": capture applies only to an agent step (llmStep)`);
  }
}

function isArtifactDescriptor(spec: CaptureSpec): spec is Artifact<string> {
  return typeof (spec as Artifact<string>).read === "function" && typeof (spec as Artifact<string>).name === "string";
}

/**
 * Strict-mode compatibility of a captured field's schema, the invariant the
 * providers enforce on the whole verdict schema: on every object node, `required`
 * lists exactly the declared properties and `additionalProperties` is `false`. A
 * schema refused here would otherwise be refused by the provider with a 400 at
 * the first spawn, far from the declaration.
 */
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

export function assertStrictSchema(schema: JsonSchema, where: string): void {
  const unsupported = UNSUPPORTED_SCHEMA_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);
  if (unsupported.length > 0) {
    throw new Error(
      `${where}: ${unsupported.join(", ")} ${unsupported.length > 1 ? "are" : "is"} not supported by capture schemas (allowed: type, properties, required, additionalProperties, items, enum, description)`,
    );
  }
  const isObject = schema.type === "object" || schema.properties !== undefined;
  if (isObject) {
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    if (properties.join("\0") !== required.join("\0")) {
      throw new Error(
        `${where}: schema.required must list every property (properties: ${properties.join(", ") || "none"}; required: ${required.join(", ") || "none"})`,
      );
    }
    if (schema.additionalProperties !== false) {
      throw new Error(`${where}: schema must set additionalProperties: false on every object`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      assertStrictSchema(child, `${where}.${name}`);
    }
  }
  if (schema.items !== undefined) {
    const items = Array.isArray(schema.items) ? (schema.items as readonly JsonSchema[]) : [schema.items as JsonSchema];
    for (const item of items) assertStrictSchema(item, `${where}[]`);
  }
}

export class AgentStepBuilder extends StepBuilder {
  constructor(
    id: string,
    name: string,
    private readonly promptBaseDir: string | undefined,
    private readonly backendRegistry: AgentBackendRegistry,
  ) {
    super(id, name, "agent", backendRegistry);
    this.step.output_format = "json";
  }

  prompt(relativePath: string): this {
    if (!this.promptBaseDir)
      throw new Error(`Step "${this.step.id}": .prompt() is available only in a loaded project pipeline`);
    if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
      throw new Error(`Step "${this.step.id}": .prompt() expects a non-empty relative path`);
    }
    if (isAbsolute(relativePath))
      throw new Error(`Step "${this.step.id}": .prompt() expects a path relative to the pipeline file`);
    const filePath = pathResolve(this.promptBaseDir, relativePath);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8").trimEnd();
    } catch (error) {
      const detail = error instanceof Error ? ` : ${error.message}` : "";
      throw new Error(`Project prompt "${filePath}": file is missing or unreadable${detail}`, { cause: error });
    }
    this.command(content);
    return this;
  }

  using(spec: BackendSpec): this {
    if (!spec.id.trim()) throw new Error(`Step "${this.step.id}": backend ID must be non-empty`);
    this.step.backend = spec;
    return this;
  }

  private backend(id: string, options?: unknown): this {
    return this.using(withBackend(id, options, this.backendRegistry));
  }

  codex(options?: BackendOptionsFor<"codex">): this {
    return this.backend("codex", options);
  }

  claude(options?: BackendOptionsFor<"claude">): this {
    return this.backend("claude", options);
  }

  profile(name: StepProfileName): this {
    if (this.step.profile) throw new Error(`Step "${this.step.id}": .profile() is already defined`);
    this.step.profile = name;
    return this;
  }

  /**
   * Declare the fields the agent returns in its verdict object and the runner
   * persists as artifacts. Short form (`field: textArtifact`) for text; long form
   * (`field: { artifact, schema }`) for anything else, JSON artifacts included,
   * whose schema must be strict-mode compatible. Every captured artifact is added
   * to `outputs` — once — so it inherits erase-before-spawn, `require`, provenance,
   * and the lint report.
   */
  capture(spec: Readonly<Record<string, CaptureSpec>>): this {
    const id = this.step.id;
    for (const [field, entry] of Object.entries(spec)) {
      const where = `Step "${id}": capture "${field}"`;
      if (!field.trim()) throw new Error(`Step "${id}": capture field names must be non-empty`);
      if ((VERDICT_FIELD_NAMES as readonly string[]).includes(field)) {
        throw new Error(`${where} is reserved by the verdict contract (${VERDICT_FIELD_NAMES.join(", ")})`);
      }
      if (this.step.captures?.some((capture) => capture.field === field)) {
        throw new Error(`${where} is declared twice`);
      }
      let capture: StepCapture;
      if (isArtifactDescriptor(entry)) {
        if (entry.kind !== "text") {
          throw new Error(
            `${where}: the short form is reserved to textArtifact; a JSON artifact needs { artifact, schema }`,
          );
        }
        capture = { field, artifact: entry, schema: { type: "string" }, text: true };
      } else {
        if (!entry || typeof entry !== "object" || !isArtifactDescriptor(entry.artifact as CaptureSpec)) {
          throw new Error(`${where}: expected a textArtifact or { artifact, schema }`);
        }
        if (!entry.schema || typeof entry.schema !== "object") throw new Error(`${where}: schema is required`);
        assertStrictSchema(entry.schema, `${where}.schema`);
        capture = { field, artifact: entry.artifact, schema: entry.schema, text: entry.artifact.kind === "text" };
      }
      this.step.captures = [...(this.step.captures ?? []), capture];
      if (!this.step.outputs?.some((output) => output.name === capture.artifact.name)) {
        this.output(capture.artifact);
      }
    }
    return this;
  }
}

export class BashStepBuilder extends StepBuilder {
  constructor(id: string, name: string, registry?: AgentBackendRegistry) {
    super(id, name, "bash", registry);
  }
}

export class ActionStepBuilder extends StepBuilder {
  constructor(id: string, name: string, registry?: AgentBackendRegistry) {
    super(id, name, "fn", registry);
  }

  run(fn: StepAction): this {
    this.step.action = fn;
    return this;
  }

  describe(value: Templated<PipelineContext>): this {
    return this.command(value);
  }
}
