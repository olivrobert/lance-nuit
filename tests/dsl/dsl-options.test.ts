import { expect, test } from "bun:test";
import {
  type ActionStepOptions,
  actionStep,
  artifact,
  type BashStepOptions,
  bashStep,
  type LlmStepOptions,
  llmStep,
  runPipeline,
  textArtifact,
} from "../../src/dsl.ts";
import { assertStrictSchema } from "../../src/dsl/dsl-steps.ts";
import { CODEX_SANDBOX } from "../../src/engine/backends/codex/types.ts";
import { PipelineStructureValidator } from "../../src/validation/structure.ts";
import { createDefaultAgentBackendRegistry } from "../../src/engine/default-registry.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

const command = () => "true";
const requirement = () => "test -d .";
const admission = () => "test -f ticket.md";
const fixPrompt = () => "corrige";
const result = artifact("result.json", (value) => value);
const source = artifact("source.json", (value) => value);
const commitMessage = textArtifact("commit-message.md");
const branch = artifact("branch.json", (value) => value as { name: string });
const branchSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
} as const;

// These assertions are compiled by `tsc --noEmit` but never executed.
// biome-ignore lint/correctness/noUnusedVariables: exists only for the typechecker
function optionTypeAssertions(): void {
  // @ts-expect-error command or prompt is required
  llmStep({ id: "llm", name: "LLM", profile: "coder", backend: "claude" });
  // @ts-expect-error command is required
  bashStep({ id: "bash", name: "Bash" });
  // @ts-expect-error run is required
  actionStep({ id: "action", name: "Action", describe: "action locale" });
  // @ts-expect-error describe is required
  actionStep({ id: "action", name: "Action", run: async () => undefined });
  // @ts-expect-error profile is required
  llmStep({ id: "llm", name: "LLM", backend: "claude", command: "true" });
  // @ts-expect-error backend is required
  llmStep({ id: "llm", name: "LLM", profile: "coder", command: "true" });
  // @ts-expect-error prompt and command are mutually exclusive
  llmStep({ id: "llm", name: "LLM", profile: "coder", backend: "claude", prompt: "p.md", command: "true" });
  // @ts-expect-error resumeSession belongs to a fix policy, not a plain rerun
  bashStep({ id: "bash", name: "Bash", command: "true", onFail: { retries: 1, resumeSession: "llm" } });
  // @ts-expect-error coderSource is gone: every agent step records its session
  llmStep({ id: "llm", name: "LLM", profile: "coder", backend: "claude", command: "true", coderSource: true });
  bashStep({
    id: "bash",
    name: "Bash",
    command: "true",
    // @ts-expect-error closed escalation effort
    onFail: { fix: "fix", escalate: { effort: "ultra" } },
  });
  // @ts-expect-error planner has no built-in Codex policy
  llmStep({ id: "llm", name: "LLM", profile: "planner", backend: "codex", command: "true" });
  // @ts-expect-error orchestration nodes have no declared inputs
  runPipeline({ id: "child", name: "Child", pipeline: "other", input: [source] });
  // @ts-expect-error capture belongs to llmStep: only an agent has a structured output
  bashStep({ id: "bash", name: "Bash", command: "true", capture: { commit: commitMessage } });
  // @ts-expect-error same for actionStep
  actionStep({ id: "a", name: "A", run: () => undefined, describe: "x", capture: { commit: commitMessage } });
  llmStep(
    {
      id: "llm",
      name: "LLM",
      profile: "extractor",
      backend: "codex",
      command: "true",
      capture: { commit: commitMessage, branch: { artifact: branch, schema: branchSchema } },
    },
    REGISTRY,
  );

  const llmOptions: LlmStepOptions<"coder", "claude"> = {
    id: "typed-llm",
    name: "Typed LLM",
    profile: "coder",
    backend: "claude",
    command: "true",
  };
  const bashOptions: BashStepOptions = { id: "typed-bash", name: "Typed Bash", command: "true" };
  const actionOptions: ActionStepOptions = {
    id: "typed-action",
    name: "Typed Action",
    run: () => undefined,
    describe: "local",
  };
  void llmOptions;
  void bashOptions;
  void actionOptions;
}

