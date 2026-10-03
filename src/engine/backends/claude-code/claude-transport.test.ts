import { describe, expect, test } from "bun:test";
import { parseClaudeEvents } from "./events.js";
import { mapClaudeExecutionResult } from "./result.js";
import {
  executeClaudeWithTransportRetry,
  type RateLimitWait,
  rateLimitMaxWaitMs,
  retryOptionsForSession,
  transportBackoffDelays,
} from "./transport.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_785_400_000_000;

function quotaSpawn(resetsAtMs: number) {
  return {
    output: [
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { resetsAt: resetsAtMs / 1000 } }),
      JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "session limit" }),
    ].join("\n"),
    code: 1,
    killed: false,
    durationMs: 1,
  };
}

const success = { output: JSON.stringify({ type: "result", duration_ms: 1 }), code: 0, killed: false, durationMs: 1 };

function fakeWait(maxWaitMs: number): RateLimitWait & { slept: number[]; logs: string[] } {
  const slept: number[] = [];
  const logs: string[] = [];
  return {
    maxWaitMs,
    now: () => NOW,
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (m) => logs.push(m),
    slept,
    logs,
  };
}

function runWith(spawns: Array<ReturnType<typeof quotaSpawn>>, wait: RateLimitWait) {
  let calls = 0;
  const run = executeClaudeWithTransportRetry(
    { bin: "claude", args: [] },
    async () => spawns[Math.min(calls++, spawns.length - 1)]!,
    (output) => parseClaudeEvents(output),
    [],
    undefined,
    undefined,
    wait,
  );
  return run.then((result) => ({ result, calls }));
}

