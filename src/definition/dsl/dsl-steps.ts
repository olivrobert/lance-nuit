import { readFileSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import type { AgentBackendRegistry, BackendSpec } from "../../contracts/backends.js";
import type { ClaudeStepOptions } from "../../contracts/backends/claude-code.js";
import { backendForFix } from "../../contracts/backends.js";
import type { AsyncTemplated, PipelineContext, StepAction, Templated } from "../../shared/language/context.js";
import type { ParallelGroup, PipelineStep, PipelineWorkItemSource, StepCapture, StepFailure } from "../definition.js";
import { stepShapeErrors } from "../step-shape.js";
import type { StepInput } from "../../work-items/index.js";
import type { Artifact } from "./artifact.js";
import type {
  ActionStepOptions,
  BashStepOptions,
  CaptureSpec,
  Escalate,
  LlmStepOptions,
  OnFail,
  ReviewOptions,
  StepOptionsBase,
} from "./dsl-types.js";
import { requiredText } from "./dsl-utils.js";
import { normalizeWhen, type StepInputCondition } from "./input.js";
import { type BackendFor, isStepProfileName, type StepProfileName } from "./profiles.js";

export type {
  ActionStepOptions,
  BackendAuthorOptions,
  BackendOptionsFor,
  BashStepOptions,
  CaptureSpec,
  Escalate,
  LlmStepOptions,
  OnFail,
  ReviewOptions,
  StepOptionsBase,
} from "./dsl-types.js";
export type { BackendFor, StepProfileName } from "./profiles.js";

/** What a step learns from the pipeline that assembles it. */
export interface StepAssembly {
  readonly pipelineName: string;
  readonly workItemSource?: PipelineWorkItemSource;
}

/** Approval subjects carried by a step and surfaced on the pipeline during assembly. */
export interface StepApprovalDeclaration {
  subjects: readonly string[];
  artifact: Artifact<unknown>;
  /** Reason `subject` cannot be approved for the current artifact, undefined when
   *  it can. Absent when every subject is approvable whatever the verdict. */
  guard?: (subject: string, ctx: PipelineContext) => Promise<string | undefined>;
  /** Step that reworks the artifact when a human rejects one of `subjects`. */
  rework?: { stepId: string; maxRounds: number };
}

/** Prompt file content, as both `llmStep({ prompt })` and `promptFile` read it. */
export function readProjectPrompt(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8").trimEnd();
  } catch (error) {
    const detail = error instanceof Error ? ` : ${error.message}` : "";
    throw new Error(`Project prompt "${filePath}": missing or unreadable file${detail}`, { cause: error });
  }
}

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
  if (options.review !== undefined) builder.review(options.review);
  return builder;
}

function normalizeStepOptions<T extends StepBuilder>(builder: T, options: StepOptionsBase): T {
  builder.applyCanonicalOptions(options);
  return builder;
}

export abstract class StepBuilder {
  protected step: PipelineStep;

  /** Approval the step declares to its pipeline; set by the human-review gate. */
  readonly approval?: StepApprovalDeclaration;

  /** Work-item source the step declares to its pipeline; set by the source step. */
  readonly workItemSource?: PipelineWorkItemSource;

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
    if (options.replayInterrupted) this.replayInterrupted();
    if (options.onStale !== undefined) this.onStale(options.onStale);
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

