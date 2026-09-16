import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveMessageSink } from "../host-helpers.js";
import { parseOpencodeEvents, parseOpencodeLogErrors, textFromEvent } from "./events.js";

const FIXTURES = join(dirname(import.meta.path), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

test("parseOpencodeEvents: sums tokens across every step of a real 3-step run", () => {
  const parsed = parseOpencodeEvents(fixture("run-3-steps.jsonl"));

  expect(parsed.turns).toBe(3);
  expect(parsed.inputTokens).toBe(20484); // 6592 + 6855 + 7037
  expect(parsed.outputTokens).toBe(237); //    83 +  117 +   37
  expect(parsed.reasoningTokens).toBe(119); //  55 +   45 +   19
  expect(parsed.sessionId).toBe("ses_fd1c70662ffeSWyyKAUBuTYZH2");
  expect(parsed.toolsUsed).toEqual(["read", "write"]);
  expect(parsed.error).toBeUndefined();
});

test("parseOpencodeEvents: last context occupancy is the last step, not the sum", () => {
  // 20484 input tokens were spent, but only 7093 were resident at the end.
  expect(parseOpencodeEvents(fixture("run-3-steps.jsonl")).lastContextTokens).toBe(7093);
});

test("parseOpencodeEvents: keeps the agent text, verdict block included", () => {
  const parsed = parseOpencodeEvents(fixture("run-3-steps.jsonl"));
  expect(parsed.text).toContain("```json:verdict");
  expect(parsed.text).toContain('"success": true');
});

test("parseOpencodeEvents: a free model reports cost 0, which is a price and not a gap", () => {
  const parsed = parseOpencodeEvents(fixture("run-3-steps.jsonl"));
  expect(parsed.costUsd).toBe(0);
  expect(parsed.costReported).toBe(true);
});

test("parseOpencodeEvents: a run without any cost field reports nothing rather than zero", () => {
  const raw = JSON.stringify({
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", reason: "stop", tokens: { total: 40, input: 30, output: 10, reasoning: 0 } },
  });
  const parsed = parseOpencodeEvents(raw);

  expect(parsed.costReported).toBe(false);
  expect(parsed.costUsd).toBeUndefined();
  expect(parsed.inputTokens).toBe(30);
});

test("parseOpencodeEvents: sums cache reads and writes separately", () => {
  const raw = [
    { tokens: { total: 100, input: 10, output: 5, reasoning: 0, cache: { write: 7, read: 1777 } } },
    { tokens: { total: 200, input: 20, output: 5, reasoning: 0, cache: { write: 0, read: 9521 } } },
  ]
    .map((part) => JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { ...part, cost: 0.5 } }))
    .join("\n");
  const parsed = parseOpencodeEvents(raw);

  expect(parsed.cacheReadTokens).toBe(11298);
  expect(parsed.cacheCreationTokens).toBe(7);
  expect(parsed.costUsd).toBe(1);
});

test("parseOpencodeEvents: an upstream failure mid-run keeps the tokens already spent", () => {
  // Real capture: two tools ran, one step finished, then the provider 502'd.
  const parsed = parseOpencodeEvents(fixture("run-upstream-error.jsonl"));

  expect(parsed.error).toBe(
    "Streaming response failed: [502] Upstream error from Nvidia: Service temporarily overloaded",
  );
  expect(parsed.turns).toBe(1);
  expect(parsed.inputTokens).toBe(6588);
  expect(parsed.toolsUsed).toEqual(["read", "bash"]);
  expect(parsed.sessionId).toBe("ses_fd1c7c41affeg0n38393PyBjFU");
});

test("parseOpencodeEvents: strips the quotes opencode wraps around provider messages", () => {
  const raw = JSON.stringify({
    type: "error",
    sessionID: "ses_1",
    error: { name: "UnknownError", data: { message: '"Model not found: nope"' } },
  });
  expect(parseOpencodeEvents(raw).error).toBe("Model not found: nope");
});

test("parseOpencodeEvents: an error event without a message still fails the run", () => {
  const raw = JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "UnknownError" } });
  expect(parseOpencodeEvents(raw).error).toBe("opencode run failed");
});

test("parseOpencodeEvents: reads the tool name off part.tool, whose part.type is 'tool'", () => {
  const raw = JSON.stringify({
    type: "tool_use",
    sessionID: "ses_1",
    part: { type: "tool", tool: "grep", callID: "call-1", state: { status: "completed" } },
  });
  expect(parseOpencodeEvents(raw).toolsUsed).toEqual(["grep"]);
});

test("parseOpencodeEvents: a repeated tool counts once", () => {
  const raw = [1, 2, 3]
    .map((n) =>
      JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { type: "tool", tool: "read", callID: `c${n}` } }),
    )
    .join("\n");
  expect(parseOpencodeEvents(raw).toolsUsed).toEqual(["read"]);
});

test("parseOpencodeEvents: keeps a pure JSON answer as structured output", () => {
  const raw = JSON.stringify({
    type: "text",
    sessionID: "ses_1",
    part: { id: "prt_1", type: "text", text: '{"tickets": ["PROJ-1"]}' },
  });
  expect(parseOpencodeEvents(raw).structuredOutput).toEqual({ tickets: ["PROJ-1"] });
});

test("parseOpencodeEvents: prose is never mistaken for structured output", () => {
  const raw = JSON.stringify({
    type: "text",
    sessionID: "ses_1",
    part: { id: "prt_1", type: "text", text: "{ this is not json" },
  });
  const parsed = parseOpencodeEvents(raw);

  expect(parsed.structuredOutput).toBeUndefined();
  expect(parsed.text).toBe("{ this is not json");
});

