import { expect, test } from "bun:test";
import { bashStep, createProjectBashStep, type Escalate, llmStep, mechanicalFix } from "../dsl.js";
import { advanceRung, DEFAULT_ESCALATE_AFTER, escalationAxes, escalationRung } from "./escalation.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

const ladder = { escalateModel: "opus", escalateEffort: "high" as const };
const base = { model: "sonnet", tools: ["Read", "Edit"] };

test("advanceRung: reports the transition, not the rung alone", () => {
  // The rerun loop and the fix loop both log only on a real move; each used to
  // compare rungs itself, aligned by a comment rather than by shared code.
  const args = { timedOut: false, escalateAfter: DEFAULT_ESCALATE_AFTER, ladder };
  expect(advanceRung({ ...args, retries: 1, current: "none" })).toEqual({ rung: "none", changed: false });
  expect(advanceRung({ ...args, retries: 2, current: "none" })).toEqual({ rung: "effort", changed: true });
  expect(advanceRung({ ...args, retries: 3, current: "effort" })).toEqual({ rung: "model", changed: true });
  expect(advanceRung({ ...args, retries: 4, current: "model" })).toEqual({ rung: "model", changed: false });
});

test("escalationAxes: validates the contract", () => {
  expect(escalationAxes("model", ladder)).toEqual({ rung: "model", model: "opus", effort: "high" });
  expect(escalationAxes("none", {})).toEqual({ rung: "none", model: undefined, effort: undefined });
});

test("escalationRung: validates the contract", () => {
  const first = escalationRung({
    timedOut: false,
    retries: 2,
    escalateAfter: 2,
    current: "none",
    ladder,
  });
  expect(first).toBe("effort");
  const second = escalationRung({
    timedOut: false,
    retries: 3,
    escalateAfter: 2,
    current: first,
    ladder,
  });
  expect(second).toBe("model");
  // Sticky: never move backward once the model rung is reached.
  expect(
    escalationRung({
      timedOut: false,
      retries: 4,
      escalateAfter: 2,
      current: "model",
      ladder,
    }),
  ).toBe("model");
});

test("escalationRung: validates the contract", () => {
  expect(
    escalationRung({
      timedOut: true,
      retries: 0,
      escalateAfter: 2,
      current: "none",
      ladder,
    }),
  ).toBe("model");
});

test("escalationRung: validates the contract", () => {
  expect(
    escalationRung({
      timedOut: false,
      retries: 1,
      escalateAfter: 2,
      current: "none",
      ladder,
    }),
  ).toBe("none");
  expect(
    escalationRung({
      timedOut: false,
      retries: 9,
      escalateAfter: 2,
      current: "none",
      ladder: {},
    }),
  ).toBe("none");
});

test("escalationRung: validates the contract", () => {
  const rung = escalationRung({
    timedOut: false,
    retries: 2,
    escalateAfter: 2,
    current: "none",
    ladder: { escalateEffort: "high" },
  });
  expect(rung).toBe("effort");
  expect(
    escalationRung({
      timedOut: false,
      retries: 3,
      escalateAfter: 2,
      current: rung,
      ladder: { escalateEffort: "high" },
    }),
  ).toBe("effort");
});

test("DSL: validates the contract", () => {
  const rerun = llmStep(
    {
      id: "implement",
      name: "Implement",
      profile: "coder",
      backend: "claude",
      command: "c",
      onFail: { retries: 4, escalate: { effort: "high", model: "opus[1m]", after: 2 } },
    },
    REGISTRY,
  ).build();
  expect(rerun.on_failure?.escalate_effort).toBe("high");
  expect(rerun.on_failure?.escalate_model).toBe("opus[1m]");

  const fix = bashStep({
    id: "tests",
    name: "Tests",
    command: "make test",
    onFail: { fix: () => "p", retries: 2, escalate: { effort: "high", after: 1 } },
  }).build();
  expect(fix.on_failure?.escalate_effort).toBe("high");
  expect(fix.on_failure?.escalate_after).toBe(1);
  expect(fix.on_failure?.escalate_model).toBeUndefined();
});

