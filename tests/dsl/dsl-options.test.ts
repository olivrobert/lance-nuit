import { expect, test } from "bun:test";
import {
  type ActionStepOptions,
  actionStep,
  artifact,
  type BashStepOptions,
  bashStep,
  type LlmStepOptions,
  llmStep,
  parallelize,
  pipeline,
  runPipeline,
  source as externalSource,
  textArtifact,
} from "../../src/definition/dsl.ts";
import { assertStrictSchema } from "../../src/definition/dsl/dsl-steps.ts";
import { CODEX_SANDBOX } from "../../src/agents/backends/codex/types.ts";
import { PipelineStructureValidator } from "../../src/definition/validation/structure.ts";
import { createDefaultAgentBackendRegistry } from "../../src/agents/default-registry.js";

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
      replayInterrupted: true,
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
  expect(options.replay_interrupted).toBe(true);
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
    replayInterrupted: true,
    onFail: { retries: 2 },
  }).build();

  expect(options.id).toBe("checks");
  expect(options.report_paths).toEqual(["report.xml"]);
  expect(options.error_extractor).toBe("sample-extractor");
  expect(options.timeout).toBe(30);
  expect(options.blocking).toBe(false);
  expect(options.rerun_on_resume).toBe(true);
  expect(options.replay_interrupted).toBe(true);
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

test("onFail: replayAfterFix reaches the canonical definition", () => {
  const step = bashStep({
    id: "review",
    name: "Review",
    command,
    blocking: false,
    onFail: { fix: fixPrompt, retries: 1, replayAfterFix: false },
  }).build();

  expect(step.on_failure).toEqual({ fix_prompt: fixPrompt, max_retries: 1, replay_after_fix: false });
});

// An unverified repair must never let a blocking gate pass.
test("onFail: replayAfterFix: false on a blocking step is refused", () => {
  expect(() =>
    bashStep({ id: "review", name: "Review", command, onFail: { fix: fixPrompt, replayAfterFix: false } }).build(),
  ).toThrow(/replayAfterFix: false requires blocking: false/);
});

// Without a replay, a second repair would have no new failure to work from.
test("onFail: replayAfterFix: false with several retries is refused", () => {
  expect(() =>
    bashStep({
      id: "review",
      name: "Review",
      command,
      blocking: false,
      onFail: { fix: fixPrompt, retries: 2, replayAfterFix: false },
    }).build(),
  ).toThrow(/replayAfterFix: false requires retries: 1/);
});

test("onFail: stopIfUnchanged reaches the canonical definition", () => {
  const step = bashStep({
    id: "acceptance",
    name: "Acceptance",
    command,
    onFail: { fix: fixPrompt, retries: 2, stopIfUnchanged: true },
  }).build();

  expect(step.on_failure).toEqual({ fix_prompt: fixPrompt, max_retries: 2, stop_if_unchanged: true });
});

// Without a repair there is no change to measure.
test("onFail: stopIfUnchanged without fix is refused", () => {
  expect(() =>
    bashStep({
      id: "acceptance",
      name: "Acceptance",
      command,
      onFail: { retries: 2, stopIfUnchanged: true } as never,
    }).build(),
  ).toThrow(/stopIfUnchanged requires fix/);
});

