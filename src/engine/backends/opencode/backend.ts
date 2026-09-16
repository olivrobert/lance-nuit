import type {
  AgentBackend,
  AgentBackendFactory,
  AgentCapabilities,
  AgentRequest,
  AgentResult,
  AgentSession,
} from "../../../contracts/index.js";
import { buildOpencodeArgs, buildOpencodeEnv } from "./args.js";
import { ensureOpencodeConfig } from "./config.js";
import { executeOpencode } from "./execution.js";
import { createRunnerOpencodeHost } from "./opencode-host.js";
import { MODEL_PRICING } from "./pricing.js";
import { mapOpencodeExecutionResult } from "./result.js";
import { OPENCODE_AGENT, type OpencodeAgent, type OpencodeBackendHost, type OpencodeOptions } from "./types.js";

export const capabilities: AgentCapabilities = {
  // No `--output-schema` and no StructuredOutput tool: the verdict is asked for in
  // the prompt and read back from the text. The contract is "produces a structured
  // verdict", and `validation/output-contract.ts` refuses anything less for llmSteps.
  structuredOutput: true,
  streaming: true,
  resume: true,
  usageTokens: true,
  // Every step reports its own `cost`, from the provider. Nothing is estimated.
  cost: "exact",
  configurationAxes: ["model", "effort"],
};

/** A model never called before can take over 60s to warm up, then answer in 1.4s. */
export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;

/**
 * Roles that must not touch the working tree get the read-only agent, and
 * text-to-JSON roles get the toolless one (184 input tokens against ~6556).
 * opencode has no per-invocation permission flag: the agent IS the permission.
 */
const AGENT_FOR_ROLE: Readonly<Record<string, OpencodeAgent>> = {
  extractor: OPENCODE_AGENT.BARE,
  triage: OPENCODE_AGENT.BARE,
  relay: OPENCODE_AGENT.BARE,
  reviewer: OPENCODE_AGENT.READ_ONLY,
  planner: OPENCODE_AGENT.READ_ONLY,
};

function agentForRole(role: string | undefined): OpencodeAgent {
  return (role && AGENT_FOR_ROLE[role]) || OPENCODE_AGENT.RUNNER;
}

export function createOpencodeBackend(
  options: OpencodeOptions = {},
  host: OpencodeBackendHost = createRunnerOpencodeHost(),
): AgentBackend {
  return new OpencodeBackend(options, host);
}

export class OpencodeBackend implements AgentBackend {
  readonly id = "opencode";

  readonly capabilities = capabilities;

  readonly applyEscalation = (
    options: unknown,
    escalation: { rung: "none" | "effort" | "model"; model?: string; effort?: string },
  ): unknown => {
    if (escalation.rung === "effort" && escalation.effort) {
      return { ...((options ?? {}) as OpencodeOptions), effort: escalation.effort as OpencodeOptions["effort"] };
    }
    if (escalation.rung === "model" && escalation.model)
      return { ...((options ?? {}) as OpencodeOptions), model: escalation.model };
    return options;
  };

  readonly applyConfigAxes = (options: unknown, axes: { model?: string; effort?: string }): unknown => ({
    ...((options ?? {}) as OpencodeOptions),
    ...(axes.model !== undefined ? { model: axes.model } : {}),
    ...(axes.effort !== undefined ? { effort: axes.effort as OpencodeOptions["effort"] } : {}),
  });

  readonly resumeHint = (session: AgentSession): string => `opencode run -s ${session.id}`;

  constructor(
    private readonly defaults: OpencodeOptions = {},
    private readonly host: OpencodeBackendHost = createRunnerOpencodeHost(),
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const requested =
      request.options && typeof request.options === "object" ? (request.options as OpencodeOptions) : this.defaults;
    // The runner owns its config rather than inheriting the user's: it is the only
    // way to get an explicit system prompt and a per-role tool policy.
    const options: OpencodeOptions = {
      ...requested,
      agent: requested.agent ?? agentForRole(request.role),
      configPath: requested.configPath ?? ensureOpencodeConfig(),
    };
    const resumeSession = request.resumeSession?.provider === this.id ? request.resumeSession : undefined;
    const args = buildOpencodeArgs(request.prompt, options, {
      outputFormat: request.outputFormat,
      outputFields: request.outputFields,
      cwd: request.cwd,
      resumeSessionId: resumeSession?.id,
      fork: options.fork ?? request.intent === "fix",
      artifactScope: request.artifactScope,
    });
    const bin = options.bin ?? process.env.OPENCODE_BIN ?? "opencode";
    this.host.onSpawn?.({
      type: "agent-spawn",
      provider: this.id,
      ...(options.model ? { model: options.model } : {}),
      timestamp: Date.now(),
    });
    const raw = await executeOpencode(
      {
        bin,
        args,
        env: buildOpencodeEnv(options, process.env),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
        firstEventTimeoutMs: options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS,
        ...(request.budgetRemaining != null ? { budgetRemaining: request.budgetRemaining } : {}),
        ...(request.strictCostAccounting === true ? { strictCostAccounting: true } : {}),
        ...(request.stepLogPath ? { stepLogPath: request.stepLogPath } : {}),
      },
      this.host,
    );
    return mapOpencodeExecutionResult(raw, {
      ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  }
}

export function createOpencodeBackendFactory(
  host: OpencodeBackendHost = createRunnerOpencodeHost(),
): AgentBackendFactory {
  return {
    id: "opencode",
    capabilities,
    // Empty table and no `pricingFallback`: an unpriced model must surface as
    // `cost_unknown`, never as the rate of the most expensive model in the list.
    usage: { pricing: MODEL_PRICING },
    create(options) {
      return createOpencodeBackend(options && typeof options === "object" ? (options as OpencodeOptions) : {}, host);
    },
  };
}

/** Default factory for consumers that do not need a runner host. */
export const opencodeBackendFactory = createOpencodeBackendFactory();
