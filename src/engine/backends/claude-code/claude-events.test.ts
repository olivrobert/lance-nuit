import { describe, expect, test } from "bun:test";
import { extractVerdictDetails, verdictFromStructured } from "../../../contracts/verdict.js";
import {
  addUsage,
  estimateCostUsd,
  isAuthFailure,
  isOverloaded,
  newUsageTotals,
  parseClaudeEvents,
  SYNTHETIC_MODEL,
  textFromAssistantEvent,
  usageBreakdown,
} from "./events.js";
import { computeCostUsd } from "./pricing.js";

const assistant = (model: string, content: unknown[], id = "m1") =>
  JSON.stringify({
    type: "assistant",
    message: { id, model, content, usage: { input_tokens: 4, output_tokens: 2 } },
  });

describe("Claude JSONL events", () => {
  test("prefers the model emitted by system/assistant over configured fallback", () => {
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-sonnet-emitted" }),
        assistant("claude-opus-emitted", [{ type: "text", text: "done" }]),
        JSON.stringify({ type: "result", duration_ms: 5, total_cost_usd: 0.1 }),
      ].join("\n"),
      "configured-fallback",
    );
    expect(parsed.stats.model).toBe("claude-opus-emitted");
  });

  test("a reported $0 over consumed tokens falls back to the rate table", () => {
    // The CLI writes 0 when it has no price for the turn. Recording that as an
    // exact free attempt made `max_cost_usd` unfirable; Claude ships its own
    // rates, so the spend is estimated rather than lost.
    const parsed = parseClaudeEvents(
      [
        assistant("sonnet", [{ type: "text", text: "done" }]),
        JSON.stringify({ type: "result", duration_ms: 5, total_cost_usd: 0 }),
      ].join("\n"),
    );
    expect(parsed.stats.total_cost_usd).toBeGreaterThan(0);
    expect(parsed.stats.cost_estimated).toBe(true);
  });

  test("a reported $0 with no tokens at all stays an exact zero", () => {
    const parsed = parseClaudeEvents(JSON.stringify({ type: "result", duration_ms: 5, total_cost_usd: 0 }));
    expect(parsed.stats.total_cost_usd).toBe(0);
    expect(parsed.stats.cost_estimated).toBeUndefined();
  });

  test("the context window follows the session model, not the model of the turn", () => {
    // The real CLI shape: `system`/`init` carries the `[1m]` suffix, every
    // `assistant` message that follows reports the bare name. Reading the window
    // off the turn model measured a 1M session against 200k.
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-sonnet-5[1m]" }),
        assistant("claude-sonnet-5", [{ type: "text", text: "done" }]),
        JSON.stringify({ type: "result", duration_ms: 5 }),
      ].join("\n"),
    );
    expect(parsed.stats.context_window).toBe(1_000_000);
    // The turn model still drives cost: it is what actually ran and got billed.
    expect(parsed.stats.model).toBe("claude-sonnet-5");
  });

  test("a synthetic message never becomes the tracked model", () => {
    // The CLI labels the messages it fabricates itself (transport errors,
    // refusals) `<synthetic>`. It matches no pricing key — it would bill at the
    // opus default — and carries no `[1m]` suffix.
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-sonnet-5[1m]" }),
        assistant("claude-sonnet-5", [{ type: "text", text: "done" }]),
        assistant(SYNTHETIC_MODEL, [{ type: "text", text: "Not logged in" }], "m2"),
        JSON.stringify({ type: "result", duration_ms: 5 }),
      ].join("\n"),
    );
    expect(parsed.stats.model).toBe("claude-sonnet-5");
    expect(parsed.stats.context_window).toBe(1_000_000);
  });

  test("captures StructuredOutput and transport statuses without treating 429 as overload", () => {
    const structured = parseClaudeEvents(
      [
        assistant("sonnet", [{ type: "tool_use", name: "StructuredOutput", input: { success: true } }]),
        JSON.stringify({ type: "result", structured_output: { success: true }, duration_ms: 1 }),
      ].join("\n"),
    );
    expect(verdictFromStructured(structured.structuredOutput).verdict).toEqual({ success: true });
    expect(isOverloaded({ status: 529, message: "overloaded" })).toBe(true);
    expect(isOverloaded({ status: 429, message: "quota" })).toBe(false);
  });

  test("the live estimate and the parsed cost share one accumulation rule", () => {
    // The budget gate in execution.ts accumulates through these helpers instead of
    // its own heuristic. Same usage blocks in, same price out — otherwise a
    // mid-flight kill would fire at a cost the final report never confirms.
    const usage = {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 2_000,
    };
    const lines = [
      JSON.stringify({ type: "system", model: "claude-sonnet-4-6" }),
      // Same id twice: the CLI repeats a message as it streams.
      JSON.stringify({ type: "assistant", message: { id: "m1", usage, content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant", message: { id: "m1", usage, content: [{ type: "text", text: "hi" }] } }),
    ];
    const parsed = parseClaudeEvents(lines.join("\n"));

    const totals = newUsageTotals();
    addUsage(totals, usage);
    const live = computeCostUsd(usageBreakdown(totals), "claude-sonnet-4-6");

    expect(parsed.stats.total_cost_usd).toBeCloseTo(live, 12);
    expect(parsed.stats.cache_read_tokens).toBe(40_000);
    expect(totals.lastTurn).toBe(43_000);
  });

  test("usageBreakdown bills the cache creation of a message without a TTL split as 1h", () => {
    // The split is per message. One message carrying `cache_creation` and one
    // without used to leave the second one out of the priced total entirely.
    const totals = newUsageTotals();
    addUsage(totals, { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } });
    addUsage(totals, { cache_creation_input_tokens: 200 });
    const breakdown = usageBreakdown(totals);
    expect(breakdown.cache_creation_5m_tokens).toBe(100);
    expect(breakdown.cache_creation_1h_tokens).toBe(200);

    const mixed = newUsageTotals();
    addUsage(mixed, {
      cache_creation_input_tokens: 70,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
    });
    addUsage(mixed, { cache_creation_input_tokens: 50 });
    expect(usageBreakdown(mixed)).toMatchObject({ cache_creation_5m_tokens: 30, cache_creation_1h_tokens: 90 });
  });

  test("prices each message at its own model, not at the model that spoke last", () => {
    // An opus run delegating to a haiku sub-agent: the haiku message comes last.
    const opus = { input_tokens: 100_000, output_tokens: 10_000 };
    const haiku = { input_tokens: 1_000, output_tokens: 100 };
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-opus-4-6" }),
        JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-4-6", usage: opus } }),
        JSON.stringify({ type: "assistant", message: { id: "m2", model: "claude-haiku-4-5", usage: haiku } }),
      ].join("\n"),
    );
    const expected = computeCostUsd(opus, "claude-opus-4-6") + computeCostUsd(haiku, "claude-haiku-4-5");
    expect(parsed.stats.total_cost_usd).toBeCloseTo(expected, 12);
    expect(parsed.stats.cost_estimated).toBe(true);
    // The single-model reading would have billed 100k opus tokens at the haiku rate.
    const allAtHaiku = computeCostUsd({ input_tokens: 101_000, output_tokens: 10_100 }, "claude-haiku-4-5");
    expect(parsed.stats.total_cost_usd!).toBeGreaterThan(allAtHaiku * 3);

    // The live gate follows the same rule through the shared accumulator.
    const totals = newUsageTotals();
    addUsage(totals, opus, "claude-opus-4-6");
    addUsage(totals, haiku, "claude-haiku-4-5");
    expect(estimateCostUsd(totals, "claude-haiku-4-5")).toBeCloseTo(expected, 12);
    // Messages naming no model fall back to the caller's model.
    const anonymous = newUsageTotals();
    addUsage(anonymous, haiku);
    expect(estimateCostUsd(anonymous, "claude-haiku-4-5")).toBeCloseTo(computeCostUsd(haiku, "claude-haiku-4-5"), 12);
  });

  test("uses the common fenced verdict parser", () => {
    expect(extractVerdictDetails('```json:verdict\n{"success":true}\n```').verdict).toEqual({ success: true });
  });

  test("sums usage once per message, including cache counters and the last context", () => {
    const usageA = {
      input_tokens: 5,
      output_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 50 },
    };
    const usageB = {
      input_tokens: 7,
      output_tokens: 20,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_1h_input_tokens: 30 },
    };
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-sonnet-4-6" }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", usage: usageA, content: [{ type: "tool_use", name: "Read", input: {} }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", usage: usageA, content: [{ type: "tool_use", name: "Read", input: {} }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", usage: usageB, content: [{ type: "text", text: "done" }] },
        }),
        JSON.stringify({ type: "result", total_cost_usd: 0.05, num_turns: 2 }),
      ].join("\n"),
    );
    expect(parsed.stats.input_tokens).toBe(12);
    expect(parsed.stats.output_tokens).toBe(30);
    expect(parsed.stats.cache_read_tokens).toBe(300);
    expect(parsed.stats.cache_creation_tokens).toBe(80);
    expect(parsed.stats.last_turn_context_tokens).toBe(237);
    expect(parsed.stats.context_window).toBe(200_000);
    expect(parsed.stats.tools_used).toEqual(["Read"]);
    expect(parsed.stats.total_cost_usd).toBe(0.05);
    expect(parsed.stats.cost_estimated).toBeUndefined();
  });

  test("estimates cost and turns for an interrupted stream", () => {
    const parsed = parseClaudeEvents(
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 10 }, content: [] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 20 }, content: [] },
        }),
      ].join("\n"),
    );
    expect(parsed.stats.num_turns).toBe(2);
    expect(parsed.stats.total_cost_usd).toBeGreaterThan(0);
    expect(parsed.stats.cost_estimated).toBe(true);
  });

  test("handles malformed events without throwing and keeps healthy results clean", () => {
    const parsed = parseClaudeEvents(
      [
        "null",
        "[]",
        JSON.stringify({ type: "assistant", message: "invalid" }),
        JSON.stringify({
          type: "assistant",
          message: { id: 42, usage: { input_tokens: "5" }, content: [{ type: "text", text: 12 }] },
        }),
        JSON.stringify({ type: "result", duration_ms: "10", total_cost_usd: null, num_turns: {} }),
      ].join("\n"),
    );
    expect(parsed.text).toBe("");
    expect(parsed.stats.duration_ms).toBe(0);
    expect(parsed.stats.input_tokens).toBe(0);
    expect(parsed.stats.num_turns).toBe(1);
    expect(parsed.transportError).toBeUndefined();
  });

  test("captures final text without duplicating result and retains interrupted structured output", () => {
    const complete = parseClaudeEvents(
      [
        JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "final answer" }] } }),
        JSON.stringify({ type: "result", result: "final answer", total_cost_usd: 0.01 }),
      ].join("\n"),
    );
    expect(complete.text).toBe("final answer");
    const interrupted = parseClaudeEvents(
      JSON.stringify({
        type: "assistant",
        message: { id: "m1", content: [{ type: "tool_use", name: "StructuredOutput", input: { success: false } }] },
      }),
    );
    expect(interrupted.structuredOutput).toEqual({ success: false });
    expect(interrupted.stats.tools_used).toBeUndefined();
  });

  test("classifies 529 overload and 429 quota with reset time", () => {
    const overloaded = parseClaudeEvents(
      JSON.stringify({
        type: "result",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        result: "API Error: 529 Overloaded",
      }),
    );
    expect(overloaded.transportError?.status).toBe(529);
    expect(isOverloaded(overloaded.transportError!)).toBe(true);
    const resetsAt = 1_785_405_000;
    const quota = parseClaudeEvents(
      [
        JSON.stringify({ type: "rate_limit_event", rate_limit_info: { resetsAt } }),
        JSON.stringify({
          type: "result",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 429,
          result: "session limit",
        }),
      ].join("\n"),
    );
    expect(quota.transportError?.resetsAt).toBe(resetsAt * 1000);
    expect(isOverloaded(quota.transportError!)).toBe(false);
  });
});

