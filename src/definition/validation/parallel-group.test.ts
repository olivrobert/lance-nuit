import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import type { Pipeline, PipelineStep } from "../definition.js";
import { artifact, source, textArtifact } from "../dsl/artifact.ts";
import { type AgentStepBuilder, createProjectBashStep } from "../dsl/dsl-steps.ts";
import type { LlmStepOptions, OnFail, StepOptionsBase } from "../dsl/dsl-types.js";
import { actionStep, humanReview, llmStep, parallelize, pipeline, runPipeline } from "../dsl.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition, validatePipeline } from "../pipeline/loader.js";

const REGISTRY = createDefaultAgentBackendRegistry();
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });
const bashStep = createProjectBashStep(REGISTRY);

type LlmOptions = LlmStepOptions<"coder", "claude">;

function member(id: string, options: Partial<StepOptionsBase> & Pick<LlmOptions, "capture"> = {}): AgentStepBuilder {
  return llmStep({ id, name: id, profile: "coder", backend: "claude", command: "read", ...options }, REGISTRY);
}

function codexMember(id: string, sandbox: "read-only" | "workspace-write" | "danger-full-access"): AgentStepBuilder {
  return llmStep(
    { id, name: id, profile: "coder", backend: "codex", command: "read", options: { sandbox } } as never,
    REGISTRY,
  );
}

function group(...steps: AgentStepBuilder[]): AgentStepBuilder[] {
  return parallelize({ id: "audits", name: "Audits", steps });
}