test("llmStep: options build the canonical definition", () => {
  const options = llmStep(
    {
      id: "implement",
      name: "Implement",
      profile: "coder",
      backend: "codex",
      options: { sandbox: CODEX_SANDBOX.WORKSPACE_WRITE, ephemeral: true },
      command,
      when: { command: admission, else: "fail" },
      require: requirement,
      output: [result],
      report: ["report.json"],
      errorExtractor: "sample-extractor",
      timeout: 120,
      blocking: false,
      rerunOnResume: true,
      onFail: {
        fix: fixPrompt,
        retries: 2,
        backendOptions: { trace: true },
        escalate: { after: 1, model: "gpt-next", effort: "high" },
      },
    },
    REGISTRY,
  ).build();

  // Translating the policy itself is the only path to `on_failure`.
  expect(options.on_failure).toEqual({
    fix_prompt: fixPrompt,
    max_retries: 2,
    backend_options: { trace: true },
    escalate_model: "gpt-next",
    escalate_effort: "high",
    escalate_after: 1,
  });
});

test("bashStep: options build the canonical definition", () => {
  const options = bashStep({
    id: "checks",
    name: "Checks",
    command,
    when: { command: admission, else: "fail" },
    require: requirement,
    output: [result],
    report: "report.xml",
    errorExtractor: "sample-extractor",
    timeout: 30,
    blocking: false,
    rerunOnResume: true,
    onFail: { retries: 2 },
  }).build();

  expect(options.id).toBe("checks");
  expect(options.report_paths).toEqual(["report.xml"]);
  expect(options.error_extractor).toBe("sample-extractor");
  expect(options.timeout).toBe(30);
  expect(options.blocking).toBe(false);
  expect(options.rerun_on_resume).toBe(true);
  expect(options.on_failure).toEqual({ max_retries: 2 });
});

test("onFail: fixOnlyWhenExtracted reaches the canonical definition", () => {
  const step = bashStep({
    id: "tests",
    name: "Tests",
    command,
    report: "var/junit.xml",
    errorExtractor: "phpunit",
    onFail: { fix: fixPrompt, retries: 2, fixOnlyWhenExtracted: true },
  }).build();

  expect(step.on_failure).toEqual({ fix_prompt: fixPrompt, max_retries: 2, fix_only_when_extracted: true });
});

// The option is read from the extraction result; without an extractor there is
// none, so the policy would be inert rather than protective.
test("onFail: fixOnlyWhenExtracted without errorExtractor is refused", () => {
  expect(() =>
    bashStep({
      id: "tests",
      name: "Tests",
      command,
      onFail: { fix: fixPrompt, retries: 2, fixOnlyWhenExtracted: true },
    }).build(),
  ).toThrow(/fixOnlyWhenExtracted requires errorExtractor/);
});

test("actionStep: options build the canonical definition", () => {
  const run = async () => "ok";
  const describe = () => "normalise result.json";
  const options = actionStep({
    id: "normalize",
    name: "Normalize",
    run,
    describe,
    output: [result],
    onFail: {
      fix: fixPrompt,
      retries: 1,
      escalate: { effort: "medium" },
    },
  }).build();

  expect(options.id).toBe("normalize");
});

test("actionStep: missing description mentions describe", () => {
  expect(() => actionStep({ id: "action", name: "Action", run: () => undefined } as never).build()).toThrow(/describe/);
});

test("input: declared sources reach the canonical definition", () => {
  const step = bashStep({
    id: "derive",
    name: "Derive",
    command,
    input: [source],
    output: [result],
  }).build();

  expect(step.sources?.map((entry) => entry.name)).toEqual(["source.json"]);
  expect(step.outputs?.map((entry) => entry.name)).toEqual(["result.json"]);
});

test("input: a step without output has nothing to compare its inputs against", () => {
  expect(() => bashStep({ id: "derive", name: "Derive", command, input: [source] }).build()).toThrow(
    /input requires output/,
  );
});

test("input: an untyped orchestration node is rejected at validation", () => {
  const findings = new PipelineStructureValidator().validate({
    source: "test.ts",
    pipeline: {
      name: "compose",
      steps: [
        {
          id: "child",
          name: "Child",
          command: "",
          runner: "pipeline",
          orchestration: { kind: "runPipeline", pipeline: "other" },
          sources: [source],
          outputs: [result],
        },
      ],
    },
    profileOverrides: {},
    stepOverrides: {},
  });

  expect(findings.map((finding) => finding.message)).toContain(
    'step "child": input is not supported by runner "pipeline"',
  );
});

/* ------------------------------------------------------------------------- *
 * `capture`: declared on an llmStep, checked at build time.
 * ------------------------------------------------------------------------- */

type CaptureOptions = LlmStepOptions<"extractor", "codex">;

function captureStep(capture: CaptureOptions["capture"], extra: Pick<CaptureOptions, "output"> = {}) {
  return llmStep(
    {
      id: "commit-message",
      name: "Commit message",
      profile: "extractor",
      backend: "codex",
      command,
      capture,
      ...extra,
    },
    REGISTRY,
  ).build();
}

