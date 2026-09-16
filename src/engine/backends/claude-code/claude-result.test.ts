import { describe, expect, test } from "bun:test";
import { mapClaudeExecutionResult } from "./result.js";

const raw = (output: string) => ({ output, code: 0, killed: false, durationMs: 1 });

describe("Claude result mapping", () => {
  test("returns structured output and successful verdict", () => {
    const result = mapClaudeExecutionResult(
      raw(
        [
          JSON.stringify({
            type: "assistant",
            message: {
              id: "1",
              content: [{ type: "tool_use", name: "StructuredOutput", input: { success: true, reason: "ok" } }],
            },
          }),
          JSON.stringify({ type: "result", structured_output: { success: true, reason: "ok" }, duration_ms: 1 }),
        ].join("\n"),
      ),
      { outputFormat: "json" },
    );
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toEqual({ success: true, reason: "ok" });
  });

  test("a fence verdict is structured output too, extra fields included", () => {
    // Text mode (`RUNNER_VERDICT_MODE=text`, or a skill writing the fence itself):
    // a captured field lives in the fence, and must reach `structuredOutput`.
    const result = mapClaudeExecutionResult(
      raw(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: 'done\n```json:verdict\n{"success": true, "commit": "feat: x"}\n```' }],
          },
        }),
      ),
      { outputFormat: "json" },
    );
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toEqual({ success: true, commit: "feat: x" });
  });

  test("native structured output keeps its extra fields", () => {
    const result = mapClaudeExecutionResult(
      raw(JSON.stringify({ type: "result", structured_output: { success: true, reason: "ok", commit: "feat: x" } })),
      { outputFormat: "json" },
    );
    expect(result.structuredOutput).toEqual({ success: true, reason: "ok", commit: "feat: x" });
  });

  test("keeps the source in invalid verdict diagnostics", () => {
    const structured = mapClaudeExecutionResult(
      raw(JSON.stringify({ type: "result", structured_output: { success: "yes" } })),
      { outputFormat: "json" },
    );
    expect(structured.failReason).toContain("invalid verdict: StructuredOutput");
    const text = mapClaudeExecutionResult(
      raw(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: '```json:verdict\n{"success": "yes"}\n```' }] },
        }),
      ),
      { outputFormat: "json" },
    );
    expect(text.failReason).toContain("invalid verdict: json:verdict block");
  });

  test("charges a resumed attempt by difference and counts only its own turns", () => {
    const output = [
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } }),
      JSON.stringify({
        type: "result",
        duration_ms: 10,
        duration_api_ms: 900,
        num_turns: 12,
        total_cost_usd: 3.5,
      }),
    ].join("\n");
    const result = mapClaudeExecutionResult({ ...raw(output), resumeBaseline: { costUsd: 3, apiDurationMs: 600 } }, {});
    // The CLI reported the whole coder session; this pass only cost $0.50.
    expect(result.stats.total_cost_usd).toBeCloseTo(0.5, 10);
    expect(result.stats.duration_api_ms).toBe(300);
    expect(result.stats.num_turns).toBe(1);
    // Tokens are read off this process's own messages, so they are never netted.
    expect(result.stats.input_tokens).toBe(10);
  });

  test("adds the discarded transport attempts on top of the netted cost", () => {
    const output = JSON.stringify({ type: "result", duration_ms: 1, total_cost_usd: 0.7 });
    const result = mapClaudeExecutionResult(
      { ...raw(output), resumeBaseline: { costUsd: 0.4 }, priorAttemptsCostUsd: 0.4 },
      {},
    );
    expect(result.stats.total_cost_usd).toBeCloseTo(0.7, 10);
    expect(result.stats.cost_unknown).toBeUndefined();
  });

  test("flags the spawn as a lower bound when its final attempt died before any usage", () => {
    // Timeout after an overload retry: the $0.40 of the discarded attempt is real,
    // the final attempt's own spend is unmeasured. Reporting $0.40 as THE cost
    // would let the ledger read the spawn as fully priced.
    const result = mapClaudeExecutionResult(
      {
        output: "",
        code: null,
        killed: true,
        killReason: "timeout after 1ms",
        durationMs: 1,
        priorAttemptsCostUsd: 0.4,
      },
      {},
    );
    expect(result.stats.total_cost_usd).toBeCloseTo(0.4, 10);
    expect(result.stats.cost_unknown).toBe(true);
  });

  test("leaves an estimated cost alone: it is already this process's own spend", () => {
    const output = JSON.stringify({
      type: "assistant",
      message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 100 } },
    });
    const estimated = mapClaudeExecutionResult({ ...raw(output) }, {}).stats.total_cost_usd;
    const netted = mapClaudeExecutionResult({ ...raw(output), resumeBaseline: { costUsd: 3 } }, {}).stats
      .total_cost_usd;
    expect(netted).toBe(estimated);
  });

  test("maps timeout cleanup as a technical timeout", () => {
    const result = mapClaudeExecutionResult({
      output: "",
      code: null,
      killed: true,
      killReason: "timeout (1s)",
      durationMs: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.failKind).toBe("technical");
  });
  test("reports an authentication failure as blocked so the run stops without repair", () => {
    const logs: string[] = [];
    const result = mapClaudeExecutionResult(
      {
        output: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
        code: 1,
        killed: false,
        durationMs: 1,
      },
      { log: (m) => logs.push(m) },
    );
    expect(result.ok).toBe(false);
    expect(result.failCause).toBe("blocked");
    // The cause is a field, not a prefix: the message the report prints stays the
    // provider's own sentence.
    expect(result.failReason).toBe("API Claude: Not logged in · Please run /login");
    expect(result.failKind).toBe("technical");
    expect(logs).toEqual(["  ⚠ API Claude: Not logged in · Please run /login"]);
  });

  test("leaves other transport errors without a blocked cause", () => {
    const result = mapClaudeExecutionResult({
      output: JSON.stringify({
        type: "result",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        result: "API Error: 529 Overloaded",
      }),
      code: 1,
      killed: false,
      durationMs: 1,
    });
    expect(result.failReason).toBe("API Claude 529: API Error: 529 Overloaded");
    expect(result.failCause).toBeUndefined();
  });
});
