import { expect, test } from "bun:test";
import {
  extractVerdict,
  extractVerdictDetails,
  hasBlockedPrefix,
  verdictFromStructured,
} from "../contracts/verdict.js";
import { resolveVerdictOutcome } from "./backends/result-helpers.js";

test("validates structured verdicts", () => {
  expect(verdictFromStructured({ success: true, reason: "ok" })).toEqual({
    verdict: { success: true, reason: "ok" },
    raw: { success: true, reason: "ok" },
  });
  expect(verdictFromStructured({ success: "true" }).invalidReason).toContain("boolean");
});

test("keeps the raw object next to the normalized verdict, extra fields included", () => {
  // `capture` reads its fields from `raw`: the verdict itself keeps only its own three.
  const details = verdictFromStructured({ success: true, reason: "ok", commit: "feat: x", blocked: null });
  expect(details.verdict).toEqual({ success: true, reason: "ok" });
  expect(details.raw).toEqual({ success: true, reason: "ok", commit: "feat: x", blocked: null });
  const fenced = extractVerdictDetails('```json:verdict\n{"success": true, "branch": {"name": "feat/x"}}\n```');
  expect(fenced.raw).toEqual({ success: true, branch: { name: "feat/x" } });
  // Nothing parsed as an object: nothing to read fields from.
  expect(extractVerdictDetails("no verdict").raw).toBeUndefined();
  expect(verdictFromStructured("text").raw).toBeUndefined();
});

test("extracts the final fenced verdict", () => {
  const text = '```json:verdict\n{"success": true}\n```';
  expect(extractVerdict(text)).toEqual({ success: true });
  expect(extractVerdictDetails("no verdict").verdict).toBeNull();
});

/* ------------------------------------------------------------------------- *
 * `blocked` is the canonical field; the `BLOCKED:` prefix is the prose way of
 * saying the same thing, read here and at `normalizeAgentResult` only. These
 * cases pin both, and what the outcome cascade makes of them.
 * ------------------------------------------------------------------------- */

test("a BLOCKED prefix on a negative verdict is what marks the stop", () => {
  const verdict = verdictFromStructured({ success: false, reason: "BLOCKED: the branch is missing" }).verdict;
  expect(verdict).toEqual({ success: false, reason: "BLOCKED: the branch is missing", blocked: true });
  // Case and leading whitespace are accepted; the word alone is not a prefix.
  expect(hasBlockedPrefix("  blocked : x")).toBe(true);
  expect(hasBlockedPrefix("blocked by a missing branch")).toBe(false);
  expect(hasBlockedPrefix(undefined)).toBe(false);
  expect(verdictFromStructured({ success: false, reason: "blocked by a missing branch" }).verdict?.blocked).toBe(
    undefined,
  );
});

test("the explicit blocked field wins over the prefix, in both directions", () => {
  // The agent quotes the prefix in its prose but says it is not blocked.
  expect(
    verdictFromStructured({ success: false, reason: "BLOCKED: is what the log said", blocked: false }).verdict,
  ).toEqual({ success: false, reason: "BLOCKED: is what the log said" });
  // And the reverse: the field alone marks the stop, no prefix needed.
  expect(verdictFromStructured({ success: false, reason: "the branch is missing", blocked: true }).verdict).toEqual({
    success: false,
    reason: "the branch is missing",
    blocked: true,
  });
});

test("a BLOCKED prefix on a successful verdict is ignored", () => {
  const verdict = verdictFromStructured({ success: true, reason: "BLOCKED: the branch is missing" }).verdict;
  const logs: string[] = [];
  expect(
    resolveVerdictOutcome({
      killed: false,
      code: 0,
      requiresVerdict: true,
      verdict,
      missingVerdictLabel: "no verdict",
      log: (message) => logs.push(message),
    }),
  ).toEqual({ ok: true, failReason: undefined, failKind: undefined, failCause: undefined });
  // Ignored, not silently dropped: the author is told the prompt contradicts itself.
  expect(logs).toEqual(["  ⚠ verdict reports success=true with blocked=true — blocked ignored"]);
});

test("a kill outranks a blocked verdict in the outcome cascade", () => {
  expect(
    resolveVerdictOutcome({
      killed: true,
      killReason: "timeout after 60s",
      code: null,
      requiresVerdict: true,
      verdict: { success: false, reason: "BLOCKED: the branch is missing", blocked: true },
      missingVerdictLabel: "no verdict",
    }),
  ).toEqual({
    ok: false,
    failReason: "process killed: timeout after 60s",
    failKind: "technical",
    failCause: undefined,
  });
});
