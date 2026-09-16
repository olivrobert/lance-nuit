import { expect, test } from "bun:test";
import { llmStep, pipeline } from "../dsl.js";
import { parseProfileOverrides } from "../env/config.schema.js";
import { PipelineValidationChain } from "./chain.js";
import { ProfileCoherenceValidator } from "./profile-coherence.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Rules read the registry from the context; there is no built-in fallback. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

/** `planner` is the reference role WITHOUT a Codex policy: `coder`, `reviewer`,
 *  and `extractor` all declare one, so neither case below would be exercised. */
function codexPipeline(profile: "coder" | "planner") {
  return pipeline("validation")
    .add(llmStep({ id: "agent", name: "Agent", backend: "codex" as never, profile, command: "run" }, REGISTRY))
    .build();
}

test("ProfileCoherenceValidator: reports a finding for an unavailable role", () => {
  const report = new PipelineValidationChain([new ProfileCoherenceValidator()]).validate({
    source: "test",
    pipeline: codexPipeline("planner"),
    profileOverrides: {},
    pipelineContext: CONTEXT,
  });

  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].rule).toBe("profile-coherence");
  expect(report.errors[0].message).toMatch(/planner.*codex/);
});

test("ProfileCoherenceValidator: accepts a policy added by configuration", () => {
  const report = new PipelineValidationChain([new ProfileCoherenceValidator()]).validate({
    source: "test",
    pipeline: codexPipeline("planner"),
    profileOverrides: parseProfileOverrides({
      planner: { backends: { codex: { model: "gpt-5-codex", effort: "medium" } } },
    }),
    pipelineContext: CONTEXT,
  });

  expect(report.ok).toBe(true);
  expect(report.findings).toEqual([]);
});
