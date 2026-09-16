import type { AgentResult } from "../../../contracts/index.js";
import { verdictFromStructured } from "../../../contracts/index.js";
import { agentSession, killFields, resolveVerdictOutcome } from "../result-helpers.js";
import { type ParsedOpencodeEvents, parseOpencodeEvents, parseOpencodeLogErrors } from "./events.js";
import { resolveOpencodeCost } from "./pricing.js";
import type { RawOpencodeExecutionResult } from "./types.js";
import { parseStructuredOutput } from "./verdict.js";

export interface OpencodeResultOptions {
  outputFormat?: "text" | "json";
  model?: string;
  ephemeral?: boolean;
}

function buildStats(parsed: ParsedOpencodeEvents, durationMs: number, model?: string): AgentResult["stats"] {
  // `cost: 0` on a run that spent tokens is opencode admitting it cannot price
  // the model, so it opens the estimate path just like an absent cost does.
  const cost = resolveOpencodeCost(
    { costReported: parsed.costReported, costUsd: parsed.costUsd },
    {
      input_tokens: parsed.inputTokens,
      cache_read_tokens: parsed.cacheReadTokens,
      cache_creation_tokens: parsed.cacheCreationTokens,
      output_tokens: parsed.outputTokens,
    },
    model,
  );
  return {
    duration_ms: durationMs,
    provider: "opencode",
    // The events never echo the model, so the requested one is the only name available.
    ...(model ? { model } : {}),
    ...(parsed.turns > 0 ? { num_turns: parsed.turns } : {}),
    ...(parsed.inputTokens != null ? { input_tokens: parsed.inputTokens } : {}),
    ...(parsed.outputTokens != null ? { output_tokens: parsed.outputTokens } : {}),
    ...(parsed.cacheReadTokens != null ? { cache_read_tokens: parsed.cacheReadTokens } : {}),
    ...(parsed.cacheCreationTokens != null ? { cache_creation_tokens: parsed.cacheCreationTokens } : {}),
    ...(parsed.reasoningTokens != null ? { reasoning_tokens: parsed.reasoningTokens } : {}),
    ...(cost.costUsd != null ? { total_cost_usd: cost.costUsd } : {}),
    ...(cost.estimated ? { cost_estimated: true } : {}),
    ...(cost.unknown ? { cost_unknown: true } : {}),
    // Occupancy without a window: opencode reports `tokens.total` but never the
    // model window, and guessing one is how a 1M-context run reads as 5× full.
    ...(parsed.lastContextTokens != null ? { last_turn_context_tokens: parsed.lastContextTokens } : {}),
    ...(parsed.toolsUsed.length > 0 ? { tools_used: parsed.toolsUsed } : {}),
  };
}

export function mapOpencodeExecutionResult(
  raw: RawOpencodeExecutionResult,
  options: OpencodeResultOptions = {},
): AgentResult {
  const parsed = parseOpencodeEvents(raw.output);
  // stderr is the only place a silently retried `stream error` is ever written:
  // without it a billing or upstream failure looks like an empty success.
  const logError = parsed.error ? undefined : parseOpencodeLogErrors(raw.logs);
  const error = parsed.error ?? logError;
  const structured = options.outputFormat === "json" ? parseStructuredOutput(parsed) : {};
  const verdictDetails = structured.value != null ? verdictFromStructured(structured.value) : undefined;
  const { ok, failReason, failKind, failCause } = resolveVerdictOutcome({
    killed: raw.killed,
    killReason: raw.killReason,
    code: raw.code,
    // Stream and stderr errors are transport breaks and carry no stop signal of
    // their own: no `cause`. Nothing here encodes one in the message either.
    error: error ? { text: error } : undefined,
    requiresVerdict: options.outputFormat === "json",
    verdict: verdictDetails?.verdict,
    invalidReason: structured.invalidReason ?? verdictDetails?.invalidReason,
    missingVerdictLabel: "no opencode verdict",
  });
  const session = agentSession("opencode", parsed.sessionId, !options.ephemeral);
  return {
    provider: "opencode",
    output: parsed.text,
    ok,
    stats: buildStats(parsed, raw.durationMs, options.model),
    ...(session ? { session } : {}),
    ...(structured.value != null ? { structuredOutput: structured.value } : {}),
    ...killFields(raw.killed, raw.killReason),
    ...(failReason ? { failReason } : {}),
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
  };
}
