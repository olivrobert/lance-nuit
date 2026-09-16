import { expect, test } from "bun:test";
import {
  AgentBackendRegistry,
  type AgentCapabilities,
  type AgentRequest,
  type AgentResult,
  type AgentSession,
} from "../contracts/backends.ts";
import { AGENT_BACKEND_REGISTRY, type PipelineContext } from "../model/context.ts";
import { makeRunStep } from "../state/run-step.ts";
import { textArtifact } from "../dsl/artifact.ts";
import { executeStep, normalizeAgentResult, outputFieldsOf, runWithAgent } from "./runners.ts";

const backendId = `runners-refactor-${process.pid}`;
const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: false,
  resume: true,
  usageTokens: false,
  cost: "none",
};
const requests: AgentRequest[] = [];
const factoryOptions: unknown[] = [];
const returnedSession: AgentSession = { provider: backendId, id: "returned-session", resumable: true };

const registry = new AgentBackendRegistry();
registry.register({
  id: backendId,
  capabilities,
  create(options) {
    factoryOptions.push(options);
    return {
      id: backendId,
      capabilities,
      async run(request) {
        requests.push(request);
        return {
          provider: backendId,
          output: "backend output",
          ok: true,
          stats: { duration_ms: 7 },
          session: returnedSession,
        };
      },
    };
  },
});

/** The registry travels with the context; nothing resolves it from a singleton. */
function contextWith(fields: Partial<PipelineContext>): PipelineContext {
  const context = { ...fields } as PipelineContext;
  Object.defineProperty(context, AGENT_BACKEND_REGISTRY, {
    configurable: true,
    enumerable: false,
    value: registry,
    writable: false,
  });
  return context;
}

test("runners: validates the integration contract", async () => {
  requests.length = 0;
  factoryOptions.length = 0;

  const step = makeRunStep({
    id: "agent-step",
    name: "Agent step",
    command: "unused",
    runner: "agent",
    backend: { id: backendId, options: { source: "step" } },
    profile: "coder",
    output_format: "json",
  });
  const stepOptions = { source: "step-override", effort: "high" };
  const stepResume: AgentSession = { provider: backendId, id: "step-resume", resumable: false };
  const stepResult = await executeStep(
    step,
    "step prompt",
    {
      timeout: 120,
      budgetRemaining: 456,
      session: { provider: "other", id: "wrong-provider", resumable: true },
      resumeSession: stepResume,
      stepLogPath: "/tmp/step.log",
      agentOptions: stepOptions,
    },
    contextWith({ cwd: "/workspace" }),
  );

  expect(factoryOptions[0]).toBe(stepOptions);
  expect(requests[0]).toMatchObject({
    prompt: "step prompt",
    cwd: "/workspace",
    role: "coder",
    outputFormat: "json",
    options: stepOptions,
    timeoutMs: 120,
    budgetRemaining: 456,
    // A session minted by another provider never reaches this backend.
    session: undefined,
    resumeSession: stepResume,
    stepLogPath: "/tmp/step.log",
  });
  expect(stepResult).toMatchObject({
    output: "backend output",
    ok: true,
    stats: { duration_ms: 7 },
    session: returnedSession,
  });

  const runOptions = { source: "run-options", model: "test-model" };
  const runSession: AgentSession = { provider: backendId, id: "run-session", resumable: false };
  const runResult = await runWithAgent("fix prompt", { id: backendId, options: { source: "run-spec" } }, runOptions, {
    cwd: "/workspace/fix",
    role: "reviewer",
    timeout: 240,
    budgetRemaining: 789,
    session: runSession,
    resumeSession: { provider: "other", id: "wrong-resume-provider", resumable: true },
    stepLogPath: "/tmp/fix.log",
    registry,
  });

  expect(factoryOptions[1]).toBe(runOptions);
  expect(requests[1]).toMatchObject({
    prompt: "fix prompt",
    cwd: "/workspace/fix",
    role: "reviewer",
    outputFormat: "text",
    options: runOptions,
    timeoutMs: 240,
    budgetRemaining: 789,
    session: runSession,
    resumeSession: undefined,
    stepLogPath: "/tmp/fix.log",
  });
  expect(runResult).toEqual({
    ok: true,
    stats: { duration_ms: 7 },
    session: returnedSession,
  });
});