// Without a replay there is nothing to skip.
test("onFail: stopIfUnchanged with replayAfterFix: false is refused", () => {
  expect(() =>
    bashStep({
      id: "review",
      name: "Review",
      command,
      blocking: false,
      onFail: { fix: fixPrompt, retries: 1, replayAfterFix: false, stopIfUnchanged: true },
    }).build(),
  ).toThrow(/stopIfUnchanged cannot be combined with replayAfterFix: false/);
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

test("input: an external source reaches the canonical definition beside the artifacts", () => {
  const tree = externalSource("tree", { command: "git rev-parse HEAD" });
  const step = bashStep({ id: "derive", name: "Derive", command, input: [source, tree], output: [result] }).build();

  expect(step.sources).toEqual([source, tree]);
});

test("input: a source declared as output is refused, being read and never written", () => {
  const tree = externalSource("tree", { command: "git rev-parse HEAD" });
  const options = { id: "derive", name: "Derive", command, input: [tree], output: [result, tree] };

  // A JavaScript pipeline is untyped: the builder is what stops it.
  expect(() => bashStep(options as unknown as BashStepOptions).build()).toThrow(
    'Step "derive": source "tree" cannot be an output: a source is read, never written',
  );
});

test("input: two sources of the same name would share one fingerprint and are refused", () => {
  const first = externalSource("tree", { command: "git rev-parse HEAD" });
  const second = externalSource("tree", { command: "git diff HEAD" });

  expect(() =>
    bashStep({ id: "derive", name: "Derive", command, input: [first, second], output: [result] }).build(),
  ).toThrow('Step "derive": source "tree" is declared twice in input');
});

test("input: a step without output is accepted, its stamp records its inputs alone", () => {
  expect(bashStep({ id: "derive", name: "Derive", command, input: [source] }).build().sources).toEqual([source]);
});

/* ------------------------------------------------------------------------- *
 * What the freshness lock needs of a pipeline (L12).
 * ------------------------------------------------------------------------- */

test("lock: rerunOnResume with input is refused, at build and at validation", () => {
  expect(() =>
    bashStep({ id: "derive", name: "Derive", command, input: [source], rerunOnResume: true }).build(),
  ).toThrow('Step "derive": rerunOnResume cannot be combined with input');
  const findings = new PipelineStructureValidator().validate({
    source: "test.ts",
    pipeline: {
      name: "p",
      steps: [
        { id: "derive", name: "Derive", command: "true", runner: "bash", sources: [source], rerun_on_resume: true },
      ],
    },
    profileOverrides: {},
    stepOverrides: {},
  });
  expect(findings.map((finding) => finding.message)).toContain(
    'step "derive": rerunOnResume cannot be combined with input',
  );
});

const TWO_PRODUCERS = 'artifact "result.json" is an output of both "a" and "b": one producer per artifact';

test("lock: two producers of one artifact are refused, at build and at validation", () => {
  expect(() =>
    pipeline("p")
      .add(
        bashStep({ id: "a", name: "A", command, output: [result] }),
        bashStep({ id: "b", name: "B", command, output: [result] }),
      )
      .build(),
  ).toThrow(TWO_PRODUCERS);
  expect(
    structureFindings({
      steps: [
        { id: "a", name: "A", command: "true", runner: "bash", outputs: [result] },
        { id: "b", name: "B", command: "true", runner: "bash", outputs: [result] },
      ],
    }),
  ).toContain(TWO_PRODUCERS);
});

test("lock: two members of one parallel group producing one artifact are refused", () => {
  const member = (id: string) =>
    llmStep({ id, name: id.toUpperCase(), profile: "coder", backend: "claude", command, output: [result] }, REGISTRY);
  expect(() =>
    pipeline("p")
      .add(...parallelize({ id: "group", name: "Group", steps: [member("a"), member("b")] }))
      .build(),
  ).toThrow(TWO_PRODUCERS);
});

test("lock: a capture and a review capture count as outputs for the one-producer rule", () => {
  const capturing = llmStep(
    { id: "a", name: "A", profile: "coder", backend: "claude", command, capture: { commit: commitMessage } },
    REGISTRY,
  );
  expect(() =>
    pipeline("p")
      .add(capturing, bashStep({ id: "b", name: "B", command, output: [commitMessage] }))
      .build(),
  ).toThrow('artifact "commit-message.md" is an output of both "a" and "b"');

  const reviewed = llmStep(
    { id: "a", name: "A", profile: "planner", backend: "claude", command, output: [result], review: reviewSpec },
    REGISTRY,
  );
  expect(() =>
    pipeline("p")
      .add(reviewed, bashStep({ id: "b", name: "B", command, output: [auditArtifact] }))
      .build(),
  ).toThrow('artifact "audit.md" is an output of both "a" and "b"');
});

test("lock: a malformed output or input entry is a validation finding, not a crash", () => {
  const findings = structureFindings({
    steps: [
      { id: "a", name: "A", command: "true", runner: "bash", outputs: [null] },
      { id: "b", name: "B", command: "true", runner: "bash", sources: [undefined], outputs: [result] },
    ],
  });
  expect(findings).toContain('step "a": every output must be named');
  expect(findings).toContain('step "b": every input must be named');
});

test("lock: an artifact in both the input and the output of one step is refused", () => {
  expect(() =>
    pipeline("p")
      .add(bashStep({ id: "revise", name: "Revise", command, input: [result], output: [result] }))
      .build(),
  ).toThrow('step "revise": artifact "result.json" is both its input and its output');
  const findings = new PipelineStructureValidator().validate({
    source: "test.ts",
    pipeline: {
      name: "p",
      steps: [{ id: "revise", name: "Revise", command: "true", runner: "bash", sources: [result], outputs: [result] }],
    },
    profileOverrides: {},
    stepOverrides: {},
  });
  expect(findings.map((finding) => finding.message)).toContain(
    'step "revise": artifact "result.json" is both its input and its output',
  );
});

test("lock: an artifact named lock.json, or after its write lock, is refused", () => {
  expect(() => textArtifact("lock.json")).toThrow(/reserved by the runner/);
  expect(() => artifact("lock.json.lock", (value) => value)).toThrow(/reserved by the runner/);
  expect(textArtifact("sub/lock.json").name).toBe("sub/lock.json");
});

test("lock: replayAfterFix: false is refused on a step declaring an output", () => {
  expect(() =>
    bashStep({
      id: "audit",
      name: "Audit",
      command,
      output: [result],
      blocking: false,
      onFail: { fix: fixPrompt, retries: 1, replayAfterFix: false },
    }).build(),
  ).toThrow(/replayAfterFix: false requires a step without output/);
});

/* ------------------------------------------------------------------------- *
 * `review`: declared on an llmStep, checked at build time (L12).
 * ------------------------------------------------------------------------- */

const auditArtifact = textArtifact("audit.md");
const reviewSpec = {
  profile: "reviewer" as const,
  backend: "claude" as const,
  command: "review",
  capture: { field: "audit", artifact: auditArtifact, schema: { type: "string" } },
  fix: (review: string) => (review ? `fix ${review}` : undefined),
};

function reviewedStep(extra: { blocking?: boolean; review?: typeof reviewSpec } = {}) {
  return llmStep(
    {
      id: "plan",
      name: "Plan",
      profile: "planner",
      backend: "claude",
      command,
      output: [result],
      review: reviewSpec,
      ...extra,
    },
    REGISTRY,
  ).build();
}

test("review: the capture joins the outputs, defaults apply", () => {
  const step = reviewedStep();
  expect(step.outputs?.map((output) => output.name)).toEqual(["result.json", "audit.md"]);
  expect(step.review).toMatchObject({
    profile: "reviewer",
    backend: { id: "claude" },
    capture: { field: "audit", artifact: auditArtifact, text: true },
    retries: 0,
  });
  expect(step.review?.fix_profile).toBeUndefined();
});

test("review: refused with blocking: false", () => {
  expect(() => reviewedStep({ blocking: false })).toThrow(/review cannot be combined with blocking: false/);
});

test("review: a capture named after a verdict field is refused", () => {
  expect(() =>
    reviewedStep({ review: { ...reviewSpec, capture: { ...reviewSpec.capture, field: "success" } } }),
  ).toThrow(/reserved by the verdict contract/);
});

test("review: refused on a step whose backend cannot resume a session", () => {
  const registry = createDefaultAgentBackendRegistry();
  const resolve = registry.resolve.bind(registry);
  registry.resolve = (spec) => {
    const backend = resolve(spec);
    return { ...backend, capabilities: { ...backend.capabilities, resume: false } };
  };
  expect(() =>
    llmStep(
      {
        id: "plan",
        name: "Plan",
        profile: "planner",
        backend: "claude",
        command,
        output: [result],
        review: reviewSpec,
      },
      registry,
    ).build(),
  ).toThrow(/review needs a backend that resumes sessions/);
});

test("review: refused on a non-agent step at validation", () => {
  const findings = new PipelineStructureValidator().validate({
    source: "test.ts",
    pipeline: {
      name: "p",
      steps: [
        {
          id: "plan",
          name: "Plan",
          command: "true",
          runner: "bash",
          outputs: [result],
          review: { ...reviewedStep().review! },
        },
      ],
    },
    profileOverrides: {},
    stepOverrides: {},
  });
  expect(findings.map((finding) => finding.message)).toContain(
    'step "plan": review applies only to an agent step (llmStep)',
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

/* ------------------------------------------------------------------------- *
 * Every step declares what it reads or delivers (decision D2), always on.
 * ------------------------------------------------------------------------- */

const announce = () => actionStep({ id: "announce", name: "Announce", describe: "post", run: () => {} });
const notify = () => bashStep({ id: "notify", name: "Notify", command });
const produce = () => bashStep({ id: "produce", name: "Produce", command, output: [result] });
const replayable = () => bashStep({ id: "context", name: "Context", command, rerunOnResume: true });

const D2_REFUSAL =
  'steps "announce", "notify" declare neither input, output nor rerunOnResume. ' +
  "Declare the artifact a step produces, or a receipt of its side effect, as output; " +
  "or set rerunOnResume: true if replaying it on every invocation is idempotent.";

test("D2: a step with neither input, output nor rerunOnResume is refused at build, with both ways out", () => {
  const build = () => pipeline("p").add(produce(), announce(), replayable(), notify()).build();

  expect(build).toThrow(`Pipeline "p": every step must declare what it reads or delivers; ${D2_REFUSAL}`);
});

test("D2: the refusal needs no opt-in, and the DSL no longer offers a reconcile switch", () => {
  const builder = pipeline("p") as unknown as Record<string, unknown>;

  expect(builder.reconcile).toBeUndefined();
  expect(
    pipeline("p")
      .add(produce(), replayable())
      .build()
      .steps.map((step) => step.id),
  ).toEqual(["produce", "context"]);
});

test("D3: composition nodes and the work-item source step are not the author's to classify", () => {
  const built = pipeline("p")
    .forEachWorkItem({
      queue: "bugTodo",
      do: [produce(), runPipeline({ id: "child", name: "Child", pipeline: "other" })],
    })
    .build();

  expect(built.steps.map((step) => step.id)).toEqual(["ticket", "produce", "child"]);
});

function structureFindings(pipelineDefinition: Record<string, unknown>): string[] {
  return new PipelineStructureValidator()
    .validate({
      source: "test.ts",
      pipeline: { name: "raw", ...pipelineDefinition } as never,
      profileOverrides: {},
      stepOverrides: {},
    })
    .map((finding) => finding.message);
}

test("D2: a raw definition is held to the same rule at validation", () => {
  const steps = [
    { id: "notify", name: "Notify", command: "true", runner: "bash" },
    { id: "produce", name: "Produce", command: "true", runner: "bash", outputs: [result] },
    { id: "child", name: "Child", runner: "pipeline", pipeline_ref: "other" },
  ];

  expect(structureFindings({ steps })).toContain(
    'every step must declare what it reads or delivers; step "notify" declares neither input, output ' +
      "nor rerunOnResume. Declare the artifact a step produces, or a receipt of its side effect, as output; " +
      "or set rerunOnResume: true if replaying it on every invocation is idempotent.",
  );
  expect(structureFindings({ steps: steps.slice(1) }).filter((m) => m.includes("rerunOnResume"))).toEqual([]);
});

test("ignoring: a source keeps its name and command and accumulates the steps it ignores", () => {
  const tree = externalSource("tree", { command: "git write-tree" });
  const ignoring = tree.ignoring("a").ignoring("b", "a");
  expect(ignoring.name).toBe("tree");
  expect(ignoring.command).toBe("git write-tree");
  expect(ignoring.ignoredSteps).toEqual(["a", "b"]);
  expect(tree.ignoredSteps).toBeUndefined();
  expect(() => tree.ignoring()).toThrow("name at least one step id");
  expect(() => tree.ignoring(" ")).toThrow("step ids must be non-empty strings");
});

test("ignoring: an unknown step, the consumer itself, and an output are refused, at build and at validation (L12)", () => {
  const tree = externalSource("tree", { command: "git write-tree" });
  const build = (ignored: string) =>
    pipeline("p")
      .add(
        bashStep({ id: "ui", name: "UI", command, input: [tree.ignoring(ignored)], output: [result] }),
        bashStep({ id: "recheck", name: "Recheck", command, input: [tree] }),
      )
      .build();
  expect(() => build("recheck")).not.toThrow();
  expect(() => build("nope")).toThrow('step "ui": source "tree" ignores "nope", which is not a step of the pipeline');
  expect(() => build("ui")).toThrow('step "ui": source "tree" cannot ignore the step that reads it');
  expect(() =>
    bashStep({ id: "ui", name: "UI", command, output: [tree.ignoring("recheck") as never] }).build(),
  ).toThrow('source "tree" cannot be an output');

  expect(
    structureFindings({
      steps: [{ id: "ui", name: "UI", command: "true", runner: "bash", sources: [tree.ignoring("nope", "ui")] }],
    }),
  ).toEqual(
    expect.arrayContaining([
      'step "ui": source "tree" ignores "nope", which is not a step of the pipeline',
      'step "ui": source "tree" cannot ignore the step that reads it',
    ]),
  );
});

test("onStale: stop is recorded, run is the default, and a step without a stamp to be stale is refused (L12)", () => {
  expect(bashStep({ id: "a", name: "A", command, input: [source], onStale: "stop" }).build().on_stale).toBe("stop");
  expect(bashStep({ id: "a", name: "A", command, input: [source], onStale: "run" }).build().on_stale).toBeUndefined();
  const refusal = "onStale applies only to a step that declares input or output, without rerunOnResume";
  expect(() => bashStep({ id: "a", name: "A", command, rerunOnResume: true, onStale: "stop" }).build()).toThrow(
    refusal,
  );
  expect(() =>
    bashStep({ id: "a", name: "A", command, output: [result], rerunOnResume: true, onStale: "stop" }).build(),
  ).toThrow(refusal);
  expect(() => bashStep({ id: "a", name: "A", command, onStale: "later" as never })).toThrow(
    'onStale must be "run" or "stop"',
  );
  expect(
    structureFindings({
      steps: [{ id: "a", name: "A", command: "true", runner: "bash", rerun_on_resume: true, on_stale: "stop" }],
    }),
  ).toContain(`step "a": ${refusal}`);
});
