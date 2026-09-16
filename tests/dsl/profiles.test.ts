import { expect, test } from "bun:test";
import { applyProfileOverrides } from "../../src/dsl/profiles.js";
import { createProjectBashStep } from "../../src/dsl/dsl-steps.js";
import { CODEX_MODEL, CODEX_SANDBOX, llmStep, mechanicalFix, pipeline } from "../../src/dsl.js";
import { parseProfileOverrides } from "../../src/env/config.schema.js";
import { createDefaultAgentBackendRegistry } from "../../src/engine/default-registry.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** A bash step whose fix carries Claude options is declared through the loaded
 *  DSL, which binds the step factories to the run registry. */
const bashStep = createProjectBashStep(REGISTRY);

test("Claude profile: preserves the role without materializing axes at build time", () => {
  const step = llmStep(
    {
      id: "implement",
      name: "Implement",
      backend: "claude",
      profile: "coder",
      command: "code",
    },
    REGISTRY,
  ).build();
  expect(step.profile).toBe("coder");
  expect(step.backend).toEqual({ id: "claude" });
});

test("Claude profile: nominal axes are materialized at load time", () => {
  const step = llmStep(
    {
      id: "triage",
      name: "Triage",
      backend: "claude",
      profile: "triage",
      command: "analyse",
    },
    REGISTRY,
  ).build();
  expect(step.profile).toBe("triage");
  expect(step.backend).toEqual({ id: "claude" });

  const loaded = pipeline("demo")
    .add(llmStep({ id: "triage", name: "Triage", backend: "claude", profile: "triage", command: "analyse" }, REGISTRY))
    .build();
  applyProfileOverrides(loaded, {}, () => ({}), REGISTRY);
  expect(loaded.steps[0]?.backend).toEqual({ id: "claude", options: { model: "opus", effort: "high" } });
});

test("Claude profile: canonical DSL shares deferred resolution", () => {
  const first = llmStep(
    {
      id: "first",
      name: "First",
      backend: "claude",
      profile: "coder",
      command: "code",
    },
    REGISTRY,
  ).build();
  const canonical = llmStep(
    {
      id: "canonical",
      name: "Canonical",
      backend: "claude",
      profile: "coder",
      command: "code",
    },
    REGISTRY,
  ).build();

  expect(first.profile).toBe(canonical.profile);
  expect(first.backend).toEqual({ id: "claude" });
  expect(canonical.backend).toEqual({ id: "claude" });
  expect(canonical.backend?.options).toBeUndefined();
});

test("profile config: retunes the role's Claude axes", () => {
  const built = pipeline("demo")
    .add(llmStep({ id: "a", name: "A", backend: "claude", profile: "coder", command: "a" }, REGISTRY))
    .add(llmStep({ id: "b", name: "B", backend: "claude", profile: "coder", command: "b" }, REGISTRY))
    .build();
  applyProfileOverrides(
    built,
    parseProfileOverrides({ coder: { backends: { claude: { model: "opus[1m]", effort: "low" } } } }),
    () => ({}),
    REGISTRY,
  );
  expect(built.steps[0].backend).toEqual({ id: "claude", options: { model: "opus[1m]", effort: "low" } });
  expect(built.steps[1].backend).toEqual({ id: "claude", options: { model: "opus[1m]", effort: "low" } });
});

test("agent profile: materializes Codex axes without injecting the Claude model", () => {
  const built = pipeline("codex")
    .add(llmStep({ id: "implement", name: "Implement", backend: "codex", profile: "coder", command: "code" }, REGISTRY))
    .build();

  applyProfileOverrides(built, {}, () => ({}), REGISTRY);

  expect(built.steps[0].backend).toEqual({
    id: "codex",
    options: { model: "gpt-5.6-luna", effort: "medium" },
  });
});

test("profile config: provider-specific axes retune Codex", () => {
  const built = pipeline("codex")
    .add(llmStep({ id: "implement", name: "Implement", backend: "codex", profile: "coder", command: "code" }, REGISTRY))
    .build();

  applyProfileOverrides(
    built,
    parseProfileOverrides({ coder: { backends: { codex: { model: "gpt-5-codex", effort: "high" } } } }),
    () => ({}),
    REGISTRY,
  );

  expect(built.steps[0].backend).toEqual({
    id: "codex",
    options: { model: "gpt-5-codex", effort: "high" },
  });
});

test("agent profile: backend technical options are preserved", () => {
  const built = pipeline("codex")
    .add(
      llmStep(
        {
          id: "implement",
          name: "Implement",
          backend: "codex",
          options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE },
          profile: "coder",
          command: "code",
        },
        REGISTRY,
      ),
    )
    .build();

  applyProfileOverrides(built, {}, () => ({}), REGISTRY);

  expect(built.steps[0].backend).toEqual({
    id: "codex",
    options: {
      sandbox: CODEX_SANDBOX.WORKSPACE_WRITE,
      model: "gpt-5.6-luna",
      effort: "medium",
    },
  });
});

test("profile config: an imposed axis is locally ignored like a wildcard", () => {
  const built = pipeline("demo")
    .add(llmStep({ id: "a", name: "A", backend: "claude", profile: "operator", command: "a" }, REGISTRY))
    .build();
  applyProfileOverrides(
    built,
    parseProfileOverrides({ operator: { backends: { claude: { model: "opus", effort: "high" } } } }),
    () => ({ model: "haiku" }),
    REGISTRY,
  );
  expect(built.steps[0].backend).toEqual({ id: "claude", options: { effort: "high" } });
});