test("capture: the short form binds a text artifact to a string field and joins outputs", () => {
  const step = captureStep({ commit: commitMessage });
  expect(step.captures).toEqual([{ field: "commit", artifact: commitMessage, schema: { type: "string" }, text: true }]);
  expect(step.outputs?.map((output) => output.name)).toEqual(["commit-message.md"]);
});

test("capture: the long form carries the author's schema, JSON artifacts included", () => {
  const step = captureStep({ branch: { artifact: branch, schema: branchSchema } });
  expect(step.captures).toEqual([{ field: "branch", artifact: branch, schema: branchSchema, text: false }]);
  expect(step.outputs?.map((output) => output.name)).toEqual(["branch.json"]);
});

test("capture: an artifact already in output is not listed twice, and both modes coexist", () => {
  const step = captureStep({ commit: commitMessage }, { output: [result, commitMessage] });
  expect(step.outputs?.map((output) => output.name)).toEqual(["result.json", "commit-message.md"]);
  expect(step.captures?.map((capture) => capture.field)).toEqual(["commit"]);
});

test("capture: the verdict's own fields are refused", () => {
  for (const field of ["success", "reason", "blocked"]) {
    expect(() => captureStep({ [field]: commitMessage })).toThrow(/reserved by the verdict contract/);
  }
});

test("capture: the short form is reserved to text artifacts", () => {
  expect(() => captureStep({ branch: branch as never })).toThrow(/short form is reserved to textArtifact/);
});

test("capture: a long-form schema must be strict-mode compatible", () => {
  const optional = { type: "object", properties: { name: { type: "string" } }, additionalProperties: false };
  expect(() => captureStep({ branch: { artifact: branch, schema: optional } })).toThrow(
    /schema\.required must list every property/,
  );
  const open = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  expect(() => captureStep({ branch: { artifact: branch, schema: open } })).toThrow(/additionalProperties: false/);
  // Nested objects and array items are held to the same rule.
  expect(() =>
    assertStrictSchema(
      {
        type: "object",
        properties: { items: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } } },
        required: ["items"],
        additionalProperties: false,
      },
      "where",
    ),
  ).toThrow(/where\.items\[\]: schema\.required/);
  expect(() => assertStrictSchema({ type: "string" }, "where")).not.toThrow();
  expect(() => captureStep({ branch: { artifact: branch, schema: undefined as never } })).toThrow(/schema is required/);
});

test("capture: combinators and references are refused, not silently let through", () => {
  // The guard only sees `properties` and `items`; an object node hidden under a
  // combinator would reach the provider unchecked and fail there with a 400.
  const combined = { anyOf: [{ type: "object", properties: { n: { type: "string" } } }] };
  expect(() => captureStep({ branch: { artifact: branch, schema: combined } })).toThrow(
    /schema: anyOf is not supported by capture schemas/,
  );
  for (const keyword of ["oneOf", "allOf", "not", "$ref", "$defs", "definitions", "patternProperties"]) {
    expect(() => assertStrictSchema({ type: "object", [keyword]: {} } as never, "where")).toThrow(
      `where: ${keyword} is not supported`,
    );
  }
  // Nested under a property, the same refusal names the path.
  expect(() =>
    assertStrictSchema(
      {
        type: "object",
        properties: { kind: { oneOf: [{ type: "string" }, { type: "number" }] } },
        required: ["kind"],
        additionalProperties: false,
      },
      "where",
    ),
  ).toThrow(/where\.kind: oneOf is not supported/);
  // A `null` union stays the way to express optionality.
  expect(() => assertStrictSchema({ type: ["string", "null"], enum: ["a", null] }, "where")).not.toThrow();
});

test("capture: a long form needs an artifact descriptor", () => {
  expect(() => captureStep({ branch: { artifact: {} as never, schema: branchSchema } })).toThrow(
    /expected a textArtifact or \{ artifact, schema \}/,
  );
});

test("capture: the runner-side rule refuses captures on a non-agent step", () => {
  const findings = new PipelineStructureValidator().validate({
    source: "test.ts",
    pipeline: {
      name: "raw",
      steps: [
        {
          id: "bash",
          name: "Bash",
          command: "true",
          runner: "bash",
          captures: [{ field: "commit", artifact: commitMessage, schema: { type: "string" }, text: true }],
          outputs: [commitMessage],
        },
      ],
    },
    profileOverrides: {},
    stepOverrides: {},
  });
  expect(findings.map((finding) => finding.message)).toContain('step "bash": capture applies only to runner "agent"');
});
