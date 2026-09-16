import { expect, test } from "bun:test";
import { mapCodexExecutionResult } from "./result.js";
import type { RawCodexExecutionResult } from "./types.js";

function execution(output: string, overrides: Partial<RawCodexExecutionResult> = {}): RawCodexExecutionResult {
  return { output, code: 0, killed: false, durationMs: 42, ...overrides };
}

function message(value: unknown): string {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } });
}

test("Codex mapper: structured success, session, usage, and duration", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    message({ success: true, reason: "ok" }),
    JSON.stringify({ type: "turn.completed", model: "gpt-test", usage: { input_tokens: 10, output_tokens: 3 } }),
  ].join("\n");

  expect(mapCodexExecutionResult(execution(raw), { outputFormat: "json" })).toMatchObject({
    ok: true,
    session: { provider: "codex", id: "thread-1", resumable: true },
    structuredOutput: { success: true, reason: "ok" },
    stats: { duration_ms: 42, model: "gpt-test", input_tokens: 10, output_tokens: 3 },
  });
});

test("Codex mapper: missing or invalid verdict fails explicitly", () => {
  expect(mapCodexExecutionResult(execution(""), { outputFormat: "json" })).toMatchObject({
    ok: false,
    failReason: "no Codex verdict",
  });
  const invalid = mapCodexExecutionResult(execution(message({ success: "yes" })), { outputFormat: "json" });
  expect(invalid.ok).toBe(false);
  expect(invalid.failReason).toContain("invalid verdict");
});

test("Codex mapper: success=false preserves the verdict reason", () => {
  expect(
    mapCodexExecutionResult(execution(message({ success: false, reason: "tests rouges" })), {
      outputFormat: "json",
    }),
  ).toMatchObject({ ok: false, failReason: "tests rouges" });
});

test("Codex mapper: parsed transport error takes precedence over code and verdict", () => {
  const raw = JSON.stringify({ type: "turn.failed", error: { message: "API indisponible" } });
  expect(mapCodexExecutionResult(execution(raw, { code: 7 }), { outputFormat: "json" })).toMatchObject({
    ok: false,
    failReason: "API indisponible",
  });
});

test("Codex mapper: non-zero code without another cause", () => {
  expect(mapCodexExecutionResult(execution("", { code: 9 }))).toMatchObject({
    ok: false,
    failReason: "exit code 9",
  });
});

test("Codex mapper: timeout and descendant cleanup remain distinct", () => {
  expect(
    mapCodexExecutionResult(
      execution("", {
        killed: true,
        killReason: "timeout after 100 ms",
      }),
    ),
  ).toMatchObject({ ok: false, timedOut: true, failReason: "process killed: timeout after 100 ms" });

  expect(
    mapCodexExecutionResult(
      execution("", {
        killed: true,
        killReason: "child exited with descendants still alive",
      }),
    ),
  ).toMatchObject({
    ok: false,
    timedOut: false,
    failReason: "process killed: child exited with descendants still alive",
  });
});
