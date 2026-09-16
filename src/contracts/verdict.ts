/** Common agent verdict contract and parsers shared by all backends. */
export interface Verdict {
  success: boolean;
  reason?: string;
  /** The agent reports an obstacle outside the code, which no fix pass can
   *  clear: the run must stop cleanly rather than retry. Canonical field; a
   *  `BLOCKED:` prefix on `reason` also sets it when it is absent. Only
   *  ever present when true — an explicit `false` is honored by omitting it. */
  blocked?: boolean;
}

/** `raw` is the object the verdict was read from, kept whole: a step that captures
 *  extra fields (`capture`) reads them there, since the normalized verdict keeps
 *  only `success`/`reason`/`blocked`. Absent when nothing parsed as an object. */
/** The verdict's own fields. An author may not `capture` under these names: the
 *  runner reads them as the verdict, never as a step output. */
export const VERDICT_FIELD_NAMES = ["success", "reason", "blocked"] as const;

export type VerdictDetails = { verdict: Verdict | null; invalidReason?: string; raw?: unknown };

/**
 * Prose encoding of the stop signal: `BLOCKED:` at the head of a reason. It is
 * the fallback for an agent or extension backend that states the obstacle in
 * text instead of setting `blocked`. Exactly two boundaries call it — this
 * parser, for agent text, and `normalizeAgentResult`, for an extension
 * backend's `failReason`. Nothing downstream re-reads prose.
 */
export function hasBlockedPrefix(reason: string | undefined): boolean {
  return /^\s*BLOCKED\s*:/i.test(reason ?? "");
}

function verdictFromObject(parsed: unknown): VerdictDetails {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { verdict: null, invalidReason: "expected a JSON object" };
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.success !== "boolean") {
    return { verdict: null, invalidReason: "success must be a boolean", raw: parsed };
  }
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  // The explicit field wins over the prefix, in both directions: an agent that
  // says `blocked: false` while quoting "BLOCKED:" in its reason is not blocked.
  const blocked = typeof value.blocked === "boolean" ? value.blocked : hasBlockedPrefix(reason);
  return {
    verdict: {
      success: value.success,
      ...(reason !== undefined ? { reason } : {}),
      ...(blocked ? { blocked: true } : {}),
    },
    raw: parsed,
  };
}

export function verdictFromStructured(value: unknown): VerdictDetails {
  return verdictFromObject(value);
}

export function extractVerdictDetails(text: string): VerdictDetails {
  const matches = [...text.matchAll(/```json:verdict\s*\r?\n([\s\S]*?)\r?\n```/g)];
  const match = matches.at(-1);
  if (!match) return { verdict: null };
  try {
    return verdictFromObject(JSON.parse(match[1]));
  } catch {
    return { verdict: null, invalidReason: "unreadable JSON" };
  }
}

export function extractVerdict(text: string): Verdict | null {
  return extractVerdictDetails(text).verdict;
}