// The stream comes from a CLI the runner does not version: a new event type, a
// new key on a known event, or a missing optional block must all leave the rest
// of the parse intact. See `events.schema.ts`.
describe("Claude JSONL events: tolerance of an unknown or partial stream", () => {
  const known = [
    JSON.stringify({ type: "system", model: "claude-sonnet-4-6", session_id: "s1" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    JSON.stringify({ type: "result", duration_ms: 7, total_cost_usd: 0.25 }),
  ];

  test("an event type this release does not know is ignored, never fatal", () => {
    const parsed = parseClaudeEvents(
      [
        known[0]!,
        JSON.stringify({ type: "telemetry_v9", session_id: "s1", payload: { anything: [1, 2, 3] } }),
        known[1]!,
        known[2]!,
      ].join("\n"),
    );
    expect(parsed.text).toBe("hi");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.stats.input_tokens).toBe(10);
    expect(parsed.stats.total_cost_usd).toBe(0.25);
  });

  test("an extra key on a known event changes nothing", () => {
    const base = parseClaudeEvents(known.join("\n"));
    const extended = parseClaudeEvents(
      [
        JSON.stringify({ type: "system", model: "claude-sonnet-4-6", session_id: "s1", cwd: "/tmp", tools: ["Read"] }),
        JSON.stringify({
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "m1",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "hi", citations: [] }],
            usage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
          },
        }),
        JSON.stringify({ type: "result", duration_ms: 7, total_cost_usd: 0.25, permission_denials: [] }),
      ].join("\n"),
    );
    expect(extended).toEqual(base);
  });

  test("an assistant message without a usage block counts no turn and no token", () => {
    const parsed = parseClaudeEvents(
      [
        known[0]!,
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", model: "claude-sonnet-4-6", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({ type: "result", duration_ms: 7 }),
      ].join("\n"),
    );
    expect(parsed.text).toBe("hi");
    expect(parsed.turnsInProcess).toBe(0);
    expect(parsed.stats.input_tokens).toBeUndefined();
    expect(parsed.stats.total_cost_usd).toBeUndefined();
  });

  test("a line that is not JSON is dropped without touching the others", () => {
    const parsed = parseClaudeEvents(["not json at all", ...known].join("\n"));
    expect(parsed.text).toBe("hi");
    expect(parsed.stats.total_cost_usd).toBe(0.25);
  });
  test("classifies missing credentials as an authentication failure, narrowly", () => {
    const notLoggedIn = parseClaudeEvents(
      JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
    );
    expect(isAuthFailure(notLoggedIn.transportError!)).toBe(true);
    expect(isAuthFailure({ status: 401, message: "unauthorized" })).toBe(true);
    expect(isAuthFailure({ status: 403, message: "forbidden" })).toBe(true);
    // A status wins over wording: a 529 whose body mentions login is still an overload.
    expect(isAuthFailure({ status: 529, message: "please run /login" })).toBe(false);
    expect(isAuthFailure({ message: "API Error: 529 Overloaded" })).toBe(false);
    expect(isAuthFailure({ message: "session limit" })).toBe(false);
  });
});

describe("textFromAssistantEvent", () => {
  test("reads the text blocks of an assistant message under its id", () => {
    const event = {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "text", text: "Reading " },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "the file." },
        ],
      },
    };
    expect(textFromAssistantEvent(event)).toEqual({ key: "m1", text: "Reading the file.\n" });
  });

  test("keeps a trailing newline and falls back to the text as identity", () => {
    expect(
      textFromAssistantEvent({ type: "assistant", message: { content: [{ type: "text", text: "done\n" }] } }),
    ).toEqual({ key: "done\n", text: "done\n" });
  });

  test("ignores events without agent text", () => {
    expect(textFromAssistantEvent({ type: "system", model: "opus" })).toBeUndefined();
    expect(textFromAssistantEvent({ type: "result", result: "ok" })).toBeUndefined();
    expect(
      textFromAssistantEvent({
        type: "assistant",
        message: { id: "m2", content: [{ type: "tool_use", name: "Bash" }] },
      }),
    ).toBeUndefined();
    expect(textFromAssistantEvent("not an event")).toBeUndefined();
  });
});
