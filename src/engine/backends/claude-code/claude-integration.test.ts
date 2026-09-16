import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Outcome = { ok: boolean; output?: string; failReason?: string; timedOut?: boolean };

/** Base environment for a replayed backend spawn. `RUNNER_EVENTS_FILE` takes
 * precedence over `RUNNER_LIVE_FEED`, so inheriting it from a runner that is
 * itself executing these tests would send the replayed events to that run's
 * journal instead of the feed the test reads back. */
function backendEnv(): NodeJS.ProcessEnv {
  const { RUNNER_EVENTS_FILE: _ignored, ...env } = process.env;
  return env;
}

/** The event bus writes only to the feed installed on the runtime port. A real run
 * gets it from `entry/startup.ts`; a bare backend spawn like these must install it
 * itself, exactly as the entry point does. */
const INSTALL_FEED = [
  'import { liveFeedFromEnvironment } from "../../../output/live-feed.ts";',
  'import { setRunnerLiveFeed } from "../../../runtime/live-feed.ts";',
  "setRunnerLiveFeed(liveFeedFromEnvironment());",
];

function runBackend(
  lines: unknown[],
  outputFormat: "text" | "json" = "json",
  options: { stepLogPath?: string } = {},
): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "claude-backend-"));
  const replay = join(dir, "replay.jsonl");
  const fake = join(dir, "claude");
  writeFileSync(replay, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(fake, `#!/bin/sh\ncat '${replay}'\n`);
  chmodSync(fake, 0o755);
  const request = { prompt: "test", outputFormat, ...options };
  const source = [
    ...INSTALL_FEED,
    'import { claudeBackendFactory } from "./backend.ts";',
    `const result = await claudeBackendFactory.create().run(${JSON.stringify(request)});`,
    "console.log(JSON.stringify({ ok: result.ok, output: result.output, failReason: result.failReason, timedOut: result.timedOut }));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: { ...backendEnv(), CLAUDE_BIN: fake, RUNNER_LIVE_FEED: join(dir, "live.jsonl") },
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Outcome;
}

test("ClaudeBackend parses StructuredOutput verdicts through its public run API", () => {
  const result = runBackend([
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Analyse faite." }] } },
    {
      type: "assistant",
      message: { id: "m2", content: [{ type: "tool_use", name: "StructuredOutput", input: { success: true } }] },
    },
    {
      type: "result",
      duration_ms: 1,
      total_cost_usd: 0,
      structured_output: { success: true },
      result: '{"success":true}',
    },
  ]);
  expect(result.ok).toBe(true);
  expect(result.output).toBe("Analyse faite.");
});

test("ClaudeBackend reports invalid and failed structured verdicts", () => {
  const failed = runBackend([{ type: "result", duration_ms: 1, structured_output: { success: false, reason: "KO" } }]);
  expect(failed.ok).toBe(false);
  expect(failed.failReason).toBe("KO");
  const invalid = runBackend([{ type: "result", duration_ms: 1, structured_output: { success: "false" } }]);
  expect(invalid.ok).toBe(false);
  expect(invalid.failReason).toContain("invalid verdict: StructuredOutput");
});

test("ClaudeBackend streams agent text into the step log once per message", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-steplog-"));
  const stepLogPath = join(dir, "output.log");
  const result = runBackend(
    [
      { type: "system", model: "claude-opus-5" },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Reading the plan." }] } },
      // The CLI repeats a message as it streams: it must land in the log once.
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Reading the plan." }] } },
      { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
      { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done." }] } },
      { type: "result", duration_ms: 1, total_cost_usd: 0, result: "Done." },
    ],
    "text",
    { stepLogPath },
  );
  expect(result.ok).toBe(true);
  expect(readFileSync(stepLogPath, "utf8")).toBe("Reading the plan.\nDone.\n");
});

test("ClaudeBackend enforces a text verdict when output is JSON", () => {
  const result = runBackend([
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "done" }] } },
    { type: "result", duration_ms: 1, result: "done" },
  ]);
  expect(result.ok).toBe(false);
  expect(result.failReason).toContain("no verdict in agent output");
});

