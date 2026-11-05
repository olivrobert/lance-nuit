import type { AgentResult } from "../../../contracts/index.js";
import { verdictFromStructured } from "../../../contracts/index.js";
import { agentSession, killFields, resolveVerdictOutcome } from "../result-helpers.js";
import { type ParsedCodexEvents, parseCodexEvents } from "./events.js";
import { computeCostUsd } from "./pricing.js";
import type { CodexOptions, RawCodexExecutionResult } from "./types.js";
import { parseStructuredOutput } from "./verdict.js";

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
  const structured = options.outputFormat === "json" ? parseStructuredOutput(parsed) : {};
  const verdictDetails = structured.value != null ? verdictFromStructured(structured.value) : undefined;
  const { ok, failReason, failKind, failCause } = resolveVerdictOutcome({
    killed: raw.killed,
    killReason: raw.killReason,
    code: raw.code,
    // Codex stream errors are transport breaks and carry no stop signal of their
    // own: no `cause`. Nothing here encodes one in the message either.
    error: parsed.error ? { text: parsed.error } : undefined,
    requiresVerdict: options.outputFormat === "json",
    verdict: verdictDetails?.verdict,
    invalidReason: structured.invalidReason ?? verdictDetails?.invalidReason,
    missingVerdictLabel: "no Codex verdict",
  });
  const session = agentSession("codex", parsed.sessionId, !options.ephemeral);
  return {
    provider: "codex",
    output: parsed.text,
    ok,
    stats: buildStats(parsed, raw.durationMs),
    ...(session ? { session } : {}),
    ...(structured.value != null ? { structuredOutput: structured.value } : {}),
    ...killFields(raw.killed, raw.killReason),
    ...(failReason ? { failReason } : {}),
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
  };
}
