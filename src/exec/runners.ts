// runner/exec/runners.ts
//
// Runner dispatch facade. Implementations are split by responsibility: process
// supervision, bash, agent backends, and sessions. Machine reports and error
// extraction live in `report-extraction.ts`.

import type { AgentBackendRegistry, AttemptStats, RunnerResult } from "../contracts/backends.js";
import {
  type AgentIntent,
  type AgentRequest,
  type AgentResult,
  type AgentSession,
  type ArtifactScope,
  type BackendSpec,
  backendSpecForStep,
} from "../contracts/backends.js";
import { hasBlockedPrefix } from "../contracts/verdict.js";
import { errorMessage } from "../lib/errors.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { PipelineStep } from "../model/definition.js";
import type { RunStep } from "../model/run.js";
import { DEFAULT_BASH_TIMEOUT_MS, runBashStreaming } from "./bash-runner.js";
import { DEFAULT_PROCESS_TIMEOUT_MS } from "./process-runner.js";
import { discardStaleReports } from "./report-extraction.js";

export { runBashAsync, runBashStreaming } from "./bash-runner.js";

export interface StepResult extends RunnerResult {
  stats?: AttemptStats;
  session?: AgentSession;
  /** The verdict object as the backend parsed it, extra fields included. The
   *  step loop reads the captured fields (`captures`) from here. */
  structuredOutput?: unknown;
  /** The command succeeded but a captured field was refused by its artifact:
   *  absent, of the wrong shape, or rejected by the artifact's own parser. Set by
   *  the attempt, read by the outcome phase to ask the same session for a
   *  corrected object. In-memory only, like `structuredOutput`: the persisted
   *  attempt keeps its `failReason` and nothing else. */
  captureRefused?: boolean;
}

export interface InvokeBackendInput {
  readonly spec: BackendSpec;
  readonly prompt: string;
  readonly cwd?: string;
  readonly runnerDir?: string;
  readonly role?: string;
  readonly intent?: AgentIntent;
  readonly outputFormat?: AgentRequest["outputFormat"];
  readonly outputFields?: AgentRequest["outputFields"];
  readonly options?: unknown;
  readonly timeoutMs?: number;
  readonly budgetRemaining?: number;
  readonly strictCostAccounting?: boolean;
  readonly session?: AgentSession;
  readonly resumeSession?: AgentSession;
  readonly stepLogPath?: string;
  readonly artifactScope?: ArtifactScope;
  /** Explicit: the registry travels with the run, it is never resolved here. */
  readonly registry: AgentBackendRegistry;
}

export interface AgentRunBudget {
  cwd?: string;
  runnerDir?: string;
  timeout?: number;
  budgetRemaining?: number;
  /** A ceiling governs the run and `--allow-unmetered` was not given: a backend
   *  that can prove its live usage unpriceable stops the attempt. */
  strictCostAccounting?: boolean;
  role?: string;
  /** Default fix intent for attempts passing through this path. */
  intent?: AgentIntent;
  session?: AgentSession;
  resumeSession?: AgentSession;
  stepLogPath?: string;
  /** Same imposed scope as the repaired step: a fix writes the same artifacts and
   * cannot infer their location from convention. */
  artifactScope?: ArtifactScope;
  /** Explicit: the registry travels with the run, it is never resolved here. */
  registry: AgentBackendRegistry;
}

/**
 * Step scope derived from context, so it applies to every agent step without an
 * author declaration. Outside a ticket (`--lint-config` or no work item), there
 * is no path to impose.
 */
export function artifactScopeFor(ctx?: PipelineContext): ArtifactScope | undefined {
  // `paths` is optional at runtime, not in the type: `executeStep` accepts a
  // partial context (tests, `noop` steps), and an exception here would kill the spawn.
  if (!ctx?.paths?.artifactsDir) return undefined;
  return {
    artifactsDir: ctx.paths.artifactsDir,
    ...(ctx.paths.workItemDir ? { workItemDir: ctx.paths.workItemDir } : {}),
  };
}

/** The registry a spawn runs on. A context is the only carrier: boot attaches it
 * and every derivation keeps it, so its absence is a composition bug. */
function agentRegistryFor(ctx: PipelineContext | undefined): AgentBackendRegistry {
  if (!ctx) throw new Error("no agent backend registry attached to the pipeline context; boot must attach one");
  return requireAgentBackendRegistry(ctx);
}

/** A session only reaches the backend that minted it: a Claude session is never
 *  sent to Codex, whatever the step now runs on. */
function resolveSession(provider: string, session: AgentSession | undefined): AgentSession | undefined {
  return session?.provider === provider ? session : undefined;
}

/**
 * Sole normalization point for what a backend returns, and the only place other
 * than the verdict parser where the `BLOCKED:` prefix is read.
 *
 * The internal backends compute `failCause` through `resolveVerdictOutcome`. An
 * extension backend (`boot/extensions.ts`) does not: it sets `failReason`
 * directly, and the prefix is how it asks for a clean stop without computing the
 * cause. Reading it here lets the step loop read `failCause` and nothing else.
 */
export function normalizeAgentResult(result: AgentResult): AgentResult {
  if (result.failCause || result.ok || !hasBlockedPrefix(result.failReason)) return result;
  return { ...result, failCause: "blocked" };
}

