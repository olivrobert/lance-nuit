import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AgentRequest } from "../../../contracts/index.js";
import { capabilities, createOpencodeBackend, createOpencodeBackendFactory } from "./backend.js";
import type { OpencodeBackendHost, OpencodeExecutionOptions, RawOpencodeExecutionResult } from "./types.js";
import { OPENCODE_AGENT, OPENCODE_MODEL } from "./types.js";

const VERDICT = JSON.stringify({
  type: "text",
  sessionID: "ses_42",
  part: { id: "prt_1", text: '```json:verdict\n{"success": true, "reason": "ok"}\n```' },
});

/** Records what the backend asked for, without spawning anything. */
function recordingHost(output = VERDICT): { host: OpencodeBackendHost; seen: () => OpencodeExecutionOptions } {
  let captured: OpencodeExecutionOptions | undefined;
  const host: OpencodeBackendHost = {
    execute(options): Promise<RawOpencodeExecutionResult> {
      captured = options;
      return Promise.resolve({ output, logs: "", code: 0, killed: false, durationMs: 12 });
    },
  };
  return {
    host,
    seen: () => {
      if (!captured) throw new Error("host never called");
      return captured;
    },
  };
}

test("OpencodeBackend: a run carries the model, the working directory and the runner config", async () => {
  const { host, seen } = recordingHost();

  const result = await createOpencodeBackend({ model: OPENCODE_MODEL.NEMOTRON_3_ULTRA }, host).run({
    prompt: "summarize data.txt",
    cwd: "/repo",
    outputFormat: "json",
  });

  const call = seen();
  expect(call.args).toContain(OPENCODE_MODEL.NEMOTRON_3_ULTRA);
  expect(call.args.slice(call.args.indexOf("--dir"))[1]).toBe("/repo");
  expect(call.args.at(-1)).toContain("summarize data.txt");
  // Personal instructions must not reach a deterministic agent: ~1250 measured tokens.
  expect(call.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
  expect(existsSync(call.env.OPENCODE_CONFIG ?? "")).toBe(true);
  expect(JSON.parse(readFileSync(call.env.OPENCODE_CONFIG ?? "", "utf8")).agent).toHaveProperty(OPENCODE_AGENT.BARE);
  expect(result.ok).toBe(true);
  expect(result.session).toEqual({ provider: "opencode", id: "ses_42", resumable: true });
});

test("OpencodeBackend: the role picks the agent, which is the only permission control opencode offers", async () => {
  const agentFor = async (role?: string, options: Record<string, unknown> = {}) => {
    const { host, seen } = recordingHost();
    await createOpencodeBackend(options, host).run({ prompt: "p", ...(role ? { role } : {}) });
    const args = seen().args;
    return args[args.indexOf("--agent") + 1];
  };

  expect(await agentFor("extractor")).toBe(OPENCODE_AGENT.BARE);
  expect(await agentFor("triage")).toBe(OPENCODE_AGENT.BARE);
  expect(await agentFor("reviewer")).toBe(OPENCODE_AGENT.READ_ONLY);
  expect(await agentFor("coder")).toBe(OPENCODE_AGENT.RUNNER);
  expect(await agentFor(undefined)).toBe(OPENCODE_AGENT.RUNNER);
  // An explicit option wins over the role default.
  expect(await agentFor("extractor", { agent: OPENCODE_AGENT.RUNNER })).toBe(OPENCODE_AGENT.RUNNER);
});

test("OpencodeBackend: only an opencode session is resumed", async () => {
  const { host, seen } = recordingHost();
  await createOpencodeBackend({}, host).run({
    prompt: "continue",
    resumeSession: { provider: "opencode", id: "ses_prev", resumable: true },
  });
  expect(seen().args.slice(seen().args.indexOf("--session"))[1]).toBe("ses_prev");

  const other = recordingHost();
  await createOpencodeBackend({}, other.host).run({
    prompt: "continue",
    resumeSession: { provider: "codex", id: "thread-1", resumable: true },
  });
  expect(other.seen().args).not.toContain("--session");
});

test("OpencodeBackend: a repair pass forks the resumed session, so the parent stays pristine", async () => {
  const forked = async (request: Partial<AgentRequest>, options: Record<string, unknown> = {}) => {
    const { host, seen } = recordingHost();
    await createOpencodeBackend(options, host).run({
      prompt: "corrige",
      resumeSession: { provider: "opencode", id: "ses_coder", resumable: true },
      ...request,
    });
    return seen().args.includes("--fork");
  };

  // `--session` alone appends to the parent, where claude's `--resume` branches.
  // The fix loop stores the returned id as the new coder session and expects the
  // pre-fix conversation to survive, so a repair must branch.
  expect(await forked({ intent: "fix" })).toBe(true);
  expect(await forked({ intent: "step" })).toBe(false);
  expect(await forked({})).toBe(false);
  // An explicit option wins over the intent default, in both directions.
  expect(await forked({ intent: "fix" }, { fork: false })).toBe(false);
  expect(await forked({ intent: "step" }, { fork: true })).toBe(true);
});

test("OpencodeBackend: a fork without a session to resume is never asked for", async () => {
  // `--fork` alone is rejected by opencode: it needs `--session` or `--continue`.
  const { host, seen } = recordingHost();
  await createOpencodeBackend({ fork: true }, host).run({ prompt: "p", intent: "fix" });
  expect(seen().args).not.toContain("--fork");
});

test("OpencodeBackend: the first-event deadline is separate from the total timeout", async () => {
  // A model never called before can take over 60s to warm up, then answer in 1.4s.
  const { host, seen } = recordingHost();
  await createOpencodeBackend({}, host).run({ prompt: "p", timeoutMs: 900_000 });
  expect(seen().firstEventTimeoutMs).toBeGreaterThanOrEqual(120_000);
  expect(seen().timeoutMs).toBe(900_000);

  const tuned = recordingHost();
  await createOpencodeBackend({ firstEventTimeoutMs: 30_000 }, tuned.host).run({ prompt: "p" });
  expect(tuned.seen().firstEventTimeoutMs).toBe(30_000);
});

test("OpencodeBackend: escalation and config axes move model and effort", () => {
  const backend = createOpencodeBackend({ model: "a", effort: "low" }, recordingHost().host);

  expect(backend.applyEscalation?.({ model: "a" }, { rung: "effort", effort: "high" })).toEqual({
    model: "a",
    effort: "high",
  });
  expect(backend.applyEscalation?.({ model: "a" }, { rung: "model", model: "b" })).toEqual({ model: "b" });
  expect(backend.applyEscalation?.({ model: "a" }, { rung: "none" })).toEqual({ model: "a" });
  expect(backend.applyConfigAxes?.({}, { model: "b", effort: "max" })).toEqual({ model: "b", effort: "max" });
  expect(backend.resumeHint?.({ provider: "opencode", id: "ses_9", resumable: true })).toBe("opencode run -s ses_9");
});

test("OpencodeBackend: capabilities claim a structured verdict, which the pipeline requires", () => {
  // `validation/output-contract.ts` rejects a backend with structuredOutput false
  // for any llmStep. opencode honours it through the prompt, not a native schema.
  expect(capabilities.structuredOutput).toBe(true);
  expect(capabilities.cost).toBe("exact");
  expect(capabilities.configurationAxes).toEqual(["model", "effort"]);
});

test("createOpencodeBackendFactory: no pricing fallback, so an unknown model is never billed", () => {
  const factory = createOpencodeBackendFactory(recordingHost().host);

  expect(factory.id).toBe("opencode");
  expect(factory.usage?.pricingFallback).toBeUndefined();
  expect(Object.keys(factory.usage?.pricing ?? {})).toEqual([]);
  expect(factory.create({ model: "opencode/x" }).id).toBe("opencode");
});