test("runners: applies the documented agent timeout when no override exists", async () => {
  requests.length = 0;
  const step = makeRunStep({
    id: "agent-default-timeout",
    name: "Agent default timeout",
    command: "unused",
    runner: "agent",
    backend: { id: backendId },
    output_format: "text",
  });

  await executeStep(step, "prompt", {}, contextWith({ cwd: "/workspace" }));

  expect(requests[0]?.timeoutMs).toBe(900_000);
});

test("runners: validates the integration contract", async () => {
  requests.length = 0;
  const step = makeRunStep({
    id: "scoped-step",
    name: "Scoped step",
    command: "unused",
    runner: "agent",
    backend: { id: backendId },
    output_format: "json",
  });

  await executeStep(
    step,
    "prompt",
    {},
    contextWith({
      cwd: "/workspace",
      paths: { artifactsDir: "/workspace/wi/PROJ-1/artifacts", workItemDir: "/workspace/wi/PROJ-1" },
    } as Partial<PipelineContext>),
  );
  expect(requests[0]!.artifactScope).toEqual({
    artifactsDir: "/workspace/wi/PROJ-1/artifacts",
    workItemDir: "/workspace/wi/PROJ-1",
  });

  // Outside a work item (--lint-config, partial test context): impose nothing and
  // especially do not throw; this path runs before every spawn.
  await executeStep(step, "prompt", {}, contextWith({ cwd: "/workspace" }));
  expect(requests[1]!.artifactScope).toBeUndefined();
});

test("runners: a context without a registry fails loudly at the first agent step", async () => {
  const step = makeRunStep({
    id: "unattached",
    name: "Unattached",
    command: "unused",
    runner: "agent",
    backend: { id: backendId },
    output_format: "json",
  });

  await expect(executeStep(step, "prompt", {}, { cwd: "/workspace" } as PipelineContext)).rejects.toThrow(
    /no agent backend registry attached to the pipeline context/,
  );
  // Same for a caller that has no context at all: there is nothing to fall back on.
  await expect(executeStep(step, "prompt", {})).rejects.toThrow(
    /no agent backend registry attached to the pipeline context/,
  );
});

/* ------------------------------------------------------------------------- *
 * Blocked normalization. An extension backend sets `failReason` itself and never
 * goes through `resolveVerdictOutcome`; the `BLOCKED:` prefix is read here
 * so it still gets a clean stop, and so the step loop can read `failCause` alone.
 * ------------------------------------------------------------------------- */

const blockedBackendId = `runners-blocked-${process.pid}`;
let blockedBackendResult: AgentResult = { provider: blockedBackendId, output: "", ok: true, stats: { duration_ms: 0 } };
const blockedRegistry = new AgentBackendRegistry();
blockedRegistry.register({
  id: blockedBackendId,
  capabilities,
  create() {
    return {
      id: blockedBackendId,
      capabilities,
      async run() {
        return blockedBackendResult;
      },
    };
  },
});

function blockedContext(): PipelineContext {
  const context = { cwd: "/workspace" } as PipelineContext;
  Object.defineProperty(context, AGENT_BACKEND_REGISTRY, {
    configurable: true,
    enumerable: false,
    value: blockedRegistry,
    writable: false,
  });
  return context;
}

async function runBlockedStep(result: AgentResult) {
  blockedBackendResult = result;
  const step = makeRunStep({
    id: "extension-step",
    name: "Extension step",
    command: "unused",
    runner: "agent",
    backend: { id: blockedBackendId },
    output_format: "text",
  });
  return executeStep(step, "prompt", {}, blockedContext());
}

