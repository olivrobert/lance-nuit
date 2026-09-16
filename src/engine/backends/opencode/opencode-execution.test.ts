import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityRunnerEvent, ContextRunnerEvent } from "../../../runtime/events.js";
import { clearLiveAttemptCost, liveAttemptCost } from "../../../runtime/live-cost.js";
import { parseOpencodeLogErrors } from "./events.js";
import { createNodeOpencodeHost, executeOpencode } from "./execution.js";

/** Writes an executable stand-in for the `opencode` binary. */
function fakeOpencode(name: string, lines: readonly string[]): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `opencode-${name}-`));
  const bin = join(dir, "fake-opencode");
  writeFileSync(bin, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, dir };
}

function emit(json: string): string {
  return `printf '%s\\n' '${json}'`;
}

const TEXT_EVENT = '{"type":"text","part":{"id":"prt_1","text":"done"}}';
const READ_TOOL =
  '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"/repo/data.txt"}}}}';
const BASH_TOOL =
  '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls -la"}}}}';
const STEP_FINISH =
  '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":6730,"input":6592,"output":83,"cache":{"read":0,"write":0}},"cost":0}}';

test("executeOpencode: stdin is closed, so a binary that drains it still completes", async () => {
  // `opencode run` aggregates stdin into the prompt: with stdin left open it waits
  // for an EOF forever, emitting zero byte on stdout AND stderr. This is the most
  // expensive failure mode of the backend, so it gets its own lock.
  const { bin, dir } = fakeOpencode("stdin", ["cat >/dev/null", emit(TEXT_EVENT)]);

  const result = await executeOpencode({ bin, args: ["run"], env: {}, cwd: dir, timeoutMs: 1_500 });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  expect(result.output).toContain("done");
}, 15_000);

test("executeOpencode: stderr is captured, not only forwarded", async () => {
  // opencode retries `stream error` silently: a hard failure (billing, auth) can
  // leave stdout empty while stderr carries the only explanation.
  const logLine =
    'timestamp=2026-08-23T10:44:02.535Z level=ERROR run=fb15 message="stream error" error.error="Insufficient balance or no resource package"';
  const { bin, dir } = fakeOpencode("stderr", [`printf '%s\\n' '${logLine}' >&2`, "exit 1"]);
  const forwarded: string[] = [];

  const host = createNodeOpencodeHost({ appendLiveLogs: (text) => forwarded.push(text) });
  const result = await host.execute({ bin, args: ["run"], env: {}, cwd: dir, timeoutMs: 5_000 });

  expect(result.output).toBe("");
  expect(result.code).toBe(1);
  expect(result.logs).toContain("level=ERROR");
  expect(parseOpencodeLogErrors(result.logs)).toBe("Insufficient balance or no resource package");
  expect(forwarded.join("")).toContain("stream error");
}, 15_000);