test("DSL fix policy exposes escalate_model in on_failure: validates the contract", () => {
  // `onFail({ claude })` resolves the fix backend: the step must be declared
  // against a registry, as the loaded DSL does.
  const step = createProjectBashStep(REGISTRY)({
    id: "static-analysis",
    name: "Static analysis",
    command: "make stan",
    onFail: {
      fix: () => "p",
      retries: 2,
      claude: { tools: base.tools },
      escalate: { model: "opus" },
    },
  }).build();
  expect(step.on_failure?.escalate_model).toBe("opus");
});

test("DSL fix policy without escalate: validates the contract", () => {
  const step = bashStep({
    id: "x",
    name: "X",
    command: "c",
    onFail: { fix: () => "p", retries: 2 },
  }).build();
  expect(step.on_failure?.escalate_model).toBeUndefined();
});

test("mechanicalFix keeps the restricted repair policy together", () => {
  const prompt = () => "repair";
  expect(mechanicalFix(prompt)).toEqual({
    fix: prompt,
    retries: 2,
    escalate: { effort: "high" },
    claude: { tools: ["Read", "Edit"], strictMcp: true, settingSources: "" },
    fixProfile: "coder",
  });
});

test("DSL: validates the contract", () => {
  const withEscalate = (escalate: Escalate) => () =>
    bashStep({ id: "x", name: "X", command: "c", onFail: { retries: 1, escalate } });
  expect(withEscalate({ model: "  " })).toThrow(/model/);
  expect(withEscalate({ effort: "invalid" as never })).toThrow(/effort/);
  expect(withEscalate({ after: -1 })).toThrow(/after/);
  expect(withEscalate({ after: 1.5 })).toThrow(/after/);
});

test("Claude DSL normalizes public camelCase options: validates the contract", () => {
  const step = llmStep(
    {
      id: "triage",
      name: "Triage",
      backend: "claude",
      profile: "coder",
      command: "triage",
      options: {
        agent: "project-triage",
        systemPrompt: "Analyse sans modifier le code.",
        tools: ["Read", "Grep"],
        allowedTools: ["Read"],
        strictMcp: true,
        settingSources: "",
        permissionMode: "plan",
      },
    },
    REGISTRY,
  ).build();

  expect(step.backend).toEqual({
    id: "claude",
    options: {
      agent: "project-triage",
      system_prompt: "Analyse sans modifier le code.",
      tools: ["Read", "Grep"],
      allowed_tools: ["Read"],
      strict_mcp: true,
      setting_sources: "",
      permission_mode: "plan",
    },
  });
});

test("Claude DSL rejects invalid public options: validates the contract", () => {
  expect(() =>
    llmStep(
      {
        id: "x",
        name: "X",
        backend: "claude",
        profile: "coder",
        command: "x",
        options: { strict_mcp: true } as never,
      },
      REGISTRY,
    ),
  ).toThrow(/camelCase/);
  expect(() =>
    llmStep(
      {
        id: "x",
        name: "X",
        backend: "claude",
        profile: "coder",
        command: "x",
        options: { tools: ["Read", 42] } as never,
      },
      REGISTRY,
    ),
  ).toThrow(/string array/);
  expect(() =>
    llmStep(
      {
        id: "x",
        name: "X",
        backend: "claude",
        profile: "coder",
        command: "x",
        options: { contextGuard: false } as never,
      },
      REGISTRY,
    ),
  ).toThrow(/unknown key\(s\)/);
});

test("DSL claude without setting context: validates the contract", () => {
  const step = llmStep({ id: "x", name: "X", backend: "claude", profile: "coder", command: "c" }, REGISTRY).build();
  expect(step.backend?.options).toBeUndefined();
});
