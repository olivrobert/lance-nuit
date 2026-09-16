import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictFromStructured } from "../../../contracts/index.js";
import { verdictSchema } from "../verdict-instruction.js";
import { clearLiveAttemptCost, liveAttemptCost } from "../../../runtime/live-cost.js";
import { buildCodexArgs } from "./args.js";
import { CodexBackend, VERDICT_SCHEMA } from "./backend.js";
import { parseCodexEvents } from "./events.js";
import { CODEX_MODEL, CODEX_SANDBOX, type CodexBackendHost } from "./types.js";

test("buildCodexArgs: JSON, sandbox, schema, and directory are explicit", () => {
  expect(
    buildCodexArgs(
      "inspect repo",
      {
        model: CODEX_MODEL.GPT_5_CODEX,
        effort: "medium",
        sandbox: CODEX_SANDBOX.WORKSPACE_WRITE,
        ignoreUserConfig: true,
      },
      {
        outputFormat: "json",
        cwd: "/repo",
        schemaPath: "/tmp/schema.json",
      },
    ),
  ).toEqual([
    "exec",
    "--json",
    "--color",
    "never",
    "--model",
    CODEX_MODEL.GPT_5_CODEX,
    "--config",
    'model_reasoning_effort="medium"',
    "--sandbox",
    "workspace-write",
    "--ignore-user-config",
    "--cd",
    "/repo",
    "--output-schema",
    "/tmp/schema.json",
    "inspect repo",
  ]);
});

test("buildCodexArgs: imposes the runner artifact scope", () => {
  const args = buildCodexArgs(
    "write the report",
    {},
    {
      artifactScope: {
        artifactsDir: "/repo/.lance-nuit/work-items/PROJ-1/artifacts",
        workItemDir: "/repo/.lance-nuit/work-items/PROJ-1",
      },
    },
  );

  expect(args.at(-1)).toContain("ARTIFACT SCOPE IMPOSED BY THE RUNNER");
  expect(args.at(-1)).toContain("/repo/.lance-nuit/work-items/PROJ-1/artifacts");
});

test("buildCodexArgs: resume sends only options accepted by exec resume", () => {
  expect(
    buildCodexArgs(
      "corrige",
      {
        model: CODEX_MODEL.GPT_5_CODEX,
        effort: "high",
        codexProfile: "workspace",
        sandbox: CODEX_SANDBOX.WORKSPACE_WRITE,
      },
      {
        resumeSessionId: "thread-1",
        cwd: "/repo",
        outputFormat: "json",
        schemaPath: "/tmp/schema.json",
      },
    ),
  ).toEqual([
    "exec",
    "resume",
    "thread-1",
    "--json",
    "--model",
    CODEX_MODEL.GPT_5_CODEX,
    "--config",
    'model_reasoning_effort="high"',
    "--output-schema",
    "/tmp/schema.json",
    "corrige",
  ]);
});

test("CodexBackend: translates configuration and escalation effort", () => {
  const backend = new CodexBackend();

  expect(backend.applyConfigAxes?.({}, { effort: "high" })).toEqual({ effort: "high" });
  expect(backend.applyEscalation?.({}, { rung: "effort", effort: "xhigh" })).toEqual({ effort: "xhigh" });
});

test("CodexBackend: forwards budget and artifact scope to the host", async () => {
  let seen: Parameters<CodexBackendHost["execute"]>[0] | undefined;
  const host: CodexBackendHost = {
    execute: async (options) => {
      seen = options;
      return { output: "", code: 0, killed: false, durationMs: 1 };
    },
  };

  await new CodexBackend({ model: CODEX_MODEL.GPT_5_CODEX }, host).run({
    prompt: "work",
    outputFormat: "text",
    budgetRemaining: 0.5,
    artifactScope: { artifactsDir: "/repo/artifacts", workItemDir: "/repo" },
  });

  expect(seen).toMatchObject({ model: CODEX_MODEL.GPT_5_CODEX, budgetRemaining: 0.5 });
  expect(seen?.args.at(-1)).toContain("/repo/artifacts");
});

test("Codex verdict schema requires every declared response property", () => {
  // Derived, not enumerated: OpenAI Structured Outputs rejects a schema whose
  // `required` omits any declared property (400 `invalid_json_schema`).
  expect([...VERDICT_SCHEMA.required].sort()).toEqual(
    Object.keys(VERDICT_SCHEMA.properties).sort() as (keyof typeof VERDICT_SCHEMA.properties)[],
  );
  expect(VERDICT_SCHEMA.properties.reason).toEqual({ type: "string" });
  // Optionality goes through the null union, which the verdict parser reads as absent.
  expect(VERDICT_SCHEMA.properties.blocked).toEqual({ type: ["boolean", "null"] });
  expect(verdictFromStructured({ success: false, reason: "BLOCKED: no branch", blocked: null }).verdict).toEqual({
    success: false,
    reason: "BLOCKED: no branch",
    blocked: true,
  });
});

