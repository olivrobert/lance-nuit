import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashStep, llmStep, pipeline } from "../dsl.js";
import { clearCapabilityCache } from "../env/capability-frontmatter.js";
import { parseStepOverrides } from "../env/config.schema.js";
import type { Pipeline } from "../model/definition.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { validatePipeline } from "../pipeline/loader.js";
import { PipelineValidationError } from "./chain.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Validation runs against the registry the run carries: rules read it from the context. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

beforeEach(clearCapabilityCache);

test("validatePipeline aggregates independent step errors", () => {
  const invalid = pipeline("broken")
    .add(
      llmStep(
        { id: "backend", name: "Backend", backend: "codeex" as never, profile: "coder", command: "run" },
        REGISTRY,
      ),
    )
    .add(bashStep({ id: "reports", name: "Reports", command: "make test", report: "reports.xml" }))
    .build();

  let error: unknown;
  try {
    validatePipeline(invalid, "broken.ts", { context: CONTEXT });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(PipelineValidationError);
  const validationError = error as PipelineValidationError;
  expect(validationError.findings.map((finding) => finding.rule)).toEqual(["agent-backend", "extractor-references"]);
  expect(validationError.message).toMatch(/unknown agent backend "codeex"/);
  expect(validationError.message).toMatch(/report requires errorExtractor/);
});

test("validatePipeline checks step references and capability conflicts before mutation", () => {
  const project = mkdtempSync(join(tmpdir(), "pipeline-validation-"));
  const skillDir = join(project, ".claude", "skills", "probe");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: probe\nmodel: sonnet\n---\n\nprobe\n");

  const context = buildPipelineContext({
    agentBackendRegistry: REGISTRY,
    cwd: project,
    runnerDir: join(project, "kit", "lance-nuit", "runner"),
  });
  const definition = pipeline("demo")
    .add(llmStep({ id: "probe", name: "Probe", backend: "claude", profile: "operator", command: "/probe" }, REGISTRY))
    .build();
  const overrides = parseStepOverrides({
    "demo:probe": { model: "opus" },
    "demo:missing": { effort: "high" },
  });

  let error: unknown;
  try {
    validatePipeline(definition, "demo.ts", {
      profileOverrides: context.config.profiles,
      stepOverrides: overrides,
      context,
    });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(PipelineValidationError);
  const validationError = error as PipelineValidationError;
  const configurationFindings = validationError.findings.filter(
    (finding) => finding.rule === "configuration-references",
  );
  expect(configurationFindings).toHaveLength(2);
  expect(validationError.message).toMatch(/is imposed by skill probe \(model: sonnet\)/);
  expect(validationError.message).toMatch(/demo:missing.*does not match any step/);
  // The loader has not applied profiles or overrides when validation fails:
  // the backend remains in its original DSL shape.
  expect(definition.steps[0]?.backend).toEqual({ id: "claude" });
});

test("validatePipeline rejects a profile policy referencing a missing backend", () => {
  const definition = pipeline("demo")
    .add(llmStep({ id: "agent", name: "Agent", backend: "codex", profile: "coder", command: "run" }, REGISTRY))
    .build();

  expect(() =>
    validatePipeline(definition, "demo.ts", {
      profileOverrides: {
        coder: { backends: { future: { model: "future-model" } } },
      },
      context: CONTEXT,
    }),
  ).toThrow(/profiles\["coder"\]\.backends\.future.*unknown backend "future"/);
});

test("validatePipeline rejects step IDs outside the storage-safe alphabet", () => {
  const definition = {
    name: "logs",
    steps: [{ id: "a?b", name: "A", command: "true", runner: "bash" }],
  } as Pipeline;

  expect(() => validatePipeline(definition, "logs.ts", { context: CONTEXT })).toThrow(/safe logical value/);
  expect(() => bashStep({ id: "a/b", name: "A", command: "true" }).build()).toThrow(/safe logical value/);
});

test("validatePipeline rejects reserved pipeline directory names", () => {
  for (const name of [".", ".."]) {
    const definition = {
      name,
      steps: [{ id: "step", name: "Step", command: "true", runner: "bash" }],
    } as Pipeline;

    expect(() => validatePipeline(definition, `${name}.ts`, { context: CONTEXT })).toThrow(
      /pipeline name.*safe logical value/,
    );
  }
});

test("validatePipeline rejects non-finite and fractional retry quotas", () => {
  for (const [label, retries] of [
    ["infinite", Infinity],
    ["not-a-number", NaN],
    ["fractional", 1.5],
  ] as const) {
    const definition = pipeline(`invalid-retries-${label}`)
      .add(
        bashStep({
          id: "retry",
          name: "Retry",
          command: "false",
          onFail: { retries },
        }),
      )
      .build();

    expect(() => validatePipeline(definition, `${label}.ts`, { context: CONTEXT })).toThrow(
      /max_retries must be a finite integer/,
    );
  }
});

test("validatePipeline rejects a raw definition capturing on a non-agent step", () => {
  const definition = {
    name: "capture",
    steps: [
      {
        id: "bash",
        name: "Bash",
        command: "true",
        runner: "bash",
        captures: [{ field: "commit", artifact: { name: "c.md" }, schema: { type: "string" }, text: true }],
      },
    ],
  } as unknown as Pipeline;

  expect(() => validatePipeline(definition, "capture.ts", { context: CONTEXT })).toThrow(
    /capture applies only to runner "agent"/,
  );
});