/** Replay a stream and return the runner events it published while reading it. */
function feedEvents(lines: unknown[]): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "claude-feed-"));
  const replay = join(dir, "replay.jsonl");
  const fake = join(dir, "claude");
  const feed = join(dir, "live.jsonl");
  writeFileSync(replay, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(fake, `#!/bin/sh\ncat '${replay}'\n`);
  chmodSync(fake, 0o755);
  const source = [
    ...INSTALL_FEED,
    'import { claudeBackendFactory } from "./backend.ts";',
    'await claudeBackendFactory.create().run({ prompt: "test", outputFormat: "text" });',
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: { ...backendEnv(), CLAUDE_BIN: fake, RUNNER_LIVE_FEED: feed },
  });
  expect(child.status).toBe(0);
  // The feed is created lazily on first append: a stream that publishes nothing
  // leaves no file, which is an empty event list rather than a failure.
  if (!existsSync(feed)) return [];
  return readFileSync(feed, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the stream publishes context occupancy and tool calls while the step runs", () => {
  const events = feedEvents([
    {
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-opus-5",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/Order.php" } }],
        usage: { input_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1_000 },
      },
    },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  const activity = events.find((event) => event.event === "activity");
  expect(activity?.label).toBe("Read Order.php");

  const context = events.find((event) => event.event === "context");
  expect(context?.tokens).toBe(42_000);
  expect(context?.window).toBe(200_000);
  expect(context?.pct).toBeCloseTo(0.21, 5);
});

