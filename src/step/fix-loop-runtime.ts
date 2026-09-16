import { type AgentBackend, type AgentSession, type BackendSpec, backendSpecForStep } from "../contracts/backends.js";
import { fixProfileOptions } from "../dsl/profiles.js";
import { extractErrors } from "../exec/report-extraction.js";
import { executeStep, runWithAgent } from "../exec/runners.js";
import { truncateMiddle } from "../lib/truncate.js";
import type { AgentBackendRegistry } from "../contracts/backends.js";
import { type FixContext, type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Run, RunStep } from "../model/run.js";
import type { AbortScope } from "../runtime/abort.js";
import type { RunOutput } from "../runtime/run-output.js";
import { deriveContext } from "../pipeline/context.js";
import type { RunBudget } from "../state/budget.js";

/** Fix-prompt context enriched with runner diagnostics and extracted errors. */
export function buildFixContext(
  base: PipelineContext,
  stepOutput: string,
  errors: string,
  reportPath?: string,
  lastFailReason?: string,
): FixContext {
  const mergedErrors = [lastFailReason?.trim(), errors.trim()].filter(Boolean).join("\n\n");
  // Preserve lazy/non-enumerable context dependencies. A spread would evaluate
  // `base.workItem` and permanently turn a lazy tracker lookup into an eager one.
  return Object.assign(deriveContext(base, {}), {
    stepOutput: truncateMiddle(stepOutput),
    errors: mergedErrors,
    reportPath,
  }) as FixContext;
}

export interface FixLoopDeps {
  executeStep: typeof executeStep;
  runWithAgent: typeof runWithAgent;
  extractErrors: typeof extractErrors;
  /** Registry used for session resume and escalation. Replaceable because session
   * size and resume behavior belong to the provider, not the loop. */
  registry?: AgentBackendRegistry;
}

const DEFAULT_DEPS: FixLoopDeps = { executeStep, runWithAgent, extractErrors };

export interface FixLoopOpts {
  /** `resumeSession: "<stepId>"`: id of the step whose recorded session hosts the
   * fix. Absent: the fix runs in a fresh session. */
  resumeSession?: string;
  deps?: FixLoopDeps;
  /** Structured step output destination. Required: `NULL_RUN_OUTPUT` is the way to
   * ask for a silent fix loop. */
  output: RunOutput;
  /** Abort scope consulted between passes. Required: `createAbortScope()` is the
   * way to ask for a loop only `run.aborted` can interrupt. */
  abort: AbortScope;
}

/** Values resolved once at entry: backends, prompt, limits, and dependencies. */
export interface FixRun {
  run: Run;
  step: RunStep;
  command: string;
  baseCtx: PipelineContext;
  budget: RunBudget;
  opts: FixLoopOpts;
  deps: FixLoopDeps;
  registry: AgentBackendRegistry;
  /** Step backend; absent for bash/noop steps that do not use an agent. */
  backend?: AgentBackend;
  fixSpec: BackendSpec;
  /** Log-ready reason for the backend choice. Emitted by the retry loop when a
   * repair actually starts, never at preparation time: announcing it here would
   * claim a repair that a spent quota or a cost stop never runs. */
  fixReason: string;
  fixBackend: AgentBackend;
  backendOptions: unknown;
  fixPrompt: NonNullable<RunStep["def"]["on_failure"]>["fix_prompt"];
  sizeThresholdKb: number;
  output: RunOutput;
  abort: AbortScope;
}

const RESUME_THRESHOLD_KB_DEFAULT = 1000;

/** Prepare repair session state without running a pass. */
export function prepareFixRun(
  run: Run,
  step: RunStep,
  command: string,
  baseCtx: PipelineContext,
  budget: RunBudget,
  opts: FixLoopOpts,
): FixRun {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const registry = deps.registry ?? requireAgentBackendRegistry(baseCtx);
  const failure = step.def.on_failure!;
  const stepSpec = backendSpecForStep(step.def);
  const choice = chooseFixBackend(run, step, baseCtx, registry, opts.resumeSession);
  const fixSpec = choice.spec;
  return {
    run,
    step,
    command,
    baseCtx,
    budget,
    opts,
    deps,
    registry,
    ...(stepSpec ? { backend: registry.resolve(stepSpec) } : {}),
    fixSpec,
    fixReason: choice.reason,
    fixBackend: registry.resolve(fixSpec),
    backendOptions: choice.options,
    fixPrompt: failure.fix_prompt!,
    sizeThresholdKb: failure.resume_size_threshold_kb ?? RESUME_THRESHOLD_KB_DEFAULT,
    output: opts.output,
    abort: opts.abort,
  };
}

/** Backend that runs the repair, its options, and a log-ready reason. */
export interface FixBackendChoice {
  spec: BackendSpec;
  /** Repair-agent options before escalation. */
  options: unknown;
  reason: string;
}

