export interface BackendSpec {
  readonly id: string;
  readonly options?: unknown;
}

export interface AgentSession {
  readonly provider: string;
  readonly id: string;
  readonly resumable: boolean;
}

export interface AgentCapabilities {
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly resume: boolean;
  readonly usageTokens: boolean;
  readonly cost: "exact" | "estimable" | "none";
  readonly configurationAxes?: readonly AgentConfigAxis[];
}

export type AgentConfigAxis = "model" | "effort";

/** Effort values shared by provider adapters and pipeline profiles. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

export interface AgentUsageAccounting {
  readonly pricing: Readonly<Record<string, ModelPricing>>;
  readonly pricingFallback?: string;
  readonly inputIncludesCached?: boolean;
}

export function backendOptionAxes(options: unknown): AgentConfigAxis[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) return [];
  return (["model", "effort"] as const).filter((axis) => Object.hasOwn(options, axis));
}

export function declaredBackendAxes(step: { backend?: BackendSpec }): Partial<Record<AgentConfigAxis, string>> {
  const options = backendSpecForStep(step)?.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  const source = options as Partial<Record<AgentConfigAxis, unknown>>;
  return Object.fromEntries(
    (["model", "effort"] as const)
      .filter((axis) => typeof source[axis] === "string" && source[axis] !== "")
      .map((axis) => [axis, source[axis] as string]),
  );
}

export type AgentEscalationRung = "none" | "effort" | "model";
export interface AgentEscalation {
  readonly rung: AgentEscalationRung;
  readonly model?: string;
  readonly effort?: string;
}
export type AgentIntent = "step" | "fix";

export interface ArtifactScope {
  readonly artifactsDir: string;
  readonly workItemDir?: string;
}

/**
 * Minimal JSON Schema, as accepted by the providers' structured-output modes.
 * Deliberately narrow: an author declares the shape of ONE captured field, and a
 * backend inserts it under the verdict schema. Anything the strict modes reject
 * (an optional property, `additionalProperties` left open) is refused at build
 * time by `AgentStepBuilder.capture`, not here.
 */
export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema | readonly JsonSchema[];
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly [keyword: string]: unknown;
}

export interface AgentRequest {
  readonly prompt: string;
  readonly cwd?: string;
  readonly runnerDir?: string;
  readonly artifactScope?: ArtifactScope;
  readonly role?: string;
  readonly intent?: AgentIntent;
  readonly outputFormat?: "text" | "json";
  /** Extra fields the agent must return next to `success`/`reason`/`blocked`, by
   *  name. A backend with a native output schema declares them in it; one without
   *  spells them out in the prompt-injected verdict instruction. The runner reads
   *  them back from `structuredOutput` and persists them as artifacts (`capture`). */
  readonly outputFields?: Readonly<Record<string, JsonSchema>>;
  readonly timeoutMs?: number;
  readonly budgetRemaining?: number;
  /** A cost ceiling governs this attempt and unknown spend is NOT authorized
   *  (`--allow-unmetered` absent). A live cost guard that can prove its usage is
   *  unpriceable — tokens consumed with no rate, or a provider zero over spent
   *  tokens — must stop the attempt instead of letting it run against a ceiling
   *  it cannot be measured against. Absence of usage events is never such a
   *  proof: a guard that knows nothing yet kills nothing. */
  readonly strictCostAccounting?: boolean;
  readonly session?: AgentSession;
  readonly resumeSession?: AgentSession;
  readonly stepLogPath?: string;
  readonly options?: unknown;
}

export interface StepControl {
  duration_ms: number;
  total_cost_usd?: number;
  cost_estimated?: boolean;
  /** An agent ran and reported tokens, but no price could be applied (model absent
   * from every pricing table). The attempt spent money the ledger cannot see, so
   * `max_cost_usd` is NOT enforced for it. */
  cost_unknown?: boolean;
  model?: string;
  provider?: string;
  last_turn_context_tokens?: number;
  context_window?: number;
}

export interface StepUsage {
  duration_api_ms?: number;
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  tools_used?: string[];
}

export interface AttemptStats extends StepControl, StepUsage {}
export type StepFailKind = "verdict" | "technical";

