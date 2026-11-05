import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentCapabilities,
  AgentRequest,
  AgentResult,
  AgentSession,
} from "../../../contracts/index.js";
import { verdictSchema } from "../verdict-instruction.js";
import { buildCodexArgs } from "./args.js";
import { createRunnerCodexHost } from "./codex-host.js";
import { executeCodex } from "./execution.js";
import { MODEL_PRICING } from "./pricing.js";
import { mapCodexExecutionResult } from "./result.js";
import type { CodexBackendHost, CodexOptions } from "./types.js";

export const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: true,
  resume: true,
  usageTokens: true,
  cost: "estimable",
  configurationAxes: ["model", "effort"],
};

/** Bare verdict schema, without captured fields. The one written to `--output-schema`
 *  is `verdictSchema(request.outputFields)`; see `verdict-instruction.ts` for the
 *  strict-mode rules (`required` derived from `properties`, `null` for optional). */
export const VERDICT_SCHEMA = verdictSchema();

function schemaPath(): string {
  return join(tmpdir(), `runner-codex-verdict-${process.pid}-${Date.now()}.json`);
}

export function createCodexBackend(
  options: CodexOptions = {},
  host: CodexBackendHost = createRunnerCodexHost(),
): AgentBackend {
  return new CodexBackend(options, host);
}

export class CodexBackend implements AgentBackend {
  readonly id = "codex";

  readonly capabilities = capabilities;

  readonly applyEscalation = (
    options: unknown,
    escalation: { rung: "none" | "effort" | "model"; model?: string; effort?: string },
  ): unknown => {
    if (escalation.rung === "effort" && escalation.effort) {
      return { ...((options ?? {}) as CodexOptions), effort: escalation.effort as CodexOptions["effort"] };
    }
    if (escalation.rung === "model" && escalation.model)
      return { ...((options ?? {}) as CodexOptions), model: escalation.model };
    return options;
  };

  readonly applyConfigAxes = (options: unknown, axes: { model?: string; effort?: string }): unknown => ({
    ...((options ?? {}) as CodexOptions),
    ...(axes.model !== undefined ? { model: axes.model } : {}),
    ...(axes.effort !== undefined ? { effort: axes.effort as CodexOptions["effort"] } : {}),
  });

  readonly resumeHint = (session: AgentSession): string => `codex exec resume ${session.id}`;

  constructor(
    private readonly defaults: CodexOptions = {},
    private readonly host: CodexBackendHost = createRunnerCodexHost(),
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const options =
      request.options && typeof request.options === "object" ? (request.options as CodexOptions) : this.defaults;
    const resumeSession = request.resumeSession?.provider === this.id ? request.resumeSession : undefined;
    const schema = request.outputFormat === "json" ? schemaPath() : undefined;
    if (schema) writeFileSync(schema, JSON.stringify(verdictSchema(request.outputFields)));
    const args = buildCodexArgs(request.prompt, options, {
      outputFormat: request.outputFormat,
      cwd: request.cwd,
      sessionId: request.session?.id,
      resumeSessionId: resumeSession?.id,
      schemaPath: schema,
      artifactScope: request.artifactScope,
    });
    const bin = options.bin ?? process.env.CODEX_BIN ?? "codex";
    try {
      this.host.onSpawn?.({
        type: "agent-spawn",
        provider: this.id,
        ...(options.model ? { model: options.model } : {}),
        timestamp: Date.now(),
      });
      const raw = await executeCodex(
        {
          bin,
          args,
          cwd: request.cwd,
          model: options.model,
          timeoutMs: request.timeoutMs,
          budgetRemaining: request.budgetRemaining,
          strictCostAccounting: request.strictCostAccounting,
          stepLogPath: request.stepLogPath,
        },
        this.host,
      );
      return mapCodexExecutionResult(raw, {
        outputFormat: request.outputFormat,
        model: options.model,
        ephemeral: options.ephemeral,
      });
    } finally {
      if (schema) {
        try {
          unlinkSync(schema);
        } catch {}
      }
    }
  }
}

export function createCodexBackendFactory(host: CodexBackendHost = createRunnerCodexHost()): AgentBackendFactory {
  return {
    id: "codex",
    capabilities,
    usage: { pricing: MODEL_PRICING, inputIncludesCached: true },
    create(options) {
      return createCodexBackend(options && typeof options === "object" ? (options as CodexOptions) : {}, host);
    },
  };
}

/** Default factory for consumers that do not need a runner host. */
export const codexBackendFactory = createCodexBackendFactory();
