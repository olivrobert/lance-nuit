import { expect, test } from "bun:test";
import { type BackendOptionsFor, CODEX_MODEL, CODEX_SANDBOX, llmStep, pipeline, withBackend } from "../dsl.js";
import { validatePipeline } from "../pipeline/loader.js";
import { AgentBackendRegistry } from "./registry.js";
import { createDefaultAgentBackendRegistry } from "./default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Validation reads the registry from the context it is given. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

test("llmStep selects Codex without exposing a provider type to the pipeline", () => {
  const step = llmStep(
    {
      id: "implement",
      name: "Implement",
      backend: "codex",
      profile: "coder",
      options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE },
      command: "implement the task",
      onFail: {
        fix: "corrige",
        retries: 1,
        backendOptions: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE },
      },
    },
    REGISTRY,
  ).build();

  expect(step).toMatchObject({
    runner: "agent",
    backend: { id: "codex", options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE } },
    output_format: "json",
    profile: "coder",
    on_failure: { backend_options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE } },
  });
  expect(() =>
    validatePipeline(
      pipeline("codex")
        .add(
          llmStep({ id: "implement", name: "Implement", backend: "codex", profile: "coder", command: "x" }, REGISTRY),
        )
        .build(),
      "test",
      { context: CONTEXT },
    ),
  ).not.toThrow();
});

test("JSON verdict is implicit and validation always requires a backend", () => {
  expect(() => llmStep({ id: "x", name: "X", profile: "coder", command: "x" } as never, REGISTRY)).toThrow(/backend/);

  const implicitVerdict = pipeline("valid")
    .add(llmStep({ id: "x", name: "X", backend: "codex", profile: "coder", command: "x" }, REGISTRY))
    .build();
  expect(implicitVerdict.steps[0]?.output_format).toBe("json");
  expect(() => validatePipeline(implicitVerdict, "test", { context: CONTEXT })).not.toThrow();
});

test("validation rejects an unregistered backend before execution", () => {
  const unknownBackend = pipeline("invalid")
    .add(llmStep({ id: "x", name: "X", backend: "codeex" as never, profile: "coder", command: "x" }, REGISTRY))
    .build();

  expect(() => validatePipeline(unknownBackend, "test", { context: CONTEXT })).toThrow(
    /unknown agent backend "codeex"/,
  );
});

test("validation rejects a profile without a backend policy, even with an explicit model", () => {
  const unsupportedProfile = pipeline("invalid")
    .add(
      llmStep(
        {
          id: "review",
          name: "Review",
          backend: "codex" as never,
          profile: "planner",
          options: { model: CODEX_MODEL.GPT_5_CODEX } as never,
          command: "review",
        },
        REGISTRY,
      ),
    )
    .build();

  expect(() => validatePipeline(unsupportedProfile, "test", { context: CONTEXT })).toThrow(
    /profile "planner" is not defined for backend "codex"/,
  );
});

test("a provider-specific configuration policy makes the profile coherent", () => {
  const configuredProfile = pipeline("codex")
    .add(
      llmStep(
        { id: "review", name: "Review", backend: "codex" as never, profile: "planner", command: "review" },
        REGISTRY,
      ),
    )
    .build();

  expect(() =>
    validatePipeline(configuredProfile, "test", {
      profileOverrides: {
        planner: { backends: { codex: { model: "gpt-5-codex", effort: "medium" } } },
      },
      context: CONTEXT,
    }),
  ).not.toThrow();
});

test("backend shortcuts select the engine directly", () => {
  const step = llmStep(
    {
      id: "review",
      name: "Review",
      backend: "claude",
      profile: "coder",
      command: "review",
    },
    REGISTRY,
  ).build();
  expect(step.backend).toEqual({ id: "claude" });
  const codex = llmStep(
    { id: "codex", name: "Codex", backend: "codex", profile: "coder", command: "run" },
    REGISTRY,
  ).build();
  expect(codex.backend).toEqual({ id: "codex" });
  expect(withBackend("future-provider", { mode: "fast" }, REGISTRY)).toEqual({
    id: "future-provider",
    options: { mode: "fast" },
  });
});

/** Author options for the fictional provider, declared as a project would. */
interface AcmeStepOptions {
  workspace?: string;
}

declare module "../dsl.js" {
  interface BackendAuthorOptions {
    acme: AcmeStepOptions;
  }
}

test("a third-party provider receives typing and normalization without changing the DSL", () => {
  const registry = new AgentBackendRegistry().register({
    id: "acme",
    capabilities: { structuredOutput: false, streaming: false, resume: false, usageTokens: false, cost: "none" },
    normalizeAuthorOptions: (options) => {
      const raw = (options ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(raw).filter((key) => key !== "workspace");
      if (unknown.length > 0) throw new Error(`Acme options: unknown key(s) ${unknown.join(", ")}`);
      return { work_dir: raw.workspace };
    },
    create: () => {
      throw new Error("not spawned in this test");
    },
  });

  // The author shape is translated to an internal payload, and an unknown key
  // fails at declaration — exactly the contract fulfilled by the Claude backend.
  expect(registry.normalizeAuthorOptions("acme", { workspace: "/srv" })).toEqual({ work_dir: "/srv" });
  expect(() => registry.normalizeAuthorOptions("acme", { workspce: "/srv" })).toThrow(/unknown key\(s\)/);

  // `BackendOptionsFor` resolves through augmentation: no branch to add.
  const typed: BackendOptionsFor<"acme"> = { workspace: "/srv" };
  expect(typed.workspace).toBe("/srv");
});

test("a provider without a normalizer passes options through unchanged", () => {
  const registry = new AgentBackendRegistry().register({
    id: "brut",
    capabilities: { structuredOutput: false, streaming: false, resume: false, usageTokens: false, cost: "none" },
    create: () => {
      throw new Error("not spawned in this test");
    },
  });
  expect(registry.normalizeAuthorOptions("brut", { peuImporte: 1 })).toEqual({ peuImporte: 1 });
});