/**
 * Structured cause of a failure a fix pass cannot change the answer to.
 *
 * Orthogonal to `StepFailKind`: the kind says whether the attempt broke or was
 * judged, the cause says repairing is pointless. `blocked` is an obstacle
 * outside the code — a missing branch, an unreachable service, a backend that
 * cannot authenticate — so the run stops cleanly instead of spending repair
 * attempts on it.
 *
 * It is the machine-readable signal; the `BLOCKED:` prose prefix is the
 * fallback, accepted at the two boundaries that read agent or extension text
 * (`verdictFromObject`, `normalizeAgentResult`) and nowhere else.
 */
export type StepFailCause = "blocked";

/** Closed list of `StepFailCause`, for the persisted schemas. */
export const FAIL_CAUSES = ["blocked"] as const satisfies readonly StepFailCause[];

export interface RunnerResult {
  output: string;
  ok: boolean;
  timedOut?: boolean;
  /** The live cost guard killed the process: the failure is a budget stop, not a
   *  technical error, and the report must say so. */
  budgetExceeded?: boolean;
  /** The live cost guard killed the process because its usage was provably
   *  unpriceable under a ceiling nobody authorized unmetered spend against. A
   *  stop of its own: the report must not read "Budget exceeded", which would
   *  send an operator to `--budget`, nor "Technical error", which would send it
   *  to a fix loop. */
  costUnaccounted?: boolean;
  failReason?: string;
  failKind?: StepFailKind;
  /** Why repairing this failure is pointless, when the backend can say so. The
   *  step loop reads this field and never `failReason`'s prose. */
  failCause?: StepFailCause;
}

export interface AgentResult extends RunnerResult {
  readonly stats: AttemptStats;
  readonly session?: AgentSession;
  readonly structuredOutput?: unknown;
  readonly provider: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  readonly createSession?: () => AgentSession;
  readonly applyEscalation?: (options: unknown, escalation: AgentEscalation) => unknown;
  readonly applyConfigAxes?: (options: unknown, axes: Partial<Record<AgentConfigAxis, string>>) => unknown;
  readonly resumeHint?: (session: AgentSession) => string;
  readonly sessionLocation?: (session: AgentSession) => string | null;
  readonly sessionSizeKb?: (session: AgentSession) => number | null;
  run(request: AgentRequest): Promise<AgentResult>;
}

export interface AgentBackendFactory {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  readonly usage?: AgentUsageAccounting;
  readonly normalizeAuthorOptions?: (options: unknown) => unknown;
  create(options?: unknown): AgentBackend;
}

export function backendSpecForStep(step: { backend?: BackendSpec }): BackendSpec | undefined {
  return step.backend;
}

export function isAgentStep(step: { runner?: string; backend?: BackendSpec }): boolean {
  return step.backend != null || step.runner === "agent";
}

export class AgentBackendRegistry {
  private readonly factories = new Map<string, AgentBackendFactory>();

  private defaultId: string | undefined;

  register(factory: AgentBackendFactory, opts: { default?: boolean } = {}): this {
    if (!factory.id.trim()) throw new Error("Agent backend: id must be non-empty");
    if (this.factories.has(factory.id))
      throw new Error(`Agent backend: provider "${factory.id}" is already registered`);
    this.factories.set(factory.id, factory);
    if (opts.default || this.defaultId === undefined) this.defaultId = factory.id;
    return this;
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  known(): string[] {
    return [...this.factories.keys()];
  }

  defaultBackendId(): string {
    if (!this.defaultId) throw new Error("Agent backend: no provider registered");
    return this.defaultId;
  }

  usageAccounting(id: string): AgentUsageAccounting | undefined {
    return this.factories.get(id)?.usage;
  }

  normalizeAuthorOptions(id: string, options?: unknown): unknown {
    const normalize = this.factories.get(id)?.normalizeAuthorOptions;
    return normalize ? normalize(options) : options;
  }

  resolve(spec: BackendSpec): AgentBackend {
    const factory = this.factories.get(spec.id);
    if (!factory) throw new Error(`Unknown agent backend "${spec.id}" (known: ${this.known().join(", ") || "none"})`);
    return factory.create(spec.options);
  }
}

/** Backend that repairs a step: its own, else the one named by its fix policy, else
 *  the default. `resume_session` may still move a `bash` step's fix onto the resumed
 *  step's provider at runtime (`chooseFixBackend`). */
export function backendForFix(
  step: { backend?: BackendSpec; on_failure?: { fix_backend?: string } },
  registry: AgentBackendRegistry,
): BackendSpec {
  const declared = backendSpecForStep(step);
  if (declared) return declared;
  const fixBackend = step.on_failure?.fix_backend;
  return fixBackend ? { id: fixBackend } : { id: registry.defaultBackendId() };
}