  input(...artifacts: StepInput[]): this {
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

  replayInterrupted(): this {
    this.step.replay_interrupted = true;
    return this;
  }

  onStale(value: "run" | "stop"): this {
    if (value !== "run" && value !== "stop") throw new Error(`Step "${this.step.id}": onStale must be "run" or "stop"`);
    if (value === "stop") this.step.on_stale = "stop";
    else delete this.step.on_stale;
    return this;
  }

  onFail(policy: OnFail): this {
    this.pendingFixClaudeOptions = undefined;
    // `resumeSession` and `stopIfUnchanged` are kept without a fix so that the
    // shape rule refusing them sees them; the other repair options are dropped.
    const failure: StepFailure = { max_retries: policy.retries ?? 1 };
    if (policy.resumeSession !== undefined)
      failure.resume_session = requiredText(policy.resumeSession, "resumeSession");
    if ("stopIfUnchanged" in policy) failure.stop_if_unchanged = policy.stopIfUnchanged;
    if (policy.fix !== undefined) {
      failure.fix_prompt = policy.fix;
      Object.assign(failure, repairOptions(policy));
      // Claude options are Claude-shaped: they only apply when the fix actually runs
      // on the Claude backend. That backend is inherited from the step, which may not
      // be declared yet — resolution is deferred to build().
      if (policy.claude && policy.backendOptions === undefined) this.pendingFixClaudeOptions = policy.claude;
    }
    this.step.on_failure = withEscalate(failure, policy.escalate);
    return this;
  }

  parallelGroup(group: ParallelGroup): this {
    this.step.parallel_group = group;
    return this;
  }

  private pendingFixClaudeOptions?: ClaudeStepOptions;

  /** Build the step without touching the builder: two calls give equal steps. */
  build(assembly?: StepAssembly): PipelineStep {
    const step = this.assemble(assembly);
    const [shapeError] = stepShapeErrors(step);
    if (shapeError) throw new Error(`Step "${step.id}": ${shapeError}`);
    // The fix of a review resumes the producing session: a backend that cannot
    // resume would always fix blind. The review's own session is never resumed.
    if (step.review && step.backend && this.registry) {
      if (!this.registry.resolve(step.backend).capabilities.resume) {
        throw new Error(`Step "${step.id}": review needs a backend that resumes sessions; "${step.backend.id}" cannot`);
      }
    }
    return step;
  }

  /** A fresh step from the declarations. Loading rewrites `on_failure` and
   *  `review` in place, so the step gets its own copies of both. */
  protected assemble(_assembly: StepAssembly | undefined): PipelineStep {
    const step: PipelineStep = { ...this.step };
    if (step.review) step.review = { ...step.review };
    if (step.on_failure) step.on_failure = { ...step.on_failure, ...this.claudeFixOptions(step) };
    return step;
  }

  private claudeFixOptions(step: PipelineStep): Pick<StepFailure, "backend_options"> {
    if (!this.pendingFixClaudeOptions) return {};
    if (!this.registry) {
      throw new Error(
        `Step "${step.id}": onFail({ claude }) needs the pipeline's agent backend registry — declare this step through the loaded DSL`,
      );
    }
    if (backendForFix(step, this.registry).id !== "claude") return {};
    return { backend_options: withBackend("claude", this.pendingFixClaudeOptions, this.registry).options };
  }
}

function repairOptions(policy: Extract<OnFail, { fix: unknown }>): Partial<StepFailure> {
  return {
    ...(policy.backendOptions !== undefined ? { backend_options: policy.backendOptions } : {}),
    ...(policy.fixProfile !== undefined ? { fix_profile: policy.fixProfile } : {}),
    ...(policy.fixBackend !== undefined ? { fix_backend: requiredText(policy.fixBackend, "fixBackend") } : {}),
    ...(policy.resumeSizeThresholdKb != null ? { resume_size_threshold_kb: policy.resumeSizeThresholdKb } : {}),
    ...(policy.fixOnlyWhenExtracted !== undefined ? { fix_only_when_extracted: policy.fixOnlyWhenExtracted } : {}),
    ...(policy.replayAfterFix !== undefined ? { replay_after_fix: policy.replayAfterFix } : {}),
  };
}

function withEscalate(failure: StepFailure, escalate: Escalate | undefined): StepFailure {
  if (!escalate) return failure;
  return {
    ...failure,
    ...(escalate.model !== undefined ? { escalate_model: escalate.model } : {}),
    ...(escalate.effort !== undefined ? { escalate_effort: escalate.effort } : {}),
    ...(escalate.after !== undefined ? { escalate_after: escalate.after } : {}),
  };
}

function isArtifactDescriptor(spec: CaptureSpec): spec is Artifact<string> {
  return typeof (spec as Artifact<string>).read === "function" && typeof (spec as Artifact<string>).name === "string";
}

export class AgentStepBuilder extends StepBuilder {
  constructor(
    id: string,
    name: string,
    private readonly promptBaseDir: string | undefined,
    backendRegistry: AgentBackendRegistry,
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
    this.command(readProjectPrompt(pathResolve(this.promptBaseDir, relativePath)));
    return this;
  }

