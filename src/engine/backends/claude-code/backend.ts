import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentCapabilities,
  AgentIntent,
  AgentRequest,
  AgentResult,
  AgentSession,
} from "../../../contracts/index.js";
import { buildClaudeArgs } from "./args.js";
import { createRunnerClaudeHost } from "./claude-host.js";
import { readSessionCostBaseline } from "./cost-state.js";
import { parseClaudeEvents } from "./events.js";
import { executeClaude } from "./execution.js";
import { normalizeClaudeStepOptions } from "./normalize.js";
import { DEFAULT_PRICING_KEY, MODEL_PRICING } from "./pricing.js";
import { mapClaudeExecutionResult } from "./result.js";
import { findSessionFile, sessionFileSizeKb } from "./session.js";
import { executeClaudeWithTransportRetry } from "./transport.js";
import type { ClaudeBackendHost, ClaudeOptions, ClaudeStepOptions } from "./types.js";
export const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: true,
  resume: true,
  usageTokens: true,
  cost: "exact",
  configurationAxes: ["model", "effort"],
};
const FIX_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

function withIntent(o: ClaudeOptions | undefined, intent: AgentIntent | undefined): ClaudeOptions | undefined {
  return intent !== "fix" || o?.allowed_tools || o?.tools ? o : { ...(o ?? {}), allowed_tools: FIX_ALLOWED_TOOLS };
}

export class ClaudeBackend implements AgentBackend {
  readonly id = "claude";

  readonly capabilities = capabilities;

  readonly createSession = (): AgentSession => ({ provider: this.id, id: randomUUID(), resumable: true });

  readonly applyEscalation = (
    o: unknown,
    e: { rung: "none" | "effort" | "model"; model?: string; effort?: string },
  ): unknown =>
    e.rung === "effort" && e.effort
      ? { ...((o ?? {}) as ClaudeOptions), effort: e.effort as ClaudeOptions["effort"] }
      : e.rung === "model" && e.model
        ? { ...((o ?? {}) as ClaudeOptions), model: e.model }
        : o;

  readonly applyConfigAxes = (o: unknown, a: { model?: string; effort?: string }): unknown => ({
    ...((o ?? {}) as ClaudeOptions),
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.effort !== undefined ? { effort: a.effort as ClaudeOptions["effort"] } : {}),
  });

  readonly resumeHint = (s: AgentSession) => `claude --resume ${s.id}`;

  readonly sessionLocation = (s: AgentSession) => this.host.findSessionFile?.(s.id) ?? findSessionFile(s.id);

  private readonly locateSession = (id: string) => this.host.findSessionFile?.(id) ?? findSessionFile(id);

  readonly sessionSizeKb = (s: AgentSession) => this.host.sessionFileSizeKb?.(s.id) ?? sessionFileSizeKb(s.id);

  constructor(
    private readonly defaults: ClaudeOptions | undefined = undefined,
    private readonly host: ClaudeBackendHost = createRunnerClaudeHost(),
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const options = withIntent(
      request.options && typeof request.options === "object" ? (request.options as ClaudeOptions) : this.defaults,
      request.intent,
    );
    const requested = request.session?.provider === this.id ? request.session : undefined,
      resume = request.resumeSession?.provider === this.id ? request.resumeSession : undefined;
    const cwd = request.cwd ?? process.cwd(),
      roots = this.host.capabilityRoots?.(request.runnerDir ?? process.cwd(), cwd) ?? [];
    const args = buildClaudeArgs(request.prompt, {
      outputFormat: request.outputFormat,
      outputFields: request.outputFields,
      claudeOptions: options,
      cwd,
      capabilityRoots: roots,
      artifactScope: request.artifactScope,
      sessionId: requested?.id,
      resumeSessionId: resume?.id,
      forkResolver: this.host.isForkedSlashCommand,
      forkRelay: this.host.forkRelayPrompt,
    });
    const bin = process.env.CLAUDE_BIN ?? "claude";
    this.host.onSpawn?.({
      type: "agent-spawn",
      provider: this.id,
      ...(options?.model ? { model: options.model } : {}),
      timestamp: Date.now(),
    });
    const raw = await executeClaudeWithTransportRetry(
      {
        bin,
        args,
        cwd,
        claudeOptions: options,
        timeoutMs: request.timeoutMs,
        budgetRemaining: request.budgetRemaining,
        stepLogPath: request.stepLogPath,
      },
      (o) => executeClaude(o, this.host),
      (out) => parseClaudeEvents(out, options?.model),
      undefined,
      // A first attempt may have created the session on disk before the overload:
      // retrying with the same --session-id would be rejected by the CLI.
      (id) => this.locateSession(id) != null,
      (id) => readSessionCostBaseline(id, this.locateSession),
    );
    return mapClaudeExecutionResult(raw, {
      outputFormat: request.outputFormat,
      model: options?.model,
      sessionId: requested?.id,
      resumeSessionId: resume?.id,
      log: this.host.log,
    });
  }
}

export function createClaudeBackendFactory(host: ClaudeBackendHost = createRunnerClaudeHost()): AgentBackendFactory {
  return {
    id: "claude",
    capabilities,
    usage: { pricing: MODEL_PRICING, pricingFallback: DEFAULT_PRICING_KEY },
    normalizeAuthorOptions: (o) => normalizeClaudeStepOptions(o as ClaudeStepOptions | undefined),
    create: (o) => new ClaudeBackend(o && typeof o === "object" ? (o as ClaudeOptions) : undefined, host),
  };
}
export const claudeBackendFactory = createClaudeBackendFactory();
