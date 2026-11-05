import {
  type AgentSession,
  extractVerdictDetails,
  type StepFailCause,
  type StepFailKind,
  type Verdict,
  verdictFromStructured,
} from "../../contracts/index.js";

/** Common optional fields emitted by every process-backed agent mapper. */
export function agentSession(provider: string, id: string | undefined, resumable = true): AgentSession | undefined {
  return id ? { provider, id, resumable } : undefined;
}

/** Kill cause, read from the reason the supervisor recorded. A budget kill is a
 *  spend decision, not a technical break: keeping the two apart is what lets the
 *  report say "Budget exceeded" instead of "Technical error". */
export function killFields(
  killed: boolean,
  killReason: string | undefined,
): { timedOut?: boolean; budgetExceeded?: boolean; costUnaccounted?: boolean } {
  if (!killed) return {};
  return {
    timedOut: killReason?.startsWith("timeout") ?? false,
    ...(killReason?.startsWith("budget exceeded") ? { budgetExceeded: true } : {}),
    // The accounting guard's own prefix. Kept apart from the budget one so the
    // report can say "Spending unaccounted" and point at `--allow-unmetered`
    // instead of `--budget`, which cannot price a closed attempt.
    ...(killReason?.startsWith("cost unaccounted") ? { costUnaccounted: true } : {}),
  };
}

/**
 * Verdict-candidate cascade shared by process-backed agents, from the most
 * explicit shape to the most forgiving: the ```json:verdict fence, then the
 * stream's structured output (validated), then the whole text as one JSON
 * object. One order for every backend — the same agent output must never pass
 * on one provider and fail on another because the candidates were tried in a
 * different sequence.
 */
export function parseStructuredVerdict(
  text: string,
  structuredOutput: unknown,
): { value?: unknown; invalidReason?: string } {
  const fence = extractVerdictDetails(text);
  // The RAW fence object, not the normalized verdict: the latter keeps only
  // success/reason/blocked, and a step's captured fields (`capture`) live next to
  // them. Every caller re-normalizes through `verdictFromStructured` anyway.
  if (fence.verdict) return { value: fence.raw };
  if (structuredOutput != null) {
    const checked = verdictFromStructured(structuredOutput);
    return checked.verdict ? { value: structuredOutput } : { invalidReason: checked.invalidReason };
  }
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text.trim());
    const checked = verdictFromStructured(value);
    return checked.verdict ? { value } : { invalidReason: checked.invalidReason };
  } catch {
    // A malformed fence is still the best diagnostic available at this point.
    return fence.invalidReason ? { invalidReason: fence.invalidReason } : {};
  }
}

/** Parsed transport/stream error. `cause` travels with it so a backend can say
 *  its error is a block (an authentication failure) without encoding that in the
 *  message, which the report prints and no reader should have to parse. */
export interface VerdictOutcomeError {
  text: string;
  cause?: StepFailCause;
}

export interface VerdictOutcomeInput {
  killed: boolean;
  killReason?: string;
  code: number | null;
  /** Parsed transport/stream error; any value forces a technical failure. */
  error?: VerdictOutcomeError;
  /** True when JSON output was requested, so an absent verdict is a failure. */
  requiresVerdict: boolean;
  verdict?: Verdict | null;
  invalidReason?: string;
  /** Message when JSON output produced no verdict at all, e.g. "no Codex verdict". */
  missingVerdictLabel: string;
  /** Where a discarded signal is reported, when the backend has a log channel. */
  log?: (message: string) => void;
}

export interface VerdictOutcome {
  ok: boolean;
  failReason?: string;
  failKind?: StepFailKind;
  failCause?: StepFailCause;
}

/**
 * ok/failReason/failKind/failCause cascade shared by process-backed agents whose
 * failure signals are the exit status, a parsed error, and the JSON verdict.
 * Precedence: kill > parsed error > missing or invalid verdict > negative
 * verdict > exit code. `failKind` is "verdict" only when the agent itself said
 * success=false with a healthy transport; everything else is "technical".
 *
 * `failCause` is read from the branch this cascade RETAINS, never from the raw
 * signals. A blocked verdict left in the output of an attempt the cost guard or
 * the timeout killed says nothing about why the attempt ended, and a run stopped
 * as "blocked" would send an operator to fix an environment that is fine. Only
 * the retained branch can name a cause:
 *
 * | retained branch          | `failCause`                                  |
 * |--------------------------|----------------------------------------------|
 * | kill                     | none, even with a blocked verdict in output  |
 * | parsed error             | the error's own `cause`                      |
 * | missing/invalid verdict  | none — nothing was said                      |
 * | negative verdict         | `"blocked"` iff `verdict.blocked === true`   |
 * | exit code                | none                                         |
 * | ok                       | none; `success: true, blocked: true` is ok    |
 */
export function resolveVerdictOutcome(input: VerdictOutcomeInput): VerdictOutcome {
  const { killed, killReason, code, error, requiresVerdict, verdict, invalidReason, missingVerdictLabel } = input;
  const verdictOk = !requiresVerdict || verdict?.success === true;
  const ok = !killed && code === 0 && !error && verdictOk;
  const failReason = killed
    ? `process killed: ${killReason}`
    : error
      ? error.text
      : requiresVerdict && !verdict
        ? invalidReason
          ? `invalid verdict: ${invalidReason}`
          : missingVerdictLabel
        : verdict && !verdict.success
          ? (verdict.reason ?? "success=false verdict")
          : code !== 0
            ? `exit code ${code}`
            : undefined;
  const failKind: StepFailKind | undefined = ok
    ? undefined
    : verdict && !verdict.success && !killed && !error
      ? "verdict"
      : "technical";
  // A verdict that succeeds and claims to be blocked contradicts itself. The
  // success is kept — it is the field the contract requires — and the claim is
  // reported rather than silently dropped, so an author sees the prompt is wrong.
  if (ok && verdict?.success === true && verdict.blocked === true) {
    input.log?.("  ⚠ verdict reports success=true with blocked=true — blocked ignored");
  }
  const failCause: StepFailCause | undefined = ok
    ? undefined
    : killed
      ? undefined
      : error
        ? error.cause
        : verdict && !verdict.success && verdict.blocked === true
          ? "blocked"
          : undefined;
  return { ok, failReason, failKind, failCause };
}