function problems(built: Pipeline): string {
  try {
    validatePipeline(built, "test", { context: CONTEXT });
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

function problemsOf(...steps: AgentStepBuilder[]): string {
  return problems(
    pipeline("p")
      .add(group(...steps))
      .build(),
  );
}

test("a valid group stays flat in the pipeline, each step marked with its group", () => {
  const built = pipeline("p")
    .add(
      bashStep({ id: "before", name: "Before", command: "true" }),
      group(member("audits.security"), member("audits.perf")),
      bashStep({ id: "after", name: "After", command: "true" }),
    )
    .build();

  expect(problems(built)).toBe("");
  expect(built.steps.map((step: PipelineStep) => step.id)).toEqual([
    "before",
    "audits.security",
    "audits.perf",
    "after",
  ]);
  expect(built.steps.map((step: PipelineStep) => step.parallel_group)).toEqual([
    undefined,
    { id: "audits", name: "Audits" },
    { id: "audits", name: "Audits" },
    undefined,
  ]);
});

test("retries, distinct outputs and a read-only Codex member are accepted", () => {
  const security = textArtifact("security.md");
  const perf = textArtifact("perf.md");

  expect(
    problemsOf(
      member("audits.security", { onFail: { retries: 2 }, capture: { report: security } }),
      member("audits.perf", { capture: { report: perf } }),
      codexMember("audits.codex", "read-only"),
    ),
  ).toBe("");
});

test("parallelize refuses what it cannot mark", () => {
  expect(() => parallelize(undefined as never)).toThrow("parallelize() expects an options object");
  expect(() => parallelize({ id: " ", name: "n", steps: [] })).toThrow("id");
  expect(() => parallelize({ id: "g", name: "", steps: [] })).toThrow("name");
  expect(() => parallelize({ id: "g", name: "n", steps: "x" as never })).toThrow(
    'Parallel group "g": steps must be an array',
  );
  // `humanReview` returns an array: flattened by `add`, not here.
  expect(() => parallelize({ id: "g", name: "n", steps: [[member("g.a")]] as never })).toThrow(
    'Parallel group "g": steps[0] must be a step built by llmStep',
  );
});

test("a group needs at least two steps", () => {
  expect(problemsOf(member("audits.only"))).toContain('parallel group "audits": needs at least 2 steps, found 1');
});

test("a group id must be usable as a logical value", () => {
  const built = pipeline("p")
    .add(parallelize({ id: "../x", name: "x", steps: [member("a"), member("b")] }))
    .build();

  expect(problems(built)).toContain('parallel group "../x": id must be a non-empty safe logical value');
});

for (const [kind, other] of [
  ["bashStep", () => bashStep({ id: "audits.other", name: "o", command: "true" })],
  ["actionStep", () => actionStep({ id: "audits.other", name: "o", describe: "o", run: async () => {} })],
  ["runPipeline", () => runPipeline({ id: "audits.other", name: "o", pipeline: "child" })],
] as const) {
  test(`a group refuses a ${kind}`, () => {
    expect(problemsOf(member("audits.a"), other() as unknown as AgentStepBuilder)).toContain(
      'parallel group "audits": step "audits.other": a group holds only agent steps (llmStep)',
    );
  });
}

test("every member id starts with the group id", () => {
  expect(problemsOf(member("audits.a"), member("auditsb"))).toContain(
    'parallel group "audits": step "auditsb": id must start with "audits."',
  );
});

for (const [name, onFail] of [
  ["fix", { fix: () => "fix" }],
  ["resumeSession", { fix: () => "fix", resumeSession: "earlier" }],
] as [string, OnFail][]) {
  test(`a member refuses onFail with ${name}`, () => {
    expect(problemsOf(member("audits.a", { onFail }), member("audits.b"))).toContain(
      'parallel group "audits": step "audits.a": onFail.fix is refused',
    );
  });
}

test("a member cannot be the rework step of a later gate", () => {
  const report = textArtifact("report.md");
  const built = pipeline("p")
    .add(
      group(member("audits.a", { capture: { report } }), member("audits.b")),
      humanReview({
        id: "gate",
        artifact: report,
        kind: "needs-decision",
        blocked: () => true,
        approval: { subject: "sujet" },
        rework: { step: "audits.a" },
        reason: () => "blocked",
      }),
    )
    .build();

  expect(problems(built)).toContain(
    'parallel group "audits": step "audits.a": cannot be the rework step of "sujet", it would replay without its group',
  );
});

test("two members cannot share an output, captured or declared", () => {
  const shared = textArtifact("shared.md");

  expect(
    problemsOf(member("audits.a", { capture: { report: shared } }), member("audits.b", { output: [shared] })),
  ).toContain('parallel group "audits": steps "audits.a" and "audits.b" share output "shared.md"');
});

test("two members cannot share a report", () => {
  expect(
    problemsOf(member("audits.a", { report: "out.json" }), member("audits.b", { report: ["out.json"] })),
  ).toContain('parallel group "audits": steps "audits.a" and "audits.b" share report "out.json"');
});

test("a member cannot read the output of a sibling, whichever is declared first", () => {
  const written = artifact("written.json", (raw) => raw);
  const own = textArtifact("own.md");
  const message =
    'parallel group "audits": step "audits.reader" reads "written.json", the output of "audits.writer", which is not written yet';
  const reader = () => member("audits.reader", { input: [written], output: [own] });
  const writer = () => member("audits.writer", { output: [written] });

  expect(problemsOf(reader(), writer())).toContain(message);
  expect(problemsOf(writer(), reader())).toContain(message);
});

test("a member may revise its own output", () => {
  const revised = textArtifact("revised.md");

  expect(problemsOf(member("audits.a", { input: [revised], output: [revised] }), member("audits.b"))).toBe("");
});

test("an external source named like a sibling's output is not that output", () => {
  const output = textArtifact("state");
  const external = source("state", { command: "git rev-parse HEAD" });
  const own = textArtifact("own.md");

  expect(
    problemsOf(member("audits.a", { output: [output] }), member("audits.b", { input: [external], output: [own] })),
  ).toBe("");
});

for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
  test(`a Codex member refuses sandbox ${sandbox}`, () => {
    expect(problemsOf(codexMember("audits.a", sandbox), member("audits.b"))).toContain(
      `parallel group "audits": step "audits.a": sandbox "${sandbox}" lets it write`,
    );
  });
}

test("a group is declared in one piece", () => {
  const built = pipeline("p")
    .add(
      parallelize({ id: "audits", name: "Audits", steps: [member("audits.a")] }),
      bashStep({ id: "between", name: "Between", command: "true" }),
      parallelize({ id: "audits", name: "Audits", steps: [member("audits.b")] }),
    )
    .build();

  expect(problems(built)).toContain(
    'parallel group "audits": its steps must be declared together, with no other step between them',
  );
});

test("the selector of a group reaches its members and nothing else", () => {
  const built = pipeline("p")
    .add(
      group(member("audits.a"), member("audits.b")),
      bashStep({ id: "audits", name: "Named like it", command: "true" }),
      bashStep({ id: "audits.stranger", name: "Under its prefix", command: "true" }),
    )
    .build();

  const message = problems(built);
  expect(message).toContain('parallel group "audits": step "audits" has the id of the group');
  expect(message).toContain('parallel group "audits": step "audits.stranger" uses its prefix but is not in the group');
});

test("a loaded pipeline gets parallelize from its Dsl and is refused at load", async () => {
  const root = mkdtempSync(join(tmpdir(), "parallel-group-load-"));
  const path = join(root, "pipeline.ts");
  const context = buildPipelineContext({ cwd: root, agentBackendRegistry: REGISTRY });
  writeFileSync(
    path,
    `export default ({ pipeline, parallelize, llmStep }) => pipeline("p")
      .add(parallelize({ id: "audits", name: "Audits", steps: [
        llmStep({ id: "audits.a", name: "a", profile: "coder", backend: "claude", command: "read" }),
      ] }))
      .build();`,
  );

  await expect(loadPipelineDefinition(path, context)).rejects.toThrow("needs at least 2 steps");
});
