import { expect, test } from "bun:test";
import { bashStep, llmStep, pipeline } from "../dsl.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { formatPipelineLintReport, lintPipeline, lintPipelineDefinition } from "./lint-pipeline.ts";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { commandRegistries } from "./registries.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

const context = () =>
  buildPipelineContext({ ...commandRegistries(), cwd: process.cwd(), runnerDir: process.cwd(), ticket: "LINT-0" });

test("lancenuit lint: generic builtin without execution", async () => {
  const report = await lintPipeline("default", { context: context() });
  const formatted = formatPipelineLintReport(report);

  expect(formatted.exitCode).toBe(0);
  expect(formatted.text).toContain("Pipeline lint: default");
  expect(formatted.text).toMatch(/ID\s+RUNNER\s+PROFILE\s+BACKEND\s+WHEN\s+OUTPUTS/);
  expect(formatted.text).toContain("ready");
});

test("lancenuit lint: duplicate escalation IDs rejected", () => {
  const definition = pipeline("duplicates")
    .add(
      bashStep({ id: "escalate", name: "One", command: "true" }),
      bashStep({ id: "escalate", name: "Two", command: "true" }),
    )
    .build();
  const report = lintPipelineDefinition(definition, context());

  expect(report.findings).toContainEqual(
    expect.objectContaining({
      rule: "escalation-ids",
      level: "error",
    }),
  );
});

test("lancenuit lint: declared capability missing from disk", () => {
  const definition = pipeline("missing-capability")
    .add(
      llmStep(
        {
          id: "agent",
          name: "Agent",
          profile: "planner",
          backend: "claude",
          command: "/skill-that-does-not-exist LINT-0",
        },
        REGISTRY,
      ),
    )
    .build();
  const report = lintPipelineDefinition(definition, context());

  expect(report.findings).toContainEqual(
    expect.objectContaining({
      rule: "capabilities",
      message: expect.stringContaining("skill-that-does-not-exist"),
    }),
  );
});
