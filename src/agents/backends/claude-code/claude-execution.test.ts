import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend } from "./backend.js";
import { parseClaudeEvents } from "./events.js";
import { createNodeClaudeHost, executeClaude } from "./execution.js";
import type { ClaudeBackendHost, ClaudeExecutionOptions } from "./types.js";

function fakeClaude(lines: readonly string[]): string {
  const bin = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "claude");
  writeFileSync(bin, ["#!/bin/sh", ...lines.map((line) => `echo '${line}'`)].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function recordTicks(): {
  ticks: Array<[number | undefined, string | undefined]>;
  onLiveCost: (c?: number, m?: string) => void;
} {
  const ticks: Array<[number | undefined, string | undefined]> = [];
  return { ticks, onLiveCost: (costUsd, model) => ticks.push([costUsd, model]) };
}

test("executeClaude: a fresh spawn starts from nothing and publishes the running estimate", async () => {
  const { ticks, onLiveCost } = recordTicks();

  await executeClaude({
    bin: fakeClaude(['{"type":"result","total_cost_usd":0.5}']),
    args: [],
    claudeOptions: { model: "claude-opus-5-5" },
    onLiveCost,
  });

  expect(ticks).toEqual([
    [undefined, undefined],
    [0.5, "claude-opus-5-5"],
  ]);
});

test("executeClaude: a transport retry starts from the discarded attempts and adds to them", async () => {
  const { ticks, onLiveCost } = recordTicks();

  await executeClaude({
    bin: fakeClaude(['{"type":"result","total_cost_usd":0.5}']),
    args: [],
    claudeOptions: { model: "claude-opus-5-5" },
    priorAttemptsCostUsd: 0.25,
    onLiveCost,
  });

  expect(ticks).toEqual([
    [0.25, undefined],
    [0.75, "claude-opus-5-5"],
  ]);
});

const MODEL = "claude-sonnet-4-6";

test.each([
  ["no cost", {}],
  // A reported 0 over consumed tokens is the CLI failing to price the turn.
  ["a cost of 0", { total_cost_usd: 0 }],
])(
  "executeClaude: the live cost ends on the output tokens the result event settles, without killing the finished attempt, with %s reported",
  async (_label, reported) => {
    // An `assistant` event carries the usage its message STARTED with: 1 output
    // token for a message that then wrote 100k. Only `result` holds the real count.
    const messages = [
      JSON.stringify({
        type: "assistant",
        message: { id: "m1", model: MODEL, usage: { input_tokens: 1000, output_tokens: 1 } },
      }),
    ];
    const result = JSON.stringify({ type: "result", duration_ms: 1, usage: { output_tokens: 100_000 }, ...reported });
    const unsettled = parseClaudeEvents(messages.join("\n"), MODEL).stats.total_cost_usd ?? 0;
    const settled = parseClaudeEvents([...messages, result].join("\n"), MODEL).stats.total_cost_usd ?? 0;
    const budgetRemaining = (unsettled + settled) / 2;

    const live: number[] = [];

    const raw = await executeClaude({
      bin: fakeClaude([...messages, result]),
      args: [],
      claudeOptions: { model: MODEL },
      budgetRemaining,
      onLiveCost: (usd) => {
        if (usd != null) live.push(usd);
      },
    });

    expect(raw.kill).toBeUndefined();
    expect(live.at(-1)).toBeCloseTo(settled, 12);
    expect(raw.stream.stats.total_cost_usd).toBeCloseTo(settled, 12);
  },
);

test("executeClaude: the live cost ends on the final cost, repeats and usage-less copies included", async () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: MODEL }),
    // The CLI splits a message over several events of the same id; the first one
    // here carries no usage, the second one does and must still be counted.
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Reading." }] } }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        model: MODEL,
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }],
        usage: { input_tokens: 2000, output_tokens: 5, cache_read_input_tokens: 10_000 },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m2",
        model: MODEL,
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 500, output_tokens: 3 },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m2",
        model: MODEL,
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 500, output_tokens: 3 },
      },
    }),
    JSON.stringify({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done." }] } }),
  ];
  const { ticks, onLiveCost } = recordTicks();
  const events: Array<{ event?: string }> = [];

  const raw = await executeClaude(
    { bin: fakeClaude(lines), args: [], claudeOptions: { model: MODEL }, onLiveCost },
    createNodeClaudeHost({ onEvent: (event) => events.push(event as { event?: string }) }),
  );

  const final = parseClaudeEvents(lines.join("\n"), MODEL).stats.total_cost_usd;
  expect(final).toBeGreaterThan(0);
  expect(ticks.at(-1)?.[0]).toBeCloseTo(final ?? 0, 12);
  expect(raw.stream.stats.total_cost_usd).toBeCloseTo(final ?? 0, 12);
  expect(events.filter((event) => event.event === "activity")).toHaveLength(2);
});

test("ClaudeBackend: the live cost sink reaches the execution", async () => {
  let seen: ClaudeExecutionOptions | undefined;
  const host: ClaudeBackendHost = {
    execute: async (options) => {
      seen = options;
      const output = JSON.stringify({ type: "result", duration_ms: 1 });
      return { output, stream: parseClaudeEvents(output), code: 0, durationMs: 1 };
    },
  };
  const onLiveCost = () => {};

  await new ClaudeBackend(undefined, host).run({ prompt: "x", onLiveCost });

  expect(seen?.onLiveCost).toBe(onLiveCost);
});