/** Resolve and invoke a backend with the runner's normalized agent request. */
export async function invokeBackend(input: InvokeBackendInput): Promise<AgentResult> {
  const backend = input.registry.resolve({ ...input.spec, options: input.options });
  const session = resolveSession(input.spec.id, input.session);
  const resumeSession = resolveSession(input.spec.id, input.resumeSession);
  const request: AgentRequest = {
    prompt: input.prompt,
    cwd: input.cwd,
    runnerDir: input.runnerDir,
    role: input.role,
    intent: input.intent,
    outputFormat: input.outputFormat,
    ...(input.outputFields ? { outputFields: input.outputFields } : {}),
    options: input.options,
    timeoutMs: input.timeoutMs,
    budgetRemaining: input.budgetRemaining,
    strictCostAccounting: input.strictCostAccounting,
    session,
    resumeSession,
    stepLogPath: input.stepLogPath,
    artifactScope: input.artifactScope,
  };
  return normalizeAgentResult(await backend.run(request));
}

function invokeBackendWithBudget(
  prompt: string,
  spec: BackendSpec,
  options: unknown,
  budget: AgentRunBudget,
  overrides: Pick<InvokeBackendInput, "intent" | "outputFormat" | "outputFields"> = {},
): Promise<AgentResult> {
  return invokeBackend({
    spec,
    prompt,
    cwd: budget.cwd,
    runnerDir: budget.runnerDir,
    role: budget.role,
    intent: overrides.intent ?? budget.intent,
    outputFormat: overrides.outputFormat,
    outputFields: overrides.outputFields,
    options,
    timeoutMs: budget.timeout ?? DEFAULT_PROCESS_TIMEOUT_MS,
    budgetRemaining: budget.budgetRemaining,
    strictCostAccounting: budget.strictCostAccounting,
    session: budget.session,
    resumeSession: budget.resumeSession,
    stepLogPath: budget.stepLogPath,
    artifactScope: budget.artifactScope,
    registry: budget.registry,
  });
}

export async function executeStep(
  step: RunStep,
  command: string,
  budget?: {
    timeout?: number;
    budgetRemaining?: number;
    strictCostAccounting?: boolean;
    session?: AgentSession;
    resumeSession?: AgentSession;
    stepLogPath?: string;
    agentOptions?: unknown;
  },
  ctx?: PipelineContext,
): Promise<StepResult> {
  if (step.def.runner === "noop") {
    return { ok: true, output: "", stats: { duration_ms: 0 } };
  }
  if (step.def.runner === "fn") {
    const start = Date.now();
    try {
      const output = await step.def.action!(ctx!);
      return { ok: true, output: output ?? "", stats: { duration_ms: Date.now() - start } };
    } catch (e) {
      const message = errorMessage(e);
      return {
        ok: false,
        output: message,
        failReason: message,
        stats: { duration_ms: Date.now() - start },
      };
    }
  }
  if (step.def.runner === "bash") {
    const start = Date.now();
    await discardStaleReports(step);
    const timeoutMs = step.def.timeout ? step.def.timeout * 1000 : (budget?.timeout ?? DEFAULT_BASH_TIMEOUT_MS);
    const result = await runBashStreaming(command, { timeoutMs, stepLogPath: budget?.stepLogPath });
    return { ...result, stats: { duration_ms: Date.now() - start } };
  }
  const spec = backendSpecForStep(step.def);
  if (!spec) {
    return {
      ok: false,
      output: `No agent runner found for step "${step.def.id}"`,
      failReason: `No agent runner found for step "${step.def.id}"`,
      stats: { duration_ms: 0 },
    };
  }
  // Override options (for example, an escalated rerun model) take precedence over
  // step options.
  const options = budget?.agentOptions ?? spec.options;
  const timeoutMs = step.def.timeout ? step.def.timeout * 1000 : (budget?.timeout ?? DEFAULT_PROCESS_TIMEOUT_MS);
  const result = await invokeBackendWithBudget(
    command,
    spec,
    options,
    {
      ...budget,
      cwd: ctx?.cwd,
      runnerDir: ctx?.runnerDir,
      role: step.profile,
      timeout: timeoutMs,
      artifactScope: artifactScopeFor(ctx),
      registry: agentRegistryFor(ctx),
    },
    { intent: "step", outputFormat: step.def.output_format, outputFields: outputFieldsOf(step.def) },
  );
  return { ...result, stats: result.stats };
}

/** Captured fields of a step, as the backend request declares them. `undefined`
 *  without any capture: the verdict schema and instruction stay exactly what they
 *  were before `capture` existed. */
export function outputFieldsOf(def: Pick<PipelineStep, "captures">): AgentRequest["outputFields"] {
  if (!def.captures?.length) return undefined;
  return Object.fromEntries(def.captures.map((capture) => [capture.field, capture.schema]));
}

export async function runWithAgent(
  prompt: string,
  spec: BackendSpec,
  options: unknown,
  budget: AgentRunBudget,
): Promise<{
  ok: boolean;
  stats: AttemptStats;
  session?: AgentSession;
  failReason?: string;
  budgetExceeded?: boolean;
  costUnaccounted?: boolean;
}> {
  const result = await invokeBackendWithBudget(prompt, spec, options, budget, {
    intent: budget.intent ?? "fix",
    outputFormat: "text",
  });
  return {
    ok: result.ok,
    stats: result.stats,
    ...(result.session ? { session: result.session } : {}),
    ...(result.failReason ? { failReason: result.failReason } : {}),
    // A repair pass spends like a step: both cost stops must reach the ledger
    // from here, or a fix loop would keep repairing a run that already stopped.
    ...(result.budgetExceeded ? { budgetExceeded: true } : {}),
    ...(result.costUnaccounted ? { costUnaccounted: true } : {}),
  };
}
