import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../../contracts/index.js";
import { parseClaudeEvents } from "./claude-code/events.js";
import { mapClaudeExecutionResult } from "./claude-code/result.js";
import { mapCodexExecutionResult } from "./codex/result.js";
import { mapOpencodeExecutionResult } from "./opencode/result.js";

/* ------------------------------------------------------------------------- *
 * The same agent answer, written in each provider's stream: a draft fence that
 * says success=false, then the schema-constrained answer that says success=true.
 * One cascade means one verdict, whatever the backend.
 * ------------------------------------------------------------------------- */

const DRAFT = 'first try\n```json:verdict\n{"success": false, "reason": "draft"}\n```';
const ANSWER = { success: true, reason: "done" };

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

function claude(output: string, outputFormat: "text" | "json" = "json"): AgentResult {
  return mapClaudeExecutionResult(
    { output, code: 0, durationMs: 1, stream: parseClaudeEvents(output) },
    { outputFormat },
  );
}

function codex(output: string): AgentResult {
  return mapCodexExecutionResult({ output, code: 0, durationMs: 1 }, { outputFormat: "json" });
}

function opencode(output: string, logs = ""): AgentResult {
  return mapOpencodeExecutionResult({ output, logs, code: 0, durationMs: 1 }, { outputFormat: "json" });
}

describe("one verdict cascade for every backend", () => {
  test("a fence success=false next to a structured success=true gives the same verdict everywhere", () => {
    const results = [
      claude(
        lines(
          { type: "assistant", message: { id: "m1", content: [{ type: "text", text: DRAFT }] } },
          {
            type: "assistant",
            message: { id: "m2", content: [{ type: "tool_use", name: "StructuredOutput", input: ANSWER }] },
          },
        ),
      ),
      codex(
        lines(
          { type: "item.completed", item: { type: "agent_message", text: DRAFT } },
          { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(ANSWER) } },
        ),
      ),
      opencode(
        lines(
          { type: "text", sessionID: "s", part: { id: "p1", text: DRAFT } },
          { type: "text", sessionID: "s", part: { id: "p2", text: JSON.stringify(ANSWER) } },
        ),
      ),
    ];
    for (const result of results) {
      expect({ provider: result.provider, ok: result.ok, structuredOutput: result.structuredOutput }).toEqual({
        provider: result.provider,
        ok: true,
        structuredOutput: ANSWER,
      });
    }
  });

  test("Claude in text output reads no verdict: a successful run carries no failReason", () => {
    const result = claude(
      lines({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: DRAFT }] } }),
      "text",
    );
    expect(result.ok).toBe(true);
    expect(result.failReason).toBeUndefined();
    expect(result.structuredOutput).toBeUndefined();
  });

  test("an authentication error blocks codex and opencode, as it blocks Claude", () => {
    const codexResult = codex(lines({ type: "error", message: "unexpected status 401 Unauthorized: invalid api key" }));
    const opencodeStream = opencode(
      lines({ type: "error", sessionID: "s", error: { data: { message: "Invalid API key provided" } } }),
    );
    const opencodeStderr = opencode(
      "",
      'ERROR 2026-11-24 service=llm level=ERROR error.error="AI_APICallError: authentication failed"',
    );
    for (const result of [codexResult, opencodeStream, opencodeStderr]) {
      expect({ ok: result.ok, failCause: result.failCause }).toEqual({ ok: false, failCause: "blocked" });
    }
  });
});
