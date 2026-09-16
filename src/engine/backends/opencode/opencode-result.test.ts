import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitAttemptStats } from "../../../state/stats/stats.js";
import { mapOpencodeExecutionResult } from "./result.js";
import { OPENCODE_MODEL, type RawOpencodeExecutionResult } from "./types.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

function raw(overrides: Partial<RawOpencodeExecutionResult> = {}): RawOpencodeExecutionResult {
  return { output: "", logs: "", code: 0, killed: false, durationMs: 1234, ...overrides };
}

function verdictEvent(verdict: string): string {
  return JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "prt_1", text: verdict } });
}

const PRICED_STEP = JSON.stringify({
  type: "step_finish",
  sessionID: "ses_1",
  part: { type: "step-finish", tokens: { total: 500, input: 400, output: 100 }, cost: 0.25 },
});

const UNPRICED_STEP = JSON.stringify({
  type: "step_finish",
  sessionID: "ses_1",
  part: { type: "step-finish", tokens: { total: 500, input: 400, output: 100 } },
});

test("mapOpencodeExecutionResult: a 3-step run lands on the contract", () => {
  const result = mapOpencodeExecutionResult(raw({ output: fixture("run-3-steps.jsonl") }), {
    outputFormat: "json",
    model: OPENCODE_MODEL.NEMOTRON_3_ULTRA,
  });

  expect(result.ok).toBe(true);
  expect(result.provider).toBe("opencode");
  expect(result.session).toEqual({ provider: "opencode", id: "ses_fd1c70662ffeSWyyKAUBuTYZH2", resumable: true });
  expect(result.structuredOutput).toMatchObject({ success: true });
  expect(result.stats).toMatchObject({
    provider: "opencode",
    model: OPENCODE_MODEL.NEMOTRON_3_ULTRA,
    duration_ms: 1234,
    num_turns: 3,
    input_tokens: 20_484,
    output_tokens: 237,
    reasoning_tokens: 119,
    tools_used: ["read", "write"],
    last_turn_context_tokens: 7093,
  });
  // The window is not in the stream and no table is trustworthy for a third-party
  // model: an occupancy without a window beats a guessed percentage.
  expect(result.stats.context_window).toBeUndefined();
});

test("mapOpencodeExecutionResult: a provider-reported cost is exact, never flagged as an estimate", () => {
  const result = mapOpencodeExecutionResult(raw({ output: [PRICED_STEP, verdictEvent("done")].join("\n") }), {
    model: "opencode/paid",
  });

  expect(result.stats.total_cost_usd).toBe(0.25);
  expect(result.stats.cost_estimated).toBeUndefined();
});

test("mapOpencodeExecutionResult: `cost: 0` on a run that spent tokens is an unpriced model, not a free one", () => {
  // opencode always emits `cost`, and writes 0 whenever it cannot price the model.
  // Reading that as an exact $0.00 is what kept `max_cost_usd` from ever firing on
  // a custom provider: the amount stays 0, its status becomes unknown.
  const result = mapOpencodeExecutionResult(raw({ output: fixture("run-3-steps.jsonl") }), {
    model: OPENCODE_MODEL.NEMOTRON_3_ULTRA,
  });

  expect(result.stats.total_cost_usd).toBe(0);
  expect(result.stats.cost_estimated).toBeUndefined();
  expect(splitAttemptStats(result.stats).control.cost_unknown).toBe(true);
});

test("mapOpencodeExecutionResult: `cost: 0` without a single token is a genuine free turn", () => {
  const freeStep = JSON.stringify({
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", tokens: { total: 0, input: 0, output: 0 }, cost: 0 },
  });
  const result = mapOpencodeExecutionResult(raw({ output: [freeStep, verdictEvent("done")].join("\n") }), {
    model: OPENCODE_MODEL.NEMOTRON_3_ULTRA,
  });

  expect(result.stats.total_cost_usd).toBe(0);
  expect(splitAttemptStats(result.stats).control.cost_unknown).toBeUndefined();
});