test("executeOpencode: the first-event deadline kills a run that never emits", async () => {
  const { bin, dir } = fakeOpencode("first-event", ["sleep 30"]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    firstEventTimeoutMs: 200,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(true);
  expect(result.killReason).toContain("first event");
}, 20_000);

test("executeOpencode: a slow model that did emit is not killed by the first-event deadline", async () => {
  // A model never called before can take over 60s to warm up, then answer in 1.4s:
  // the deadline must watch the first event, not the total duration.
  const { bin, dir } = fakeOpencode("cold-start", [emit(TEXT_EVENT), "sleep 1", emit(STEP_FINISH)]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    firstEventTimeoutMs: 300,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  expect(result.durationMs).toBeGreaterThanOrEqual(900);
}, 20_000);

test("executeOpencode: the caller owns the environment, process.env does not leak", async () => {
  // Without an override the user's `~/.claude/CLAUDE.md` reaches every run:
  // ~1250 input tokens of personal instructions inside a deterministic agent.
  const { bin, dir } = fakeOpencode("env", [
    `printf '%s\\n' "{\\"type\\":\\"text\\",\\"part\\":{\\"id\\":\\"p\\",\\"text\\":\\"disable=\${OPENCODE_DISABLE_CLAUDE_CODE} leak=\${LANCE_NUIT_LEAK_PROBE}\\"}}"`,
  ]);
  process.env.LANCE_NUIT_LEAK_PROBE = "leaked-value";

  try {
    const result = await executeOpencode({
      bin,
      args: ["run"],
      env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      cwd: dir,
      timeoutMs: 5_000,
    });

    expect(result.output).toContain("disable=1");
    expect(result.output).not.toContain("leaked-value");
  } finally {
    delete process.env.LANCE_NUIT_LEAK_PROBE;
  }
}, 15_000);

test("executeOpencode: a provider-reported cost above the remaining budget stops the run", async () => {
  const priced = '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":100},"cost":0.5}}';
  const { bin, dir } = fakeOpencode("budget", [emit(priced), "sleep 30"]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    budgetRemaining: 0.1,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(true);
  expect(result.killReason).toContain("budget exceeded");
  expect(liveAttemptCost()).toBe(0.5);
  clearLiveAttemptCost();
}, 20_000);

test("executeOpencode: a step priced by pricing.json is estimated live and can stop the run", async () => {
  // The provider reports tokens without a cost; the project declares a rate. The
  // guard must price it live exactly as the mapper prices it at the end, or such a
  // model is never stopped and a kill leaves `cost_unknown` on an estimable spend.
  const unpriced =
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":1000000,"input":1000000,"output":0,"cache":{"read":0,"write":0}}}}';
  const { bin, dir } = fakeOpencode("estimated", [emit(unpriced), "sleep 30"]);

  const host = createNodeOpencodeHost({ projectPricing: { _currency: "$", "glm-5.2": { in: 0.6, out: 2.2 } } });
  const result = await host.execute({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "zai-coding-plan/glm-5.2",
    budgetRemaining: 0.1,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(true);
  expect(result.killReason).toContain("budget exceeded");
  expect(result.killReason).toContain("estimated");
  expect(liveAttemptCost()).toBeCloseTo(0.6);
  clearLiveAttemptCost();
}, 20_000);

test("executeOpencode: a step reported at `cost: 0` is estimated live and can stop the run", async () => {
  // opencode emits `cost: 0` for every model it cannot price. Trusting that zero
  // made the guard unfirable on custom providers, Copilot and Ollama: the declared
  // rate must take over exactly as it does for a missing cost field.
  const zeroPriced =
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":1000000,"input":1000000,"output":0,"cache":{"read":0,"write":0}},"cost":0}}';
  const { bin, dir } = fakeOpencode("zero-cost", [emit(zeroPriced), "sleep 30"]);

  const host = createNodeOpencodeHost({ projectPricing: { _currency: "$", "glm-5.2": { in: 0.6, out: 2.2 } } });
  const result = await host.execute({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "zai-coding-plan/glm-5.2",
    budgetRemaining: 0.1,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(true);
  expect(result.killReason).toContain("budget exceeded");
  expect(result.killReason).toContain("estimated");
  expect(liveAttemptCost()).toBeCloseTo(0.6);
  clearLiveAttemptCost();
}, 20_000);

test("executeOpencode: a `cost: 0` step with no declared rate never triggers a budget kill", async () => {
  // Unknown is not free: the run continues, and the report says the spend is
  // unaccounted rather than zero.
  const zeroPriced =
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":900000,"input":900000},"cost":0}}';
  const { bin, dir } = fakeOpencode("zero-cost-unpriced", [emit(zeroPriced), emit(TEXT_EVENT)]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "opencode/model-nobody-priced",
    budgetRemaining: 0.000001,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(false);
  clearLiveAttemptCost();
}, 20_000);

test("executeOpencode: an unpriced step never triggers a budget kill", async () => {
  // No pricing fallback: an unknown model must not be billed at the price of the
  // most expensive one. Absent `cost` means "unknown", not "free" and not "costly".
  const unpriced = '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":900000}}}';
  const { bin, dir } = fakeOpencode("unpriced", [emit(unpriced), emit(TEXT_EVENT)]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    budgetRemaining: 0.000_001,
    timeoutMs: 5_000,
  });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
}, 15_000);

test("executeOpencode: every tool_use publishes an activity event, every step_finish a context event", async () => {
  const { bin, dir } = fakeOpencode("events", [emit(READ_TOOL), emit(BASH_TOOL), emit(STEP_FINISH)]);
  const events: unknown[] = [];

  const host = createNodeOpencodeHost({
    onEvent: (event) => events.push(event),
    contextWindow: () => 200_000,
  });
  await host.execute({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "opencode/nemotron-3-ultra-free",
    timeoutMs: 5_000,
  });

  const activity = events.filter((e) => (e as ActivityRunnerEvent).event === "activity") as ActivityRunnerEvent[];
  expect(activity.map((e) => e.label)).toEqual(["Read data.txt", "Bash ls -la"]);
  expect(activity.map((e) => e.tool)).toEqual(["read", "bash"]);

  const context = events.filter((e) => (e as ContextRunnerEvent).event === "context") as ContextRunnerEvent[];
  expect(context).toHaveLength(1);
  expect(context[0]).toMatchObject({ tokens: 6730, window: 200_000, model: "opencode/nemotron-3-ultra-free" });
}, 15_000);

test("executeOpencode: live output and agent messages reach their seams", async () => {
  const { bin, dir } = fakeOpencode("live", [emit(TEXT_EVENT)]);
  const stepLogPath = join(dir, "step.log");
  const live: string[] = [];

  const host = createNodeOpencodeHost({ appendLiveOutput: (text) => live.push(text) });
  await host.execute({ bin, args: ["run"], env: {}, cwd: dir, stepLogPath, timeoutMs: 5_000 });

  expect(live.join("")).toContain("done");
  expect(readFileSync(stepLogPath, "utf8")).toContain("done");
}, 15_000);

test("executeOpencode: a descendant outliving the CLI rejects the run and is cleaned", async () => {
  // Same choice as the codex host, and the opposite of the Claude host, which
  // tolerates a straggler and keeps the CLI's verdict. Pinned here because the
  // verdict is now mapped explicitly from `killedForCleanup` in execution.ts.
  const { bin, dir } = fakeOpencode("orphan", [
    'PID_FILE="$(dirname "$0")/descendant.pid"',
    `(sleep 30 >/dev/null 2>&1 & echo $! > "$PID_FILE"; ${emit(TEXT_EVENT)}; exit 0)`,
  ]);
  const pidFile = join(dir, "descendant.pid");

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    timeoutMs: 15_000,
  });

  expect(result.killed).toBe(true);
  expect(result.killReason).toContain("descendants");
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  expect(() => process.kill(descendant, 0)).toThrow();
}, 20_000);

// --- NDJSON fragmentation through a real pipe -------------------------------
//
// The unit contract of the line reassembler is pinned in
// `engine/backends/host-helpers.test.ts`. These three cases run that same
// reassembler behind a real spawn, where the runtime — not the test — decides
// where each chunk ends: a lost line costs a usage record, a duplicated one
// charges a cost twice, and neither shows up in the transcript.

/** One `text` event per index, padded so a long stream crosses the pipe buffer.
 *  `pad` is an unknown key: the schema keeps the event and ignores it. */
function textEvents(count: number, padding: number): string[] {
  const pad = "x".repeat(padding);
  return Array.from(
    { length: count },
    (_unused, index) => `{"type":"text","part":{"id":"prt_${index}","text":"evt-${index}\\n"},"pad":"${pad}"}`,
  );
}

/** Fake `opencode` that streams a payload file with `cat`, so the chunk
 *  boundaries are the runtime's own rather than one printf per line. */
function fakeOpencodeStreaming(name: string, payload: string, trailer?: string): { bin: string; dir: string } {
  const { bin, dir } = fakeOpencode(name, []);
  const file = join(dir, "stream.ndjson");
  writeFileSync(file, payload);
  writeFileSync(bin, ["#!/bin/sh", `cat '${file}'`, ...(trailer ? [`printf '%s' '${trailer}'`] : [])].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test("executeOpencode: an NDJSON stream over 1 MB is parsed line by line, in order, without loss", async () => {
  const events = textEvents(5_000, 180);
  const payload = `${events.join("\n")}\n`;
  expect(payload.length).toBeGreaterThan(1_048_576);
  const { bin, dir } = fakeOpencodeStreaming("bulk", payload);
  const stepLogPath = join(dir, "step.log");
  const writes: string[] = [];

  const host = createNodeOpencodeHost({ appendLiveOutput: (text) => writes.push(text) });
  const result = await host.execute({ bin, args: ["run"], env: {}, cwd: dir, stepLogPath, timeoutMs: 30_000 });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  // Without several writes the test would prove nothing about fragmentation.
  expect(writes.length).toBeGreaterThan(1);
  // The step log holds one line per message, written once, in stream order.
  const logged = readFileSync(stepLogPath, "utf8").split("\n").slice(0, -1);
  expect(logged).toHaveLength(events.length);
  expect(logged.findIndex((line, index) => line !== `evt-${index}`)).toBe(-1);
}, 60_000);

test("executeOpencode: an event split across two writes is parsed once its tail arrives", async () => {
  const [event] = textEvents(1, 0);
  const cut = Math.floor(event!.length / 2);
  // Two printf calls with a pause between them: the pipe cannot coalesce them,
  // so the reader sees a truncated JSON object first.
  const { bin, dir } = fakeOpencode("split-line", [
    `printf '%s' '${event!.slice(0, cut)}'`,
    "sleep 0.15",
    `printf '%s\\n' '${event!.slice(cut)}'`,
    emit(TEXT_EVENT),
  ]);
  const stepLogPath = join(dir, "step.log");

  const result = await executeOpencode({ bin, args: ["run"], env: {}, cwd: dir, stepLogPath, timeoutMs: 15_000 });

  expect(result.code).toBe(0);
  expect(readFileSync(stepLogPath, "utf8")).toBe("evt-0\ndone");
}, 30_000);

test("executeOpencode: the last event of a stream that ends without a newline is still parsed", async () => {
  const events = textEvents(3, 0);
  const last = events.pop()!;
  // A CLI that exits without terminating its final line: the event carries the
  // run's last usage figures, so dropping it drops the cost of the whole turn.
  const { bin, dir } = fakeOpencodeStreaming("no-trailing-newline", `${events.join("\n")}\n`, last);
  const stepLogPath = join(dir, "step.log");

  const result = await executeOpencode({ bin, args: ["run"], env: {}, cwd: dir, stepLogPath, timeoutMs: 15_000 });

  expect(result.code).toBe(0);
  expect(result.output.endsWith("\n")).toBe(false);
  expect(readFileSync(stepLogPath, "utf8")).toBe("evt-0\nevt-1\nevt-2\n");
}, 30_000);

// --- Strict cost accounting: the live accounting guard ------------------------
//
// These three fixtures pin the whole contract of `strictCostAccounting`: it kills
// on PROVEN unpriceability, it does not kill when the operator authorized the
// unknown spend, and it never kills on silence. Each runs a real supervisor over
// a real process that would otherwise sleep for 30s, so a passing assertion on
// `killed` is also the proof the process group was cleaned up.

/** Tokens spent with a provider-reported `0`: `resolveOpencodeCost` calls this
 *  unknown, not free, whenever no table covers the model. */
const UNPRICED_STEP =
  '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":1000,"input":900,"output":100,"cache":{"read":0,"write":0}},"cost":0}}';

test("executeOpencode: unpriceable live usage stops the attempt as unaccounted, not as a budget stop", async () => {
  const { bin, dir } = fakeOpencode("unaccounted", [emit(UNPRICED_STEP), "sleep 30"]);

  const started = Date.now();
  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "vendor/model-nobody-prices",
    budgetRemaining: 5,
    strictCostAccounting: true,
    timeoutMs: 30_000,
  });

  expect(result.killed).toBe(true);
  // The distinct prefix is the contract `killFields` reads to raise
  // `costUnaccounted` rather than `budgetExceeded`.
  expect(result.killReason?.startsWith("cost unaccounted")).toBe(true);
  expect(result.killReason).toContain("--allow-unmetered");
  expect(result.killReason).not.toContain("budget exceeded");
  // The supervisor cleaned the group instead of waiting out the `sleep 30`.
  expect(Date.now() - started).toBeLessThan(20_000);
  clearLiveAttemptCost();
}, 25_000);

test("executeOpencode: an authorized run is not stopped by unpriceable live usage", async () => {
  // Same stream, `strictCostAccounting` absent: the run already accepted the
  // uncertainty, so the attempt must reach its own end.
  const { bin, dir } = fakeOpencode("unaccounted-authorized", [emit(UNPRICED_STEP), emit(TEXT_EVENT)]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "vendor/model-nobody-prices",
    budgetRemaining: 5,
    timeoutMs: 10_000,
  });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  expect(result.output).toContain("done");
  clearLiveAttemptCost();
}, 15_000);

test("executeOpencode: silence is not proof, so the accounting guard kills nothing", async () => {
  // An attempt that has reported no usage yet may still be priced at completion:
  // killing on the ABSENCE of usage events would stop every slow warm-up.
  const { bin, dir } = fakeOpencode("unaccounted-silent", [emit(TEXT_EVENT), emit(READ_TOOL)]);

  const result = await executeOpencode({
    bin,
    args: ["run"],
    env: {},
    cwd: dir,
    model: "vendor/model-nobody-prices",
    budgetRemaining: 5,
    strictCostAccounting: true,
    timeoutMs: 10_000,
  });

  expect(result.killed).toBe(false);
  expect(result.code).toBe(0);
  clearLiveAttemptCost();
}, 15_000);