test("profile config: invalid name, axis, and effort are rejected", () => {
  expect(() => parseProfileOverrides({ phantom: { backends: { claude: { model: "opus" } } } })).toThrow(
    /unknown profile/,
  );
  expect(() => parseProfileOverrides({ coder: { timeout: 10 } })).toThrow(/Unrecognized key: "timeout"/);
  expect(() => parseProfileOverrides({ coder: { backends: { claude: { effort: "turbo" } } } })).toThrow(
    /Invalid option[\s\S]*coder\.backends\.claude\.effort/,
  );
});

test("profile: a second declaration is rejected", () => {
  expect(() =>
    llmStep({ id: "x", name: "X", backend: "claude", profile: "coder", command: "x" }, REGISTRY).profile("reviewer"),
  ).toThrow(/already defined/);
});

test("fixProfile: a bash step's fix borrows the role regime through the default backend", () => {
  const built = pipeline("demo")
    .add(
      bashStep({
        id: "static-analysis",
        name: "Static analysis",
        command: "make static-analysis",
        onFail: {
          fix: "corrige",
          retries: 2,
          claude: { tools: ["Read", "Edit"] },
          fixProfile: "coder",
        },
      }),
    )
    .build();

  applyProfileOverrides(
    built,
    parseProfileOverrides({ coder: { backends: { claude: { model: "opus[1m]" } } } }),
    () => ({}),
    REGISTRY,
  );

  // A bash step has no backend: fix axes are resolved for the default provider
  // and merged into the options read by the fix loop.
  expect(built.steps[0].backend).toBeUndefined();
  expect(built.steps[0].on_failure?.backend_options).toEqual({
    tools: ["Read", "Edit"],
    model: "opus[1m]",
    effort: "medium",
  });
});

test("fixBackend: a bash step's fix borrows the role regime through the named backend", () => {
  const built = pipeline("demo")
    .add(
      bashStep({
        id: "static-analysis",
        name: "Static analysis",
        command: "make static-analysis",
        onFail: {
          fix: "fix",
          retries: 2,
          // Claude-shaped options are dropped: the fix runs on Codex.
          claude: { tools: ["Read", "Edit"] },
          fixProfile: "coder",
          fixBackend: "codex",
        },
      }),
    )
    .build();

  expect(built.steps[0].backend).toBeUndefined();
  expect(built.steps[0].on_failure?.fix_backend).toBe("codex");
  expect(built.steps[0].on_failure?.backend_options).toBeUndefined();

  applyProfileOverrides(
    built,
    parseProfileOverrides({ coder: { backends: { codex: { effort: "high" } } } }),
    () => ({}),
    REGISTRY,
  );

  expect(built.steps[0].on_failure?.backend_options).toEqual({ model: CODEX_MODEL.GPT_5_6_LUNA, effort: "high" });
});

test("fixBackend: the fix profile must have a policy for the named backend", () => {
  const built = pipeline("demo")
    .add(
      bashStep({
        id: "lint",
        name: "Lint",
        command: "make lint",
        onFail: { fix: "fix", retries: 1, fixProfile: "planner", fixBackend: "codex" },
      }),
    )
    .build();

  expect(() => applyProfileOverrides(built, {}, () => ({}), REGISTRY)).toThrow(
    /"lint": fix profile "planner" is not defined for backend "codex"/,
  );
});

test("mechanicalFix on Codex: the fix inherits the step's sandbox", () => {
  // A Codex fix pass that starts from no options runs `--sandbox read-only`
  // (engine/backends/codex/args.ts) and every patch it writes is rejected. The
  // repair runs on the step's own backend, so it inherits the step's regime.
  const built = pipeline("codex")
    .add(
      llmStep(
        {
          id: "criteria-fast",
          name: "Criteria",
          backend: "codex",
          options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE },
          profile: "coder",
          command: "check",
          onFail: mechanicalFix(() => "repair"),
        },
        REGISTRY,
      ),
    )
    .build();

  applyProfileOverrides(built, {}, () => ({}), REGISTRY);

  expect(built.steps[0].on_failure?.backend_options).toEqual({
    sandbox: CODEX_SANDBOX.WORKSPACE_WRITE,
    model: CODEX_MODEL.GPT_5_6_LUNA,
    effort: "medium",
  });
});

test("fix options: an explicit fix policy wins over the step's options", () => {
  const built = pipeline("codex")
    .add(
      llmStep(
        {
          id: "criteria-fast",
          name: "Criteria",
          backend: "codex",
          options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE },
          profile: "coder",
          command: "check",
          onFail: {
            fix: () => "repair",
            retries: 2,
            fixProfile: "coder",
            backendOptions: { sandbox: CODEX_SANDBOX.READ_ONLY },
          },
        },
        REGISTRY,
      ),
    )
    .build();

  applyProfileOverrides(built, {}, () => ({}), REGISTRY);

  expect(built.steps[0].on_failure?.backend_options).toEqual({
    sandbox: CODEX_SANDBOX.READ_ONLY,
    model: CODEX_MODEL.GPT_5_6_LUNA,
    effort: "medium",
  });
});