test("parseOpencodeEvents: ignores unknown event types and malformed lines", () => {
  // `file` was documented but never observed; a live stream can also be cut mid-line.
  const raw = [
    JSON.stringify({ type: "file", sessionID: "ses_1", part: { type: "file", path: "/repo/a.ts" } }),
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    '{"type":"step_finish","part":{"tok',
    "",
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "p1", type: "text", text: "ok" } }),
  ].join("\n");
  const parsed = parseOpencodeEvents(raw);

  expect(parsed.text).toBe("ok");
  expect(parsed.turns).toBe(0);
  expect(parsed.sessionId).toBe("ses_1");
});

test("parseOpencodeEvents: an empty stream parses to an empty run", () => {
  expect(parseOpencodeEvents("")).toEqual({ text: "", costReported: false, turns: 0, toolsUsed: [] });
});

test("parseOpencodeLogErrors: reads the stream error that stdout never carried", () => {
  // The finding this covers: opencode retries stream errors silently, so stderr
  // is the only place a hard failure is visible.
  expect(parseOpencodeLogErrors(fixture("stream-error.log"))).toBe(
    "Streaming response failed: [502] Upstream error from Nvidia: Service temporarily overloaded",
  );
});

test("parseOpencodeLogErrors: surfaces a billing refusal", () => {
  const logs = [
    "timestamp=2026-08-22T19:35:16.488Z level=INFO run=dcbc19a8 message=stream providerID=zai-coding-plan modelID=glm-5.2",
    'timestamp=2026-08-22T19:35:16.983Z level=ERROR run=dcbc19a8 message="stream error" providerID=zai-coding-plan error.error="AI_APICallError: Insufficient balance or no resource package. Please recharge."',
  ].join("\n");

  expect(parseOpencodeLogErrors(logs)).toBe(
    "AI_APICallError: Insufficient balance or no resource package. Please recharge.",
  );
});

test("parseOpencodeLogErrors: stays quiet on a clean run", () => {
  const logs = "timestamp=2026-08-22T19:35:16.488Z level=INFO run=dcbc19a8 message=init";
  expect(parseOpencodeLogErrors(logs)).toBeUndefined();
});

test("parseOpencodeLogErrors: skips a stack=undefined placeholder", () => {
  const logs = 'timestamp=... level=ERROR message=process error="real cause" stack=undefined';
  expect(parseOpencodeLogErrors(logs)).toBe("real cause");
});

test("liveMessageSink: streams each text part once, even if the CLI repeats it", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-live-"));
  const path = join(dir, "step.log");
  const first = { type: "text", sessionID: "s", part: { id: "prt_1", type: "text", text: "hello " } };
  const second = { type: "text", sessionID: "s", part: { id: "prt_2", type: "text", text: "world" } };

  try {
    const append = liveMessageSink(path, textFromEvent);
    append(first);
    append(first);
    append(second);

    expect(readFileSync(path, "utf8")).toBe("hello world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveMessageSink: writes nothing without a log path", () => {
  expect(() => liveMessageSink(undefined, textFromEvent)({ type: "text", part: { text: "x" } })).not.toThrow();
});

// A new opencode release may add an event type or a key at any time; the runner
// must keep the events it does understand. See `events.schema.ts`.
test("parseOpencodeEvents: an unknown event type is tolerated", () => {
  const parsed = parseOpencodeEvents(
    [
      JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
      JSON.stringify({ type: "reasoning_delta_v9", sessionID: "ses_1", part: { anything: [1, 2, 3] } }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "p1", text: "done" } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: { cost: 0.5, tokens: { input: 10, output: 4, total: 14 } },
      }),
    ].join("\n"),
  );
  expect(parsed.sessionId).toBe("ses_1");
  expect(parsed.text).toBe("done");
  expect(parsed.turns).toBe(1);
  expect(parsed.inputTokens).toBe(10);
  expect(parsed.costUsd).toBe(0.5);
  expect(parsed.lastContextTokens).toBe(14);
});

test("parseOpencodeEvents: an extra key on a known event changes nothing", () => {
  const known = [
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "p1", text: "done" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { cost: 0.5, tokens: { input: 10 } } }),
  ].join("\n");
  const extended = [
    JSON.stringify({ type: "text", sessionID: "ses_1", messageID: "msg_1", part: { id: "p1", text: "done", time: 1 } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_1",
      part: { cost: 0.5, tokens: { input: 10, cache: {} }, providerID: "anthropic" },
    }),
  ].join("\n");
  expect(parseOpencodeEvents(extended)).toEqual(parseOpencodeEvents(known));
});

test("parseOpencodeEvents: step_finish without a cost keeps costReported false", () => {
  const parsed = parseOpencodeEvents(
    JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 10 } } }),
  );
  expect(parsed.turns).toBe(1);
  expect(parsed.inputTokens).toBe(10);
  expect(parsed.costReported).toBe(false);
  expect(parsed.costUsd).toBeUndefined();
});

test("parseOpencodeEvents: step_finish without a tokens block counts the turn and no token", () => {
  const parsed = parseOpencodeEvents(JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { cost: 0 } }));
  expect(parsed.turns).toBe(1);
  expect(parsed.inputTokens).toBeUndefined();
  expect(parsed.lastContextTokens).toBeUndefined();
  // A free model reports `cost: 0`: that is a price, not a missing one.
  expect(parsed.costReported).toBe(true);
  expect(parsed.costUsd).toBe(0);
});

test("textFromEvent: an unknown event type yields no message", () => {
  expect(textFromEvent({ type: "reasoning_delta_v9", part: { text: "x" } })).toBeUndefined();
});
