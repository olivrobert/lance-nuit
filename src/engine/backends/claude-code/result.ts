import type { AgentResult } from "../../../contracts/index.js";
import { extractVerdictDetails, type VerdictDetails, verdictFromStructured } from "../../../contracts/index.js";
import { agentSession, killFields, resolveVerdictOutcome, type VerdictOutcomeError } from "../result-helpers.js";
import { netCumulative } from "./cost-state.js";
import { type ClaudeTransportError, isAuthFailure, parseClaudeEvents } from "./events.js";
import type { RawClaudeExecutionResult } from "./types.js";
export interface ClaudeResultOptions {
  outputFormat?: "text" | "json";
  model?: string;
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
 * fix attempts on a backend that cannot talk to its provider at all. The cause is
 * a field, not a prefix on the message: the report prints that message.
 */
function failReasonFor(error: ClaudeTransportError): VerdictOutcomeError {
  const text = summary(error);
  return isAuthFailure(error) ? { text, cause: "blocked" } : { text };
}

export function mapClaudeExecutionResult(
  raw: RawClaudeExecutionResult,
  options: ClaudeResultOptions = {},
): AgentResult {
  const parsed = parseClaudeEvents(raw.output, options.model);
  // A resumed spawn reports the session ledger the CLI restored, not its own work.
  // Charge the difference against that baseline — the reconciliation the
  // orchestrator already applies to child runs — before anything else adds to it.
  const baseline = raw.resumeBaseline;
  if (baseline) {
    // An estimated cost is computed from THIS process's tokens, so it carries no
    // ancestor spend to net out.
    if (parsed.stats.total_cost_usd != null && parsed.stats.cost_estimated !== true) {
      parsed.stats.total_cost_usd = netCumulative(parsed.stats.total_cost_usd, baseline.costUsd);
    }
    if (parsed.stats.duration_api_ms != null && baseline.apiDurationMs != null) {
      parsed.stats.duration_api_ms = netCumulative(parsed.stats.duration_api_ms, baseline.apiDurationMs);
    }
    if (parsed.turnsInProcess > 0) parsed.stats.num_turns = parsed.turnsInProcess;
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
  const structured = parsed.structuredOutput != null;
  const source = structured ? "StructuredOutput" : "json:verdict block";
  const verdictResult: VerdictDetails = structured
    ? verdictFromStructured(parsed.structuredOutput)
    : extractVerdictDetails(parsed.text);
  if (parsed.transportError && !raw.killed) options.log?.(`  ⚠ ${summary(parsed.transportError)}`);
  const { ok, failReason, failKind, failCause } = resolveVerdictOutcome({
    killed: raw.killed,
    killReason: raw.killReason,
    code: raw.code,
    error: parsed.transportError ? failReasonFor(parsed.transportError) : undefined,
    requiresVerdict: options.outputFormat === "json",
    verdict: verdictResult.verdict,
    ...(verdictResult.invalidReason ? { invalidReason: `${source}: ${verdictResult.invalidReason}` } : {}),
    missingVerdictLabel: "no verdict in agent output (neither StructuredOutput nor a json:verdict block)",
    ...(options.log ? { log: options.log } : {}),
  });
  const id = parsed.sessionId ?? options.sessionId ?? options.resumeSessionId;
  const session = agentSession("claude", id);
  // A verdict read from the fence is structured output too: its extra fields
  // (`capture`) would otherwise be lost, since the normalized verdict keeps only
  // success/reason/blocked. The raw object is what the runner reads them from.
  const structuredOutput = structured ? parsed.structuredOutput : verdictResult.raw;
  return {
    provider: "claude",
    output: parsed.text,
    ok,
    stats: parsed.stats,
    ...(session ? { session } : {}),
    ...(structuredOutput != null ? { structuredOutput } : {}),
    ...killFields(raw.killed, raw.killReason),
    ...(failReason ? { failReason } : {}),
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
  };
}