describe("Claude transport", () => {
  test("does not retry 429 and retries overload 529", () => {
    const env = { RUNNER_TRANSPORT_BACKOFF_MS: "0,10" };
    expect(transportBackoffDelays(env)).toEqual([0, 10]);
  });

  test("absorbs a 529 but returns a 429 immediately", async () => {
    const previous = process.env.RUNNER_TRANSPORT_BACKOFF_MS;
    process.env.RUNNER_TRANSPORT_BACKOFF_MS = "0";
    try {
      let overloadCalls = 0;
      const overload = await executeClaudeWithTransportRetry(
        { bin: "claude", args: [] },
        async () => {
          overloadCalls++;
          return overloadCalls === 1
            ? {
                output: JSON.stringify({
                  type: "result",
                  is_error: true,
                  terminal_reason: "api_error",
                  api_error_status: 529,
                  result: "overloaded",
                }),
                code: 0,
                killed: false,
                durationMs: 1,
              }
            : { output: JSON.stringify({ type: "result", duration_ms: 1 }), code: 0, killed: false, durationMs: 1 };
        },
        (output) => parseClaudeEvents(output),
      );
      expect(overloadCalls).toBe(2);
      expect(parseClaudeEvents(overload.output).transportError).toBeUndefined();

      let quotaCalls = 0;
      await executeClaudeWithTransportRetry(
        { bin: "claude", args: [] },
        async () => {
          quotaCalls++;
          return {
            output: JSON.stringify({
              type: "result",
              is_error: true,
              terminal_reason: "api_error",
              api_error_status: 429,
              result: "quota",
            }),
            code: 0,
            killed: false,
            durationMs: 1,
          };
        },
        (output) => parseClaudeEvents(output),
      );
      expect(quotaCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.RUNNER_TRANSPORT_BACKOFF_MS;
      else process.env.RUNNER_TRANSPORT_BACKOFF_MS = previous;
    }
  });

  test("waits for a usage limit to reset, then retries the spawn", async () => {
    const wait = fakeWait(6 * HOUR);
    const { result, calls } = await runWith([quotaSpawn(NOW + 2 * HOUR), success], wait);
    expect(calls).toBe(2);
    expect(parseClaudeEvents(result.output).transportError).toBeUndefined();
    // One minute past the announced reset, so the retry does not race the provider's clock.
    expect(wait.slept).toEqual([2 * HOUR + 60_000]);
    expect(wait.logs).toHaveLength(1);
    expect(wait.logs[0]).toContain("usage limit reached");
    expect(result.priorAttemptsDurationMs).toBe(1 + 2 * HOUR + 60_000);
  });

  test.each([
    ["the reset is past the ceiling", 6 * HOUR, NOW + 7 * HOUR],
    ["waiting is disabled", 0, NOW + 60_000],
  ])("returns a usage limit at once when %s", async (_label, maxWaitMs, resetsAt) => {
    const wait = fakeWait(maxWaitMs);
    const { result, calls } = await runWith([quotaSpawn(resetsAt)], wait);
    expect(calls).toBe(1);
    expect(wait.slept).toEqual([]);
    expect(parseClaudeEvents(result.output).transportError?.status).toBe(429);
  });

  test("stops waiting after three resets that did not reopen the quota", async () => {
    const wait = fakeWait(6 * HOUR);
    const { calls } = await runWith([quotaSpawn(NOW - 1000)], wait);
    expect(calls).toBe(4);
    expect(wait.slept).toEqual([60_000, 60_000, 60_000]);
  });

  test("reads the wait ceiling from the environment, falling back on a bad value", () => {
    expect(rateLimitMaxWaitMs({})).toBe(6 * HOUR);
    expect(rateLimitMaxWaitMs({ RUNNER_RATE_LIMIT_MAX_WAIT_MS: "0" })).toBe(0);
    expect(rateLimitMaxWaitMs({ RUNNER_RATE_LIMIT_MAX_WAIT_MS: "60000" })).toBe(60_000);
    expect(rateLimitMaxWaitMs({ RUNNER_RATE_LIMIT_MAX_WAIT_MS: "soon" })).toBe(6 * HOUR);
  });

  test("converts a created session into a resume on transport retry", () => {
    const options = { bin: "claude", args: ["--session-id", "s1", "-p", "x"] };
    const retried = retryOptionsForSession(options, (id) => id === "s1");
    expect(retried.args).toEqual(["--resume", "s1", "-p", "x"]);
  });

  test.each([
    ["exhausts", 0.5],
    ["exceeds", 0.6],
  ])("does not retry a 529 when its cost %s the remaining budget", async (_label, cost) => {
    const seenBudgets: Array<number | undefined> = [];
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: [], budgetRemaining: 0.5 },
      async (options) => {
        seenBudgets.push(options.budgetRemaining);
        return {
          output: JSON.stringify({
            type: "result",
            is_error: true,
            terminal_reason: "api_error",
            api_error_status: 529,
            result: "overloaded",
            total_cost_usd: cost,
          }),
          code: 0,
          killed: false,
          durationMs: 1,
        };
      },
      (output) => parseClaudeEvents(output),
      [0],
    );

    expect(seenBudgets).toEqual([0.5]);
    expect(parseClaudeEvents(result.output).transportError?.status).toBe(529);
    expect(result.priorAttemptsCostUsd).toBeUndefined();
  });

  test("charges a resumed spawn by difference against the restored session ledger", async () => {
    const seenBaselines: Array<number | undefined> = [];
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: ["--resume", "s1", "-p", "x"] },
      async (options) => {
        seenBaselines.push(options.sessionCostBaselineUsd);
        // The CLI reports the WHOLE session: $3 of coder plus $0.50 of this pass.
        return {
          output: JSON.stringify({ type: "result", duration_ms: 1, total_cost_usd: 3.5, duration_api_ms: 900 }),
          code: 0,
          killed: false,
          durationMs: 1,
        };
      },
      (output) => parseClaudeEvents(output),
      [0],
      () => true,
      () => ({ costUsd: 3, apiDurationMs: 600 }),
    );

    expect(seenBaselines).toEqual([3]);
    expect(result.resumeBaseline).toEqual({ costUsd: 3, apiDurationMs: 600 });
  });

  test("does not charge an overload retry twice for the attempt it resumes", async () => {
    let calls = 0;
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: ["--session-id", "s1", "-p", "x"], budgetRemaining: 5 },
      async () => {
        calls++;
        const output =
          calls === 1
            ? JSON.stringify({
                type: "result",
                is_error: true,
                terminal_reason: "api_error",
                api_error_status: 529,
                result: "overloaded",
                total_cost_usd: 0.4,
              })
            : // Resumed: $0.40 of the discarded attempt plus $0.30 of its own.
              JSON.stringify({ type: "result", duration_ms: 1, total_cost_usd: 0.7 });
        return { output, code: 0, killed: false, durationMs: 1 };
      },
      (output) => parseClaudeEvents(output),
      [0],
      () => true,
      // The discarded attempt has not flushed its cost-state yet: the floor at the
      // cost already charged is what keeps it from being charged again.
      () => null,
    );

    expect(calls).toBe(2);
    expect(result.priorAttemptsCostUsd).toBeCloseTo(0.4, 10);
    expect(result.resumeBaseline?.costUsd).toBeCloseTo(0.4, 10);
  });

  test("does not repay a fix pass's discarded attempt when the session already held the coder's ledger", async () => {
    const seenBaselines: Array<number | undefined> = [];
    let calls = 0;
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: ["--resume", "coder", "-p", "fix"], budgetRemaining: 20 },
      async (options) => {
        seenBaselines.push(options.sessionCostBaselineUsd);
        calls++;
        const output =
          calls === 1
            ? // Coder session at $10, this pass spent $2 before the overload.
              JSON.stringify({
                type: "result",
                is_error: true,
                terminal_reason: "api_error",
                api_error_status: 529,
                result: "overloaded",
                total_cost_usd: 12,
              })
            : // Resumed once more: $12 restored plus $1 of its own.
              JSON.stringify({ type: "result", duration_ms: 1, total_cost_usd: 13 });
        return { output, code: 0, killed: false, durationMs: 1 };
      },
      (output) => parseClaudeEvents(output),
      [0],
      () => true,
      // The overloaded pass never flushed its cost-state: the ledger on disk still
      // reads the coder's $10. A floor at the $2 already charged would sit BELOW
      // that and charge the $2 a second time through the difference.
      () => ({ costUsd: 10 }),
    );

    expect(calls).toBe(2);
    expect(seenBaselines).toEqual([10, 12]);
    expect(result.priorAttemptsCostUsd).toBeCloseTo(2, 10);
    expect(result.resumeBaseline?.costUsd).toBeCloseTo(12, 10);
    // $1 for the final pass, $2 for the discarded one: never the coder's $10.
    expect(mapClaudeExecutionResult(result, {}).stats.total_cost_usd).toBeCloseTo(3, 10);
  });

  test("hands the discarded attempts' cost to the retry so its live estimate includes them", async () => {
    const seenPrior: Array<number | undefined> = [];
    const overloaded = (cost: number) =>
      JSON.stringify({
        type: "result",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        result: "overloaded",
        total_cost_usd: cost,
      });
    let calls = 0;
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: [], budgetRemaining: 5 },
      async (options) => {
        seenPrior.push(options.priorAttemptsCostUsd);
        calls++;
        const output =
          calls < 3 ? overloaded(0.2) : JSON.stringify({ type: "result", duration_ms: 1, total_cost_usd: 0.1 });
        return { output, code: 0, killed: false, durationMs: 1 };
      },
      (output) => parseClaudeEvents(output),
      [0, 0],
    );

    // First spawn: nothing before it. Second: the first's $0.20. Third: both.
    expect(seenPrior).toEqual([undefined, 0.2, 0.4]);
    expect(result.priorAttemptsCostUsd).toBeCloseTo(0.4);
  });

  test("carries the wall time of the discarded attempts and their backoff to the last spawn", async () => {
    const overloaded = JSON.stringify({
      type: "result",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 529,
      result: "overloaded",
    });
    let calls = 0;
    const result = await executeClaudeWithTransportRetry(
      { bin: "claude", args: [] },
      async () => {
        calls++;
        // The final spawn is killed by the timeout: no `result`, wall time only.
        return calls === 1
          ? { output: overloaded, code: 0, killed: false, durationMs: 300 }
          : { output: "", code: null, killed: true, killReason: "timeout (1s)", durationMs: 900 };
      },
      (output) => parseClaudeEvents(output),
      [5],
    );

    expect(result.durationMs).toBe(900);
    expect(result.priorAttemptsDurationMs).toBe(305);
    expect(mapClaudeExecutionResult(result, {}).stats.duration_ms).toBe(1205);
  });
});