test("mapOpencodeExecutionResult: an unpriced step reports cost_unknown, not another model's rate", () => {
  const result = mapOpencodeExecutionResult(raw({ output: [UNPRICED_STEP, verdictEvent("done")].join("\n") }), {
    model: "opencode/model-nobody-priced",
  });

  expect(result.stats.total_cost_usd).toBeUndefined();
  expect(splitAttemptStats(result.stats).control.cost_unknown).toBe(true);
});

test("mapOpencodeExecutionResult: an `error` event is a technical failure", () => {
  const result = mapOpencodeExecutionResult(raw({ output: fixture("run-upstream-error.jsonl"), code: 1 }), {
    outputFormat: "json",
  });

  expect(result.ok).toBe(false);
  expect(result.failKind).toBe("technical");
  expect(result.failReason).toContain("Upstream error from Nvidia");
});

test("mapOpencodeExecutionResult: a failure visible only on stderr is still reported", () => {
  // opencode retries `stream error` silently: without these logs the run looks
  // like an empty success followed by a non-zero exit code.
  const result = mapOpencodeExecutionResult(raw({ output: "", logs: fixture("stream-error.log"), code: 1 }), {
    outputFormat: "json",
  });

  expect(result.ok).toBe(false);
  expect(result.failKind).toBe("technical");
  expect(result.failReason).toContain("Upstream error from Nvidia");
});

test("mapOpencodeExecutionResult: a `success:false` verdict is a verdict failure, not a technical one", () => {
  const verdict = '```json:verdict\n{"success": false, "reason": "tests rouges"}\n```';
  const result = mapOpencodeExecutionResult(raw({ output: verdictEvent(verdict) }), { outputFormat: "json" });

  expect(result.ok).toBe(false);
  expect(result.failKind).toBe("verdict");
  expect(result.failReason).toBe("tests rouges");
});

test("mapOpencodeExecutionResult: a captured field in the fence reaches structuredOutput", () => {
  const verdict = '```json:verdict\n{"success": true, "reason": "ok", "commit": "feat: capture"}\n```';
  const result = mapOpencodeExecutionResult(raw({ output: verdictEvent(verdict) }), { outputFormat: "json" });

  expect(result.ok).toBe(true);
  // The raw fence object, not the normalized verdict: `capture` reads `commit` here.
  expect(result.structuredOutput).toEqual({ success: true, reason: "ok", commit: "feat: capture" });
});

test("mapOpencodeExecutionResult: a missing verdict in JSON mode is technical", () => {
  // opencode has no `--output-schema` and no StructuredOutput tool: the verdict
  // rides in the prompt, so a small model can simply not produce it.
  const result = mapOpencodeExecutionResult(raw({ output: verdictEvent("done, everything is fine") }), {
    outputFormat: "json",
  });

  expect(result.ok).toBe(false);
  expect(result.failKind).toBe("technical");
  expect(result.failReason).toContain("verdict");
});

test("mapOpencodeExecutionResult: text mode needs no verdict", () => {
  const result = mapOpencodeExecutionResult(raw({ output: verdictEvent("juste du texte") }), {
    outputFormat: "text",
  });

  expect(result.ok).toBe(true);
  expect(result.output).toBe("juste du texte");
  expect(result.structuredOutput).toBeUndefined();
});

test("mapOpencodeExecutionResult: a killed run carries its reason, and timeouts alone set timedOut", () => {
  const timedOut = mapOpencodeExecutionResult(raw({ killed: true, killReason: "timeout (900s)", code: null }), {
    outputFormat: "json",
  });
  expect(timedOut.ok).toBe(false);
  expect(timedOut.timedOut).toBe(true);
  expect(timedOut.failReason).toContain("timeout (900s)");

  const starved = mapOpencodeExecutionResult(
    raw({ killed: true, killReason: "no first event within 90000ms", code: null }),
    { outputFormat: "json" },
  );
  expect(starved.timedOut).toBe(false);
  expect(starved.failReason).toContain("no first event");
});
