import type { Environment } from "./args.js";
import { attemptCostUsd, type ClaudeResumeBaseline, readSessionCostBaseline } from "./cost-state.js";
import { type ClaudeTransportError, isOverloaded, isRateLimited } from "./events.js";
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
// A subscription window lasts five hours: a night run that hits it mid-way can
// still finish once it reopens, so the default wait covers one whole window.
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// The announced reset is the provider's clock, not ours: spawning right on it
// risks a second refusal that would spend one of the few waits.
const RATE_LIMIT_MARGIN_MS = 60_000;
// Each wait ends on a fresh reset time; a provider that keeps announcing a past
// or imminent reset must not turn the attempt into a polling loop.
const MAX_RATE_LIMIT_WAITS = 3;

/** How long a rate-limited spawn may sleep until its quota reopens. */
export interface RateLimitWait {
  /** Ceiling on the total time slept for one attempt; `0` never waits. */
  maxWaitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}
export function rateLimitMaxWaitMs(env: Environment = process.env): number {
  const raw = env.RUNNER_RATE_LIMIT_MAX_WAIT_MS?.trim();
  if (!raw) return DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
}
export function defaultRateLimitWait(log?: (message: string) => void): RateLimitWait {
  return {
    maxWaitMs: rateLimitMaxWaitMs(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(log ? { log } : {}),
  };
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

/** Session a spawn runs on, resumed or created; undefined when the CLI names it. */
function sessionIdOf(args: readonly string[]): string | undefined {
  const i = args.indexOf("--session-id");
  return resumeSessionIdOf(args) ?? (i >= 0 ? args[i + 1] : undefined);
}

/** The pause before the next spawn, or undefined when this error ends the attempt.
 *  Counts the overloads and rate-limit waits already spent on the attempt. */
function transportPauses(
  delays: readonly number[],
  rateLimit: RateLimitWait,
): (error: ClaudeTransportError | undefined) => number | undefined {
  let overloads = 0;
  let rateLimitWaits = 0;
  let rateLimitWaitedMs = 0;
  return (error) => {
    if (!error) return undefined;
    if (isOverloaded(error)) return overloads < delays.length ? delays[overloads++] : undefined;
    // Without a reset time the wait would be a guess: the error goes back to the
    // step, which stops the run as blocked.
    if (!isRateLimited(error) || error.resetsAt == null || rateLimitWaits >= MAX_RATE_LIMIT_WAITS) return undefined;
    const wait = Math.max(0, error.resetsAt - rateLimit.now()) + RATE_LIMIT_MARGIN_MS;
    if (rateLimitWaitedMs + wait > rateLimit.maxWaitMs) return undefined;
    rateLimitWaits++;
    rateLimitWaitedMs += wait;
    return wait;
  };
}

/**
 * The session ledger read just before the spawn that will restore it; undefined
 * for a fresh session. The floor at `expectedLedger` covers a retry whose
 * predecessor has not flushed its `cost-state` yet: that spend is already charged,
 * so it must be netted out of the cumulative figure the resumed process reports
 * either way. The floor is NOT the prior cost alone: when the first spawn was
 * itself a `--resume` (a fix pass on the coder session), the ledger already held
 * that session's history, and a floor below it would charge the discarded attempt
 * a second time through the difference.
 */
function resumeBaselineFor(
  args: readonly string[],
  readLedger: (id: string) => ClaudeResumeBaseline | null,
  expectedLedger: number,
): ClaudeResumeBaseline | undefined {
  const resumeId = resumeSessionIdOf(args);
  if (!resumeId) return undefined;
  const persisted = readLedger(resumeId);
  return {
    costUsd: Math.max(persisted?.costUsd ?? 0, expectedLedger),
    ...(persisted?.apiDurationMs != null ? { apiDurationMs: persisted.apiDurationMs } : {}),
  };
}

/** The next spawn after a transport error: resumed when the session exists, and
 *  carrying what the discarded attempts spent. The next spawn publishes its live
 *  estimate on top of `priorCost`, so an abort during the retry charges them too. */
function retryAttempt(
  attempt: ClaudeExecutionOptions,
  sessionExists: (id: string) => boolean,
  priorCost: number,
  attemptCost: number,
): ClaudeExecutionOptions {
  let next = retryOptionsForSession(attempt, sessionExists);
  if (priorCost > 0) next = { ...next, priorAttemptsCostUsd: priorCost };
  if (next.budgetRemaining != null && attemptCost > 0)
    next = { ...next, budgetRemaining: Math.max(0, next.budgetRemaining - attemptCost) };
  return next;
}

export async function executeClaudeWithTransportRetry(
  options: ClaudeExecutionOptions,
  execute: (o: ClaudeExecutionOptions) => Promise<RawClaudeExecutionResult>,
  delays = transportBackoffDelays(),
  sessionExists: (id: string) => boolean = () => false,
  readLedger: (id: string) => ClaudeResumeBaseline | null = (id) => readSessionCostBaseline(id),
  rateLimit: RateLimitWait = defaultRateLimitWait(),
): Promise<RawClaudeExecutionResult> {
  let attempt = options;
  const pauseAfter = transportPauses(delays, rateLimit);
  // Tokens burned by attempts discarded before an overload are real spend:
  // carry their cost forward so the budget ledger and stats still see it.
  let priorCost = 0;
  // Same for time: `durationMs` measures one spawn, the attempt lasted all of them.
  let priorDuration = 0;
  // Ledger the session must hold after the attempts already charged: the baseline
  // the previous spawn restored plus what it reported on top. Zero until a spawn
  // has run, or when the first spawn was a fresh session.
  let expectedLedger = 0;
  for (;;) {
    const baseline = resumeBaselineFor(attempt.args, readLedger, expectedLedger);
    const result = await execute(baseline ? { ...attempt, sessionCostBaselineUsd: baseline.costUsd } : attempt),
      parsed = result.stream,
      error = parsed.transportError;
    const finish = (): RawClaudeExecutionResult => {
      // A process killed before its `result` event (timeout, budget guard) priced
      // nothing on the stream, but the CLI still wrote its ledger on the way out.
      const unreported = parsed.stats.total_cost_usd == null || parsed.stats.cost_estimated === true;
      const sessionId = sessionIdOf(attempt.args) ?? parsed.sessionId;
      const settled = unreported && sessionId ? readLedger(sessionId) : null;
      return {
        ...result,
        ...(priorCost > 0 ? { priorAttemptsCostUsd: priorCost } : {}),
        ...(priorDuration > 0 ? { priorAttemptsDurationMs: priorDuration } : {}),
        ...(baseline ? { resumeBaseline: baseline } : {}),
        ...(settled ? { settledLedgerUsd: settled.costUsd } : {}),
      };
    };
    const pause = pauseAfter(error);
    if (pause === undefined) return finish();
    const estimated = parsed.stats.cost_estimated === true;
    const attemptCost = attemptCostUsd({ usd: parsed.stats.total_cost_usd, estimated }, baseline?.costUsd);
    // A transport retry is fresh paid work. If this attempt consumed the whole
    // remaining allowance, return its transport error instead of spawning once
    // more with a zero-dollar budget and overspending before the first usage tick.
    if (attempt.budgetRemaining != null && attemptCost >= attempt.budgetRemaining) return finish();
    priorCost += attemptCost;
    priorDuration += result.durationMs + pause;
    // A retried attempt did emit its `result`: an estimated cost means the CLI
    // priced it at $0 there, so the ledger did not move.
    expectedLedger = (baseline?.costUsd ?? 0) + (estimated ? 0 : attemptCost);
    // Only a rate-limited error carries `resetsAt`; an overload pause is short and silent.
    if (error?.resetsAt != null)
      rateLimit.log?.(
        `  ⏸ Claude usage limit reached — waiting until ${new Date(error.resetsAt).toLocaleTimeString()} before retrying`,
      );
    await rateLimit.sleep(pause);
    attempt = retryAttempt(attempt, sessionExists, priorCost, attemptCost);
  }
}
