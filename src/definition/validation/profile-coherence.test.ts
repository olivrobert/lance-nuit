import { expect, test } from "bun:test";
import { llmStep, pipeline } from "../dsl.js";
import { parseProfileOverrides } from "../../shared/env/config.schema.js";
import { PipelineValidationChain } from "./chain.js";
import { ProfileCoherenceValidator } from "./profile-coherence.js";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";
import type { PipelineStep, StepReview } from "../definition.js";
import { validatePipeline } from "./pipeline.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Rules read the registry from the context; there is no built-in fallback. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

/** `planner` is the reference role WITHOUT a Codex policy: `coder`, `reviewer`,
 *  and `extractor` all declare one, so neither case below would be exercised. */
function codexPipeline(profile: "coder" | "planner") {
  return pipeline("validation")
    .add(
      llmStep(
        { id: "agent", name: "Agent", backend: "codex" as never, profile, command: "run", rerunOnResume: true },
        REGISTRY,
      ),
    )
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
  expect(report.errors[0]!.rule).toBe("profile-coherence");
  expect(report.errors[0]!.message).toMatch(/planner.*codex/);
});

test("validation report: an invalid fix_profile is reported with the other errors", () => {
  const steps: PipelineStep[] = [
    {
      id: "lint",
      name: "Lint",
      command: "make lint",
      runner: "bash",
      rerun_on_resume: true,
      on_failure: { max_retries: 1, fix_prompt: "fix", fix_profile: "planner", fix_backend: "codex" },
    },
    { id: "lint", name: "Duplicate", command: "true", runner: "bash", rerun_on_resume: true },
  ];
  expect(() => validatePipeline({ name: "demo", steps }, "demo.ts", { context: CONTEXT })).toThrow(
    /duplicate id "lint"[\s\S]*\[profile-coherence\] step "lint": fix profile "planner" is not defined for backend "codex"/,
  );
});

/** A review step on `claude`, whose review session runs `reviewer` on `review`. */
function reviewStep(review: Partial<StepReview> = {}): PipelineStep {
  return {
    id: "implement",
    name: "Implement",
    command: "implement",
    runner: "agent",
    backend: { id: "claude" },
    profile: "coder",
    review: {
      command: "review",
      backend: { id: "claude" },
      profile: "reviewer",
      capture: { field: "review", schema: {} } as never,
      fix: () => undefined,
      retries: 0,
      ...review,
    },
  };
}

function profileErrors(steps: PipelineStep[], registry = REGISTRY): string[] {
  return new PipelineValidationChain([new ProfileCoherenceValidator()])
    .validate({
      source: "test",
      pipeline: { name: "demo", steps },
      profileOverrides: {},
      pipelineContext: buildPipelineContext({ agentBackendRegistry: registry }),
    })
    .errors.map((finding) => finding.message);
}

test("ProfileCoherenceValidator: a review role needs a policy for the review backend", () => {
  expect(profileErrors([reviewStep()])).toEqual([]);
  expect(profileErrors([reviewStep({ backend: { id: "opencode" } })])).toEqual([
    'step "implement": review profile "reviewer" is not defined for backend "opencode"',
  ]);
  expect(profileErrors([reviewStep({ backend: { id: "phantom" } })])).toEqual([
    expect.stringMatching(/unknown review backend "phantom"/),
  ]);
});

test("ProfileCoherenceValidator: review axes come from the profile, never from backend options", () => {
  expect(profileErrors([reviewStep({ backend: { id: "claude", options: { model: "opus" } } })])).toEqual([
    'step "implement": review model must come from profiles.reviewer.backends.claude, never from backend options',
  ]);
});

test("ProfileCoherenceValidator: a review needs a step backend that resumes sessions", () => {
  const capabilities = { ...REGISTRY.resolve({ id: "claude" }).capabilities, resume: false };
  const registry = createDefaultAgentBackendRegistry().register({
    id: "oneshot",
    capabilities,
    create: () => ({ id: "oneshot", capabilities, run: async () => ({}) }) as never,
  } as never);
  const step = { ...reviewStep(), backend: { id: "oneshot" } };
  expect(profileErrors([step], registry)).toContainEqual(
    'step "implement": review needs a backend that resumes sessions; "oneshot" cannot',
  );
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