test("a 1M model is measured against its own window", () => {
  const events = feedEvents([
    {
      type: "assistant",
      message: { id: "m1", model: "claude-opus-5[1m]", content: [], usage: { input_tokens: 250_000 } },
    },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  expect(events.find((event) => event.event === "context")?.window).toBe(1_000_000);
});

test("the live window comes from system/init, which alone carries the 1M suffix", () => {
  // Verified against the real CLI: with `--model 'sonnet[1m]'` the init event
  // reports `claude-sonnet-5[1m]` while every assistant message reports
  // `claude-sonnet-5`. Tracking the model off the assistant alone measured a 1M
  // session against a 200k window — an occupancy 5x too high, warning at 160k.
  const events = feedEvents([
    { type: "system", subtype: "init", model: "claude-sonnet-5[1m]" },
    {
      type: "assistant",
      message: { id: "m1", model: "claude-sonnet-5", content: [], usage: { input_tokens: 400_000 } },
    },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  const context = events.find((event) => event.event === "context");
  expect(context?.window).toBe(1_000_000);
  expect(context?.pct).toBeCloseTo(0.4, 5);
});

test("a synthetic message does not shrink the window mid-stream", () => {
  // `<synthetic>` labels a message the CLI fabricated. Left untracked it became
  // the model for the rest of the stream: no `[1m]` suffix (window back to 200k)
  // and no pricing key (billed at the opus default).
  const events = feedEvents([
    { type: "system", subtype: "init", model: "claude-sonnet-5[1m]" },
    {
      type: "assistant",
      message: { id: "m1", model: "<synthetic>", content: [], usage: { input_tokens: 0 } },
    },
    {
      type: "assistant",
      message: { id: "m2", model: "claude-sonnet-5", content: [], usage: { input_tokens: 300_000 } },
    },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  const context = events.filter((event) => event.event === "context").at(-1);
  expect(context?.window).toBe(1_000_000);
});

test("a message repeated by the CLI is announced once", () => {
  const message = {
    id: "m1",
    content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/Order.php" } }],
    usage: { input_tokens: 10 },
  };
  const events = feedEvents([
    { type: "assistant", message },
    { type: "assistant", message },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  expect(events.filter((event) => event.event === "activity")).toHaveLength(1);
  expect(events.filter((event) => event.event === "context")).toHaveLength(1);
});

test("StructuredOutput is a verdict, not an activity worth showing", () => {
  const events = feedEvents([
    {
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", name: "StructuredOutput", input: { success: true } }] },
    },
    { type: "result", duration_ms: 1, result: "done" },
  ]);

  expect(events.filter((event) => event.event === "activity")).toEqual([]);
});

test("ClaudeBackend cleans descendants after a successful CLI exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cleanup-"));
  const fake = join(dir, "claude");
  const stream = [
    {
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", name: "StructuredOutput", input: { success: true } }] },
    },
    { type: "result", duration_ms: 1, total_cost_usd: 0, structured_output: { success: true } },
  ];
  writeFileSync(
    fake,
    `#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\nprintf '%s\\n' '${stream.map((line) => JSON.stringify(line)).join("' '")}'\nexit 0\n`,
  );
  chmodSync(fake, 0o755);
  const source = [
    ...INSTALL_FEED,
    'import { claudeBackendFactory } from "./backend.ts";',
    'const result = await claudeBackendFactory.create().run({ prompt: "test", outputFormat: "json" });',
    "console.log(JSON.stringify({ ok: result.ok, timedOut: result.timedOut }));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: { ...backendEnv(), CLAUDE_BIN: fake, RUNNER_LIVE_FEED: join(dir, "live.jsonl") },
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ ok: true });
  expect(child.stderr).toContain("Group cleaned after CLI exit");
});

test("ClaudeBackend retries 529, but never retries 429", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-transport-"));
  const count = join(dir, "count");
  const fake = join(dir, "claude");
  const overload = {
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 529,
    result: "Overloaded",
  };
  const success = { type: "result", duration_ms: 1, total_cost_usd: 0, structured_output: { success: true } };
  const okStream = {
    type: "assistant",
    message: { id: "m1", content: [{ type: "tool_use", name: "StructuredOutput", input: { success: true } }] },
  };
  writeFileSync(
    fake,
    `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || echo 0); echo $((n+1)) > '${count}'; if [ "$n" = 0 ]; then printf '%s\\n' '${JSON.stringify(overload)}'; else printf '%s\\n' '${JSON.stringify(okStream)}' '${JSON.stringify(success)}'; fi\n`,
  );
  chmodSync(fake, 0o755);
  const source =
    'import { claudeBackendFactory } from "./backend.ts"; const r = await claudeBackendFactory.create().run({ prompt: "x", outputFormat: "json" }); console.log(JSON.stringify({ ok: r.ok }));';
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: {
      ...backendEnv(),
      CLAUDE_BIN: fake,
      RUNNER_LIVE_FEED: join(dir, "live.jsonl"),
      RUNNER_TRANSPORT_BACKOFF_MS: "0",
    },
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).ok).toBe(true);
  expect(readFileSync(count, "utf8").trim()).toBe("2");

  writeFileSync(count, "0");
  writeFileSync(
    fake,
    `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || echo 0); echo $((n+1)) > '${count}'; printf '%s\\n' '${JSON.stringify({ ...overload, api_error_status: 429, result: "quota" })}'\n`,
  );
  const quota = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: {
      ...backendEnv(),
      CLAUDE_BIN: fake,
      RUNNER_LIVE_FEED: join(dir, "live-429.jsonl"),
      RUNNER_TRANSPORT_BACKOFF_MS: "0",
    },
  });
  expect(quota.status).toBe(0);
  expect(JSON.parse(quota.stdout).ok).toBe(false);
  expect(readFileSync(count, "utf8").trim()).toBe("1");
});

test("ClaudeBackend forwards cwd and agent options to Claude argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-argv-"));
  const argv = join(dir, "argv");
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nprintf '%s\\n' '${JSON.stringify({ type: "result", duration_ms: 1 })}'\n`,
  );
  chmodSync(fake, 0o755);
  const source = `import { claudeBackendFactory } from "./backend.ts"; await claudeBackendFactory.create().run({ prompt: "/pipeline-spec X", cwd: ${JSON.stringify(dir)}, outputFormat: "json", options: { agent: "qa" } });`;
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: { ...backendEnv(), CLAUDE_BIN: fake, RUNNER_LIVE_FEED: join(dir, "live.jsonl") },
  });
  expect(child.status).toBe(0);
  const args = readFileSync(argv, "utf8").split("\n");
  expect(args).toContain(dir);
  expect(args).toContain("--agent");
  expect(args).toContain("qa");
  expect(args).toContain("--json-schema");
  expect(existsSync(join(dir, "stream.jsonl"))).toBe(false);
});
