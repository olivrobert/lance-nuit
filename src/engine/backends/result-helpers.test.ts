import { expect, test } from "bun:test";
import { parseStructuredVerdict, resolveVerdictOutcome, type VerdictOutcomeInput } from "./result-helpers.js";

/* ------------------------------------------------------------------------- *
 * `failCause` is read from the branch the cascade RETAINS, never from the raw
 * signals. One test per row of the precedence table, because the whole point of
 * the field is that a stray signal on a discarded branch says nothing.
 * ------------------------------------------------------------------------- */

const blockedVerdict = { success: false, reason: "the release branch is missing", blocked: true } as const;

function outcome(overrides: Partial<VerdictOutcomeInput> = {}) {
  return resolveVerdictOutcome({
    killed: false,
    code: 0,
    requiresVerdict: true,
    missingVerdictLabel: "no verdict",
    ...overrides,
  });
}

test("kill: no fail cause, even with a blocked verdict left in the output", () => {
  const result = outcome({ killed: true, killReason: "timeout after 60s", code: null, verdict: blockedVerdict });
  expect(result.failReason).toBe("process killed: timeout after 60s");
  expect(result.failKind).toBe("technical");
  // The kill is what ended the attempt. Reporting "blocked" would send an
  // operator to fix an environment that is fine.
  expect(result.failCause).toBeUndefined();
});

test("kill: a cost-guard kill discards the blocked verdict too", () => {
  const result = outcome({
    killed: true,
    killReason: "budget exceeded ($0.11 estimated > $0.05 remaining)",
    code: null,
    verdict: blockedVerdict,
  });
  expect(result.failCause).toBeUndefined();
});

test("parsed error: the cause is the error's own", () => {
  const blocked = outcome({ code: 1, error: { text: "API Claude: Not logged in", cause: "blocked" } });
  expect(blocked.failReason).toBe("API Claude: Not logged in");
  expect(blocked.failKind).toBe("technical");
  expect(blocked.failCause).toBe("blocked");

  const transport = outcome({ code: 1, error: { text: "API Claude 529: Overloaded" } });
  expect(transport.failCause).toBeUndefined();
});

test("parsed error: it outranks a blocked verdict, and the verdict does not leak into the cause", () => {
  const result = outcome({ code: 1, error: { text: "stream error" }, verdict: blockedVerdict });
  expect(result.failReason).toBe("stream error");
  expect(result.failCause).toBeUndefined();
});

test("missing or invalid verdict: no fail cause, nothing was said", () => {
  const missing = outcome({ code: 0, verdict: null });
  expect(missing.failReason).toBe("no verdict");
  expect(missing.failCause).toBeUndefined();

  const invalid = outcome({ code: 0, verdict: null, invalidReason: "success must be a boolean" });
  expect(invalid.failReason).toBe("invalid verdict: success must be a boolean");
  expect(invalid.failCause).toBeUndefined();
});

test("negative verdict: blocked iff the verdict says so", () => {
  const blocked = outcome({ code: 0, verdict: blockedVerdict });
  expect(blocked.ok).toBe(false);
  expect(blocked.failReason).toBe("the release branch is missing");
  expect(blocked.failKind).toBe("verdict");
  expect(blocked.failCause).toBe("blocked");

  const plain = outcome({ code: 0, verdict: { success: false, reason: "3 tests failed" } });
  expect(plain.failKind).toBe("verdict");
  expect(plain.failCause).toBeUndefined();
});

test("exit code: no fail cause", () => {
  const result = outcome({ code: 2, verdict: { success: true } });
  expect(result.ok).toBe(false);
  expect(result.failReason).toBe("exit code 2");
  expect(result.failKind).toBe("technical");
  expect(result.failCause).toBeUndefined();
});

test("ok: success=true with blocked=true stays ok, and is reported once", () => {
  const logs: string[] = [];
  const result = outcome({
    code: 0,
    verdict: { success: true, reason: "done", blocked: true },
    log: (message) => logs.push(message),
  });
  expect(result.ok).toBe(true);
  expect(result.failReason).toBeUndefined();
  expect(result.failKind).toBeUndefined();
  expect(result.failCause).toBeUndefined();
  expect(logs).toEqual(["  ⚠ verdict reports success=true with blocked=true — blocked ignored"]);
});

test("ok: a clean success reports nothing", () => {
  const logs: string[] = [];
  const result = outcome({ code: 0, verdict: { success: true }, log: (message) => logs.push(message) });
  expect(result).toEqual({ ok: true, failReason: undefined, failKind: undefined, failCause: undefined });
  expect(logs).toEqual([]);
});

test("a text-format attempt is ok whatever the verdict says, so it has no cause", () => {
  // `requiresVerdict: false` (a fix pass, a text step): no verdict is consulted,
  // the attempt is judged on its exit status alone. A blocked verdict parsed out
  // of the prose anyway cannot turn that success into a stop.
  const result = outcome({ requiresVerdict: false, code: 0, verdict: blockedVerdict });
  expect(result.ok).toBe(true);
  expect(result.failCause).toBeUndefined();
});

/* ------------------------------------------------------------------------- *
 * The candidate the cascade returns is the RAW object, whatever the source: a
 * captured field (`capture`) rides next to success/reason/blocked, and the
 * normalized verdict would drop it.
 * ------------------------------------------------------------------------- */

test("parseStructuredVerdict: the fence wins and keeps its extra fields", () => {
  const text = 'done\n```json:verdict\n{"success": true, "reason": "ok", "commit": "feat: add capture"}\n```';
  expect(parseStructuredVerdict(text, { success: false, reason: "stale stream" })).toEqual({
    value: { success: true, reason: "ok", commit: "feat: add capture" },
  });
});

test("parseStructuredVerdict: structured output and whole-text JSON keep their extra fields too", () => {
  const structured = { success: true, reason: "ok", branch: { name: "feat/x" } };
  expect(parseStructuredVerdict("prose", structured)).toEqual({ value: structured });
  expect(parseStructuredVerdict(JSON.stringify(structured), undefined)).toEqual({ value: structured });
});

test("parseStructuredVerdict: an invalid fence still reports its own diagnostic", () => {
  expect(parseStructuredVerdict('```json:verdict\n{"success": "yes"}\n```', undefined)).toEqual({
    invalidReason: "success must be a boolean",
  });
});