test("Codex verdict schema keeps the strict-mode invariant with captured fields", () => {
  // `required` is derived from `properties`, so a captured field cannot break the
  // invariant the previous test pins — and a bare call is the historical schema.
  const schema = verdictSchema({ commit: { type: "string" } });
  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  expect(schema.properties.commit).toEqual({ type: "string" });
  expect(schema.additionalProperties).toBe(false);
  expect(verdictSchema()).toEqual(VERDICT_SCHEMA);
});

test("CodexBackend: writes the captured fields into the --output-schema file", async () => {
  let written: unknown;
  let path: string | undefined;
  const host: CodexBackendHost = {
    execute: async (options) => {
      path = options.args[options.args.indexOf("--output-schema") + 1];
      written = JSON.parse(readFileSync(path!, "utf8"));
      return { output: "", code: 0, killed: false, durationMs: 1 };
    },
  };

  await new CodexBackend({}, host).run({
    prompt: "work",
    outputFormat: "json",
    outputFields: { commit: { type: "string" } },
  });

  expect(written).toEqual(verdictSchema({ commit: { type: "string" } }));
  expect((written as { required: string[] }).required).toContain("commit");
  // The temporary schema file does not outlive the spawn.
  expect(existsSync(path!)).toBe(false);
});

test("CodexBackend: without captures the schema file is the historical verdict schema", async () => {
  let written: unknown;
  const host: CodexBackendHost = {
    execute: async (options) => {
      written = JSON.parse(readFileSync(options.args[options.args.indexOf("--output-schema") + 1]!, "utf8"));
      return { output: "", code: 0, killed: false, durationMs: 1 };
    },
  };
  await new CodexBackend({}, host).run({ prompt: "work", outputFormat: "json" });
  expect(written).toEqual(VERDICT_SCHEMA);
});

test("parseCodexEvents: normalizes session, messages, tools, and usage", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-1" }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Analysis complete" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 25,
        output_tokens: 40,
        reasoning_output_tokens: 12,
      },
    }),
  ].join("\n");

  expect(parseCodexEvents(raw, CODEX_MODEL.GPT_5_CODEX)).toEqual({
    text: "Analysis complete",
    sessionId: "codex-1",
    model: CODEX_MODEL.GPT_5_CODEX,
    inputTokens: 100,
    cachedInputTokens: 25,
    outputTokens: 40,
    reasoningTokens: 12,
    turns: 1,
    toolsUsed: ["Bash"],
  });
});

test("parseCodexEvents: keeps a JSON verdict as structured output", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-2" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: '{"success":false,"reason":"tests"}' },
    }),
  ].join("\n");
  expect(parseCodexEvents(raw).structuredOutput).toEqual({ success: false, reason: "tests" });
});

test("CodexBackend: headless process → common result, session, and usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-backend-"));
  const bin = join(dir, "fake-codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"fake-thread"}\'',
      'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"{\\"success\\":true}"}}\'',
      'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\'',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = await new CodexBackend({ bin, model: CODEX_MODEL.GPT_5_CODEX }).run({
    prompt: "test",
    cwd: dir,
    outputFormat: "json",
    timeoutMs: 5_000,
  });

  expect(result.ok).toBe(true);
  expect(result.session).toEqual({ provider: "codex", id: "fake-thread", resumable: true });
  expect(result.structuredOutput).toEqual({ success: true });
  expect(result.stats).toMatchObject({
    provider: "codex",
    input_tokens: 10,
    output_tokens: 5,
    model: CODEX_MODEL.GPT_5_CODEX,
  });
});

test("CodexBackend: stops a priced turn that exceeds the remaining budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-budget-"));
  const bin = join(dir, "fake-codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":100000}}\'',
      "sleep 30",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = await new CodexBackend({ bin, model: CODEX_MODEL.GPT_5_CODEX }).run({
    prompt: "test",
    cwd: dir,
    budgetRemaining: 0.01,
    timeoutMs: 5_000,
  });

  expect(result.ok).toBe(false);
  expect(result.timedOut).toBe(false);
  expect(result.failReason).toContain("budget exceeded");
  expect(liveAttemptCost()).toBeGreaterThan(0.01);
  clearLiveAttemptCost();
}, 10_000);