  using(spec: BackendSpec): this {
    if (!spec.id.trim()) throw new Error(`Step "${this.step.id}": backend ID must be non-empty`);
    this.step.backend = spec;
    return this;
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
   * to `outputs` — once — so it inherits erase-before-spawn, `require`, the stamp,
   * and the lint report.
   */
  capture(spec: Readonly<Record<string, CaptureSpec>>): this {
    const id = this.step.id;
    for (const [field, entry] of Object.entries(spec)) {
      const where = `Step "${id}": capture "${field}"`;
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
        capture = { field, artifact: entry.artifact, schema: entry.schema, text: entry.artifact.kind === "text" };
      }
      this.step.captures = [...(this.step.captures ?? []), capture];
      if (!this.step.outputs?.some((output) => output.name === capture.artifact.name)) {
        this.output(capture.artifact);
      }
    }
    return this;
  }

  /**
   * Declare the review of the step's outputs. The review capture joins `outputs`,
   * so it is erased with them before each `step` attempt and covered by the one
   * stamp of the pass; it is required only after the review attempt.
   */
  // biome-ignore lint/suspicious/noExplicitAny: each review declares its own capture type
  review(spec: ReviewOptions<any>): this {
    const id = this.step.id;
    if (!spec || typeof spec !== "object") throw new Error(`Step "${id}": review expects an options object`);
    if (typeof spec.fix !== "function") throw new Error(`Step "${id}": review.fix must be a function`);
    if (!isStepProfileName(spec.profile)) throw new Error(`Step "${id}": review.profile is not a known profile`);
    if (spec.fixProfile !== undefined && !isStepProfileName(spec.fixProfile)) {
      throw new Error(`Step "${id}": review.fixProfile is not a known profile`);
    }
    const retries = spec.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error(`Step "${id}": review.retries must be a non-negative integer`);
    }
    const capture = spec.capture;
    const where = `Step "${id}": review capture`;
    if (!capture || typeof capture !== "object" || !requiredText(capture.field, "review.capture.field")) {
      throw new Error(`${where}: expected { field, artifact, schema }`);
    }
    if (!isArtifactDescriptor(capture.artifact as CaptureSpec)) throw new Error(`${where}: artifact is required`);
    if (!capture.schema || typeof capture.schema !== "object") throw new Error(`${where}: schema is required`);
    if (this.step.captures?.some((other) => other.field === capture.field)) {
      throw new Error(`${where} "${capture.field}" is already a capture of the step`);
    }
    if (this.step.outputs?.some((output) => output.name === capture.artifact.name)) {
      throw new Error(`${where}: artifact "${capture.artifact.name}" is already an output of the step`);
    }
    const commandMissing = typeof spec.command === "string" ? !spec.command.trim() : typeof spec.command !== "function";
    if (commandMissing) throw new Error(`Step "${id}": review.command is required`);
    this.step.review = {
      command: spec.command,
      backend: withBackend(requiredText(spec.backend, "review.backend"), spec.options, this.registry!),
      profile: spec.profile,
      capture: {
        field: capture.field,
        artifact: capture.artifact,
        schema: capture.schema,
        text: capture.artifact.kind === "text",
      },
      fix: spec.fix,
      ...(spec.fixProfile !== undefined ? { fix_profile: spec.fixProfile } : {}),
      retries,
    };
    this.output(capture.artifact);
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
