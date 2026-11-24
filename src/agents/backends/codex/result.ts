import type { AgentResult } from "../../../contracts/index.js";
import { agentSession, mapAgentResult, providerError } from "../result-helpers.js";
import { type ParsedCodexEvents, parseCodexEvents } from "./events.js";
import { computeCostUsd } from "./pricing.js";
import type { CodexOptions, RawCodexExecutionResult } from "./types.js";

export interface CodexResultOptions {
  outputFormat?: "text" | "json";
  model?: string;
  ephemeral?: CodexOptions["ephemeral"];
}

function buildStats(parsed: ParsedCodexEvents, durationMs: number): AgentResult["stats"] {
  const hasUsage = parsed.inputTokens != null || parsed.cachedInputTokens != null || parsed.outputTokens != null;
  const cost = hasUsage
    ? computeCostUsd(
        {
          input_tokens: parsed.inputTokens,
          cache_read_tokens: parsed.cachedInputTokens,
          output_tokens: parsed.outputTokens,
        },
        parsed.model,
      )
    : undefined;
  // Codex reports `input_tokens` INCLUDING `cached_input_tokens`; every other
  // backend reports the two apart. Normalize here so `input_tokens` means the same
  // thing everywhere: any reader adding `in` and `cacheRead` at their own rates —
  // `lancenuit stats`, the history projection — would otherwise bill the cache
  // twice on Codex runs. Pricing above still reads the raw figures.
  const billedInput =
    parsed.inputTokens != null ? Math.max(0, parsed.inputTokens - (parsed.cachedInputTokens ?? 0)) : undefined;
  return {
    duration_ms: durationMs,
    provider: "codex",
    model: parsed.model,
    num_turns: parsed.turns || undefined,
    input_tokens: billedInput,
    cache_read_tokens: parsed.cachedInputTokens,
    output_tokens: parsed.outputTokens,
    ...(parsed.reasoningTokens != null ? { reasoning_tokens: parsed.reasoningTokens } : {}),
    ...(cost != null ? { total_cost_usd: cost, cost_estimated: true } : {}),
    ...(parsed.toolsUsed.length > 0 ? { tools_used: parsed.toolsUsed } : {}),
  };
}

export function mapCodexExecutionResult(raw: RawCodexExecutionResult, options: CodexResultOptions = {}): AgentResult {
  const parsed = parseCodexEvents(raw.output, options.model);
  const session = agentSession("codex", parsed.sessionId, !options.ephemeral);
  return mapAgentResult({
    provider: "codex",
    // `--output-schema` constrains the final message, read by the shared cascade.
    source: { text: parsed.text, ...(parsed.finalMessage != null ? { finalMessage: parsed.finalMessage } : {}) },
    outputFormat: options.outputFormat,
    stats: buildStats(parsed, raw.durationMs),
    ...(session ? { session } : {}),
    kill: raw.kill,
    code: raw.code,
    ...(parsed.error ? { error: providerError(parsed.error) } : {}),
    missingVerdictLabel: "no Codex verdict",
  });
}