test("CodexBackend: unpriceable live usage stops the turn as unaccounted under a strict ceiling", async () => {
  // A model no rate table covers, spending tokens: `computeCostUsd` returns
  // nothing, so the ceiling can never be compared to this attempt. Under strict
  // accounting the guard stops it — and the process would otherwise sleep 30s, so
  // the assertion is also the proof the supervisor cleaned its group.
  const dir = mkdtempSync(join(tmpdir(), "codex-unaccounted-"));
  const bin = join(dir, "fake-codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":100}}\'',
      "sleep 30",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const started = Date.now();
  const result = await new CodexBackend({ bin, model: "vendor/model-nobody-prices" }).run({
    prompt: "test",
    cwd: dir,
    budgetRemaining: 5,
    strictCostAccounting: true,
    timeoutMs: 20_000,
  });

  expect(result.ok).toBe(false);
  expect(result.timedOut).toBe(false);
  // The two cost stops stay apart all the way to the result: `--budget` cannot
  // price this attempt, so the report must not send an operator there.
  expect(result.costUnaccounted).toBe(true);
  expect(result.budgetExceeded).toBeUndefined();
  expect(result.failReason).toContain("cost unaccounted");
  expect(result.failReason).toContain("--allow-unmetered");
  expect(Date.now() - started).toBeLessThan(15_000);
  clearLiveAttemptCost();
}, 25_000);

test("CodexBackend: an authorized run keeps an unpriceable turn alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-unaccounted-ok-"));
  const bin = join(dir, "fake-codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":100}}\'',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = await new CodexBackend({ bin, model: "vendor/model-nobody-prices" }).run({
    prompt: "test",
    cwd: dir,
    budgetRemaining: 5,
    timeoutMs: 10_000,
  });

  expect(result.ok).toBe(true);
  expect(result.costUnaccounted).toBeUndefined();
  clearLiveAttemptCost();
}, 15_000);

test("CodexBackend: shared timeout kills the detached process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-timeout-"));
  const bin = join(dir, "fake-codex");
  writeFileSync(
    bin,
    ["#!/bin/sh", "trap 'exit 0' TERM", "(trap '' TERM; exec </dev/null >/dev/null 2>&1; sleep 30) &", "wait"].join(
      "\n",
    ),
  );
  chmodSync(bin, 0o755);

  const started = Date.now();
  const result = await new CodexBackend({ bin }).run({ prompt: "test", cwd: dir, timeoutMs: 100 });

  expect(result.ok).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(result.failReason).toContain("timeout");
  // The finalizer waits for grace, then SIGKILLs the descendant that ignores TERM.
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  expect(Date.now() - started).toBeLessThan(7_000);
}, 10_000);

test("CodexBackend: cleans up a descendant after a CLI exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-orphan-"));
  const pidFile = join(dir, "descendant.pid");
  const bin = join(dir, "fake-codex");
  writeFileSync(bin, ["#!/bin/sh", `(sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0)`].join("\n"));
  chmodSync(bin, 0o755);

  const result = await new CodexBackend({ bin }).run({ prompt: "test", cwd: dir, timeoutMs: 5_000 });

  expect(result.ok).toBe(false);
  expect(result.failReason).toContain("descendants");
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  try {
    process.kill(descendant, 0);
    throw new Error("descendant encore vivant");
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
  }
  rmSync(pidFile, { force: true });
}, 15_000);

// A new codex release may add an event type or a key at any time; the runner must
// keep the events it does understand. See `events.schema.ts`.
test("parseCodexEvents: an unknown event type is tolerated, item-bearing events included", () => {
  const parsed = parseCodexEvents(
    [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.telemetry_v9", payload: { anything: [1, 2, 3] } }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } }),
      JSON.stringify({ type: "turn.completed", model: "gpt-5-codex", usage: { input_tokens: 100, output_tokens: 20 } }),
    ].join("\n"),
  );
  expect(parsed.sessionId).toBe("t1");
  expect(parsed.text).toBe("done");
  expect(parsed.turns).toBe(1);
  expect(parsed.inputTokens).toBe(100);
  expect(parsed.outputTokens).toBe(20);
});

test("parseCodexEvents: an extra key on a known event changes nothing", () => {
  const base = parseCodexEvents(
    [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } }),
      JSON.stringify({ type: "turn.completed", model: "gpt-5-codex", usage: { input_tokens: 100 } }),
    ].join("\n"),
  );
  const extended = parseCodexEvents(
    [
      JSON.stringify({ type: "thread.started", thread_id: "t1", cwd: "/tmp" }),
      JSON.stringify({
        type: "item.completed",
        seq: 12,
        item: { id: "i1", type: "agent_message", text: "done", finished_at: "now" },
      }),
      JSON.stringify({
        type: "turn.completed",
        model: "gpt-5-codex",
        usage: { input_tokens: 100, service_tier: "priority" },
      }),
    ].join("\n"),
  );
  expect(extended).toEqual(base);
});

test("parseCodexEvents: turn.completed without a usage block counts the turn and no token", () => {
  const parsed = parseCodexEvents(JSON.stringify({ type: "turn.completed", model: "gpt-5-codex" }));
  expect(parsed.turns).toBe(1);
  expect(parsed.model).toBe("gpt-5-codex");
  expect(parsed.inputTokens).toBeUndefined();
  expect(parsed.outputTokens).toBeUndefined();
});
