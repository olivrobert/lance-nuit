import type { Environment } from "./args.js";
import { type ClaudeResumeBaseline, netCumulative, readSessionCostBaseline } from "./cost-state.js";
import { type ClaudeParsedEvents, isOverloaded } from "./events.js";
import type { ClaudeExecutionOptions, RawClaudeExecutionResult } from "./types.js";

const DEFAULT = [30000, 120000];
export function transportBackoffDelays(env: Environment = process.env): number[] {
  const raw = env.RUNNER_TRANSPORT_BACKOFF_MS;
  if (raw == null) return DEFAULT;
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x >= 0);
}
export function retryOptionsForSession(
  options: ClaudeExecutionOptions,
  exists: (id: string) => boolean = () => false,
): ClaudeExecutionOptions {
  const id = options.args.find((_v, i) => options.args[i - 1] === "--session-id");
  if (!id || !exists(id)) return options;
  const args = [...options.args],
    i = args.indexOf("--session-id");
  args.splice(i, 2, "--resume", id);
  return { ...options, args };
}
/** Session id of a `--resume` spawn; undefined for a fresh session. */
export function resumeSessionIdOf(args: readonly string[]): string | undefined {
  const i = args.indexOf("--resume");
  return i >= 0 ? args[i + 1] : undefined;
}

export async function executeClaudeWithTransportRetry(
  options: ClaudeExecutionOptions,
  execute: (o: ClaudeExecutionOptions) => Promise<RawClaudeExecutionResult>,
  parse: (raw: string) => Pick<ClaudeParsedEvents, "transportError" | "stats">,
  delays = transportBackoffDelays(),
  sessionExists: (id: string) => boolean = () => false,
  readBaseline: (id: string) => ClaudeResumeBaseline | null = (id) => readSessionCostBaseline(id),
): Promise<RawClaudeExecutionResult> {
  let attempt = options;
  // Tokens burned by attempts discarded before an overload are real spend:
  // carry their cost forward so the budget ledger and stats still see it.
  let priorCost = 0;
  // Ledger the session must hold after the attempts already charged: the baseline
  // the previous spawn restored plus what it reported on top. Zero until a spawn
  // has run, or when the first spawn was a fresh session.
  let expectedLedger = 0;
  for (let i = 0; ; i++) {
    // Read the session ledger just before the spawn that will restore it. The
    // floor at `expectedLedger` covers a retry whose predecessor has not flushed
    // its `cost-state` yet: that spend is already charged here, so it must be
    // netted out of the cumulative figure the resumed process reports either way.
    // The floor is NOT `priorCost` alone: when the first spawn was itself a
    // `--resume` (a fix pass on the coder session), the ledger already held that
    // session's history, and a floor below it would charge the discarded attempt a
    // second time through the difference.
    const resumeId = resumeSessionIdOf(attempt.args);
    const persisted = resumeId ? readBaseline(resumeId) : null;
    const baseline: ClaudeResumeBaseline | undefined = resumeId
      ? {
          costUsd: Math.max(persisted?.costUsd ?? 0, expectedLedger),
          ...(persisted?.apiDurationMs != null ? { apiDurationMs: persisted.apiDurationMs } : {}),
        }
      : undefined;
    const result = await execute(baseline ? { ...attempt, sessionCostBaselineUsd: baseline.costUsd } : attempt),
      parsed = parse(result.output),
      error = parsed.transportError;
    const finish = (): RawClaudeExecutionResult => ({
      ...result,
      ...(priorCost > 0 ? { priorAttemptsCostUsd: priorCost } : {}),
      ...(baseline ? { resumeBaseline: baseline } : {}),
    });
    if (!error || !isOverloaded(error) || i >= delays.length) return finish();
    // What THIS attempt spent, not what the session has spent: a resumed attempt
    // reports the cumulative ledger, and charging that would repay its ancestors.
    const reported = parsed.stats.total_cost_usd ?? 0;
    const estimated = parsed.stats.cost_estimated === true;
    const attemptCost = baseline && !estimated ? netCumulative(reported, baseline.costUsd) : reported;
    // A transport retry is fresh paid work. If this attempt consumed the whole
    // remaining allowance, return its overload result instead of spawning once
    // more with a zero-dollar budget and overspending before the first usage tick.
    if (attempt.budgetRemaining != null && attemptCost >= attempt.budgetRemaining) return finish();
    priorCost += attemptCost;
    // An estimated cost was computed from tokens the CLI never wrote to its
    // ledger (no `result` event), so the ledger did not move.
    expectedLedger = (baseline?.costUsd ?? 0) + (estimated ? 0 : attemptCost);
    await new Promise((r) => setTimeout(r, delays[i]));
    attempt = retryOptionsForSession(attempt, sessionExists);
    // The next spawn publishes its live estimate on top of this: an abort during
    // the retry must charge the discarded attempts too, not only the current one.
    if (priorCost > 0) attempt = { ...attempt, priorAttemptsCostUsd: priorCost };
    if (attempt.budgetRemaining != null && attemptCost > 0) {
      attempt = { ...attempt, budgetRemaining: Math.max(0, attempt.budgetRemaining - attemptCost) };
    }
  }
}