/**
 * Decide which backend repairs the step.
 *
 * An agent step keeps its own backend: `backend_options` were materialized for it
 * at load time. A `bash` step has no backend; without `resumeSession`, the default
 * provider repairs in a fresh session. With `resumeSession`, the repair must land
 * where the resumed step's session lives — a session cannot be injected into
 * another provider, and falling back to the default backend would silently throw
 * away the context that `resumeSession` was chosen to keep. Load-time options were
 * shaped for the default backend, so a switch re-reads `fix_profile` on the
 * retained backend and otherwise starts from that backend's defaults.
 */
export function chooseFixBackend(
  run: Run,
  step: RunStep,
  baseCtx: PipelineContext,
  registry: AgentBackendRegistry,
  resumeSession?: string,
): FixBackendChoice {
  const failure = step.def.on_failure!;
  const declared = backendSpecForStep(step.def);
  if (declared) {
    return { spec: declared, options: failure.backend_options ?? declared.options, reason: "declared by the step" };
  }
  // Validation refuses `fix_backend` with `resumeSession`, so this choice never
  // competes with the resumed session's provider.
  if (failure.fix_backend) {
    return {
      spec: { id: failure.fix_backend },
      options: failure.backend_options,
      reason: "declared by the fix policy (fresh fix session)",
    };
  }
  const fallback: FixBackendChoice = {
    spec: { id: registry.defaultBackendId() },
    options: failure.backend_options,
    reason: "default backend (fresh fix session)",
  };
  if (resumeSession === undefined) return fallback;
  const resumed = resumableSessionOf(run, resumeSession);
  if (!resumed) return { ...fallback, reason: `default backend (step "${resumeSession}" has no session)` };
  if (!registry.has(resumed.provider)) {
    return {
      ...fallback,
      reason: `default backend (session provider "${resumed.provider}" of step "${resumeSession}" is not registered)`,
    };
  }
  if (resumed.provider === fallback.spec.id) {
    return { ...fallback, reason: `default backend (already the provider of the session of "${resumeSession}")` };
  }
  const spec: BackendSpec = { id: resumed.provider };
  const role = failure.fix_profile;
  if (!role) return { spec, options: undefined, reason: `resumed session provider ("${resumeSession}")` };
  const profiled = fixProfileOptions(role, spec, undefined, baseCtx.config.profiles, registry);
  if (!profiled) {
    return {
      ...fallback,
      reason: `default backend (fix profile "${role}" has no policy for resumed session provider "${spec.id}")`,
    };
  }
  return {
    spec,
    options: profiled.options,
    reason: `resumed session provider ("${resumeSession}", fix profile "${role}")`,
  };
}

/** Session recorded by the step `stepId` of this run, if any. */
export function resumableSessionOf(run: Run, stepId: string): AgentSession | undefined {
  return run.steps.find((candidate) => candidate.def.id === stepId)?.session;
}

/** Select the session of the step named by `resumeSession`, and the resume decision. */
export function selectResumedSession(
  run: Run,
  fixSpec: { id: string },
  fixBackend: ReturnType<AgentBackendRegistry["resolve"]>,
  sizeThresholdKb: number,
  resumeSession: string | undefined,
  attemptLabel: string,
  output: RunOutput,
): { useResume: boolean; resumedSession: AgentSession | undefined } {
  if (resumeSession === undefined) return { useResume: false, resumedSession: undefined };
  const recorded = resumableSessionOf(run, resumeSession);
  // A Codex session cannot be injected into Claude, or vice versa. A pipeline may
  // change backend between steps, but conversation resume stays with its provider
  // (see chooseFixBackend for the bash-step case).
  const resumedSession = recorded?.provider === fixSpec.id ? recorded : undefined;
  if (!resumedSession) {
    output.emit({
      type: "runner.message",
      level: "warn",
      message: `  step "${resumeSession}" has no session — starting a fresh session`,
    });
    return { useResume: false, resumedSession };
  }
  const backendCanResume = fixBackend.capabilities.resume && resumedSession.resumable;
  // A backend without session-size lookup cannot be measured; treat it as 1KB so
  // resume remains allowed under any configured threshold.
  const sizeKb = fixBackend.sessionSizeKb?.(resumedSession) ?? 1;
  if (backendCanResume && sizeKb > 0 && sizeKb <= sizeThresholdKb) {
    output.emit({
      type: "runner.message",
      level: "info",
      message: `  → Resume session of "${resumeSession}" ${resumedSession.id} (${sizeKb}KB ≤ ${sizeThresholdKb}KB) — fix ${attemptLabel}`,
    });
    return { useResume: true, resumedSession };
  }
  output.emit({
    type: "runner.message",
    level: "warn",
    message:
      sizeKb > sizeThresholdKb
        ? `  Session of "${resumeSession}" too large (${sizeKb}KB > ${sizeThresholdKb}KB) — starting a fresh session`
        : `  Session of "${resumeSession}" ${resumedSession.id} not found — starting a fresh session`,
  });
  return { useResume: false, resumedSession };
}
