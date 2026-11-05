import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend } from "./backend.js";
import { executeClaude } from "./execution.js";
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

test("ClaudeBackend: the live cost sink reaches the execution", async () => {
  let seen: ClaudeExecutionOptions | undefined;
  const host: ClaudeBackendHost = {
    execute: async (options) => {
      seen = options;
      return { output: JSON.stringify({ type: "result", duration_ms: 1 }), code: 0, killed: false, durationMs: 1 };
    },
  };
  const onLiveCost = () => {};

  await new ClaudeBackend(undefined, host).run({ prompt: "x", onLiveCost });

  expect(seen?.onLiveCost).toBe(onLiveCost);
});
