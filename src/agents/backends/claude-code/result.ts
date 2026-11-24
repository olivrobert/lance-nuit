import type { AgentResult } from "../../../contracts/index.js";
import { agentSession, mapAgentResult, type VerdictOutcomeError } from "../result-helpers.js";
import { attemptCostUsd, netCumulative } from "./cost-state.js";
import { type ClaudeTransportError, isAuthFailure, isRateLimited } from "./events.js";
import type { RawClaudeExecutionResult } from "./types.js";
export interface ClaudeResultOptions {
  outputFormat?: "text" | "json";
  sessionId?: string;
  resumeSessionId?: string;
  log?: (message: string) => void;
}

function summary(error: ClaudeTransportError): string {
  const head = error.message.split("\n")[0]?.trim() || "API error without a message";
  return error.status != null ? `API Claude ${error.status}: ${head}` : `API Claude: ${head}`;
}

/**
 * The fail reason the step loop classifies. An authentication failure carries
 * `cause: "blocked"` so the run stops like a `require` guard instead of spending
 * fix attempts on a backend that cannot talk to its provider at all. A usage limit
 * the transport did not wait out is blocked too: every repair would hit it again,
 * while a resume once the quota reopens replays the step. The cause is
 * a field, not a prefix on the message: the report prints that message.
 */
function failReasonFor(error: ClaudeTransportError): VerdictOutcomeError {
  const text = summary(error);
  if (isAuthFailure(error)) return { text, cause: "blocked" };
  if (!isRateLimited(error)) return { text };
  const reset = error.resetsAt != null ? ` (resets at ${new Date(error.resetsAt).toISOString()})` : "";
  return { text: `${text}${reset}`, cause: "blocked" };
}

export function mapClaudeExecutionResult(
  raw: RawClaudeExecutionResult,
  options: ClaudeResultOptions = {},
): AgentResult {
  const parsed = structuredClone(raw.stream);
  // `duration_ms` only arrives on the CLI's final `result` event, which a process
  // killed for timeout or budget never emits: fall back to the supervisor's clock.
  if (raw.kill || !parsed.stats.duration_ms) parsed.stats.duration_ms = raw.durationMs;
  if (raw.priorAttemptsDurationMs) parsed.stats.duration_ms += raw.priorAttemptsDurationMs;
  // A resumed spawn reports the session ledger the CLI restored, not its own work.
  // Charge the difference against that baseline — the reconciliation the
  // orchestrator already applies to child runs — before anything else adds to it.
  const baseline = raw.resumeBaseline;
  if (baseline) {
    if (parsed.stats.total_cost_usd != null) {
      parsed.stats.total_cost_usd = attemptCostUsd(
        { usd: parsed.stats.total_cost_usd, estimated: parsed.stats.cost_estimated === true },
        baseline.costUsd,
      );
    }
    if (parsed.stats.duration_api_ms != null && baseline.apiDurationMs != null) {
      parsed.stats.duration_api_ms = netCumulative(parsed.stats.duration_api_ms, baseline.apiDurationMs);
    }
    if (parsed.turnsInProcess > 0) parsed.stats.num_turns = parsed.turnsInProcess;
  }
  // No `result` event: what the ledger gained is the CLI's own price for every
  // message this process completed, where the token estimate undercounts output
  // and depends on a rate table. It still misses the message in flight at the
  // kill, so the figure stays flagged. A ledger that did not move (killed during
  // its first message, or before the CLI could write it) leaves the estimate.
  const settledSpend = (raw.settledLedgerUsd ?? 0) - (baseline?.costUsd ?? 0);
  if (settledSpend > 0) {
    parsed.stats.total_cost_usd = settledSpend;
    parsed.stats.cost_estimated = true;
  }
  // Fold in the spend of transport attempts discarded before an overload retry,
  // so budget enforcement and stats account for the full real cost.
  if (raw.priorAttemptsCostUsd) {
    // The final attempt may have died before any usage reached us (timeout,
    // straggler kill). Its own spend is then unmeasured: the sum below is a lower
    // bound, and the flag must say so, or the prior attempts' figure would pass
    // for the whole spawn's cost and the ledger would stop being a ceiling.
    if (parsed.stats.total_cost_usd == null) parsed.stats.cost_unknown = true;
    parsed.stats.total_cost_usd = (parsed.stats.total_cost_usd ?? 0) + raw.priorAttemptsCostUsd;
  }
  if (parsed.transportError && !raw.kill) options.log?.(`  ⚠ ${summary(parsed.transportError)}`);
  const session = agentSession("claude", parsed.sessionId ?? options.sessionId ?? options.resumeSessionId);
  return mapAgentResult({
    provider: "claude",
    source: { text: parsed.text, structuredOutput: parsed.structuredOutput },
    outputFormat: options.outputFormat,
    stats: parsed.stats,
    ...(session ? { session } : {}),
    kill: raw.kill,
    code: raw.code,
    ...(parsed.transportError ? { error: failReasonFor(parsed.transportError) } : {}),
    missingVerdictLabel: "no verdict in agent output (neither StructuredOutput nor a json:verdict block)",
    ...(options.log ? { log: options.log } : {}),
  });
}