test("runners: a BLOCKED: reason from an extension backend becomes a blocked cause", async () => {
  const result = await runBlockedStep({
    provider: blockedBackendId,
    output: "",
    ok: false,
    failReason: "BLOCKED: the staging app is unreachable",
    stats: { duration_ms: 1 },
  });
  expect(result.failCause).toBe("blocked");
  // The message is left exactly as the backend wrote it: normalizing adds a
  // field, it does not rewrite prose.
  expect(result.failReason).toBe("BLOCKED: the staging app is unreachable");
});

test("runners: a cause the backend already set is left alone, and prose is never re-read", async () => {
  const explicit = await runBlockedStep({
    provider: blockedBackendId,
    output: "",
    ok: false,
    failReason: "no prefix here",
    failCause: "blocked",
    stats: { duration_ms: 1 },
  });
  expect(explicit.failCause).toBe("blocked");

  const plain = await runBlockedStep({
    provider: blockedBackendId,
    output: "",
    ok: false,
    failReason: "blocked by a missing branch",
    stats: { duration_ms: 1 },
  });
  expect(plain.failCause).toBeUndefined();

  // A successful attempt is never normalized, whatever its reason field says.
  const successful = await runBlockedStep({
    provider: blockedBackendId,
    output: "",
    ok: true,
    failReason: "BLOCKED: stale from an earlier attempt",
    stats: { duration_ms: 1 },
  });
  expect(successful.failCause).toBeUndefined();
});

test("runners: normalization keeps the result identical when there is nothing to add", () => {
  const result: AgentResult = {
    provider: blockedBackendId,
    output: "",
    ok: false,
    failReason: "exit code 1",
    stats: { duration_ms: 1 },
  };
  expect(normalizeAgentResult(result)).toBe(result);
});

test("executeStep: captured fields reach the backend request, and only then", async () => {
  requests.length = 0;
  const commit = textArtifact("commit.txt");
  const captured = makeRunStep({
    id: "capture-step",
    name: "Capture step",
    command: "unused",
    runner: "agent",
    backend: { id: backendId },
    output_format: "json",
    captures: [{ field: "commit", artifact: commit, schema: { type: "string" }, text: true }],
    outputs: [commit],
  });
  await executeStep(captured, "prompt", {}, contextWith({ cwd: "/workspace" }));
  expect(requests[0]?.outputFields).toEqual({ commit: { type: "string" } });

  // Without a capture the request carries no `outputFields` at all: the backends'
  // schema and instruction stay byte-for-byte what they were.
  const plain = makeRunStep({
    id: "plain-step",
    name: "Plain step",
    command: "unused",
    runner: "agent",
    backend: { id: backendId },
    output_format: "json",
  });
  await executeStep(plain, "prompt", {}, contextWith({ cwd: "/workspace" }));
  expect("outputFields" in requests[1]!).toBe(false);
  expect(outputFieldsOf({})).toBeUndefined();
  expect(outputFieldsOf({ captures: [] })).toBeUndefined();
});

test("executeStep: the backend's structuredOutput is returned to the step loop", async () => {
  const withStructured = new AgentBackendRegistry();
  const id = `${backendId}-structured`;
  withStructured.register({
    id,
    capabilities,
    create: () => ({
      id,
      capabilities,
      async run() {
        return {
          provider: id,
          output: "",
          ok: true,
          stats: { duration_ms: 1 },
          structuredOutput: { success: true, commit: "feat: x" },
        };
      },
    }),
  });
  const context = { cwd: "/workspace" } as PipelineContext;
  Object.defineProperty(context, AGENT_BACKEND_REGISTRY, { value: withStructured, enumerable: false });
  const step = makeRunStep({
    id: "s",
    name: "S",
    command: "unused",
    runner: "agent",
    backend: { id },
    output_format: "json",
  });
  const result = await executeStep(step, "prompt", {}, context);
  expect(result.structuredOutput).toEqual({ success: true, commit: "feat: x" });
});
