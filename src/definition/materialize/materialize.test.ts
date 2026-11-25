import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MODEL, llmStep } from "../dsl.js";
import { clearCapabilityCache, isForked, parseFrontmatterAxes } from "../../shared/env/capability-frontmatter.ts";
import { parseProfileOverrides, parseStepOverrides } from "../../shared/env/config.schema.ts";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.ts";
import type { Pipeline, PipelineStep } from "../definition.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { materializePipeline } from "./materialize.ts";
import { imposedAxes, resolveStepAxes, stepCapability } from "./step-axes.ts";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
const CONTEXT = buildPipelineContext({ ...builtinRegistries(), agentBackendRegistry: REGISTRY });

beforeEach(clearCapabilityCache);

function claudeStep(id: string, extra: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    name: id,
    command: `prompt ${id}`,
    runner: "agent",
    backend: { id: "claude" },
    output_format: "json",
    ...extra,
  };
}

function pipelineOf(...steps: PipelineStep[]): Pipeline {
  return { name: "demo", steps };
}

/** Temporary project with a skill: the resolver searches under <cwd>/.claude.
 *  runnerDir mirrors the real tree (`<kit>/lance-nuit/runner`) so the kit
 *  monorepo root remains in tmpdir rather than all of /tmp. */
function projectWithSkill(name: string, frontmatter: string): PipelineContext {
  const dir = mkdtempSync(join(tmpdir(), "overrides-"));
  mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\ncorps\n`);
  return buildPipelineContext({
    ...builtinRegistries(),
    cwd: dir,
    runnerDir: join(dir, "kit", "lance-nuit", "runner"),
  });
}

function materialize(
  pipeline: Pipeline,
  steps: Record<string, unknown>,
  context: PipelineContext = CONTEXT,
  profiles: Record<string, unknown> = {},
): Pipeline {
  materializePipeline(pipeline, {
    profileOverrides: parseProfileOverrides(profiles),
    stepOverrides: parseStepOverrides(steps),
    context,
  });
  return pipeline;
}

function axesOf(step: PipelineStep, steps: Record<string, unknown>, context: PipelineContext = CONTEXT) {
  return resolveStepAxes(step, {
    pipelineName: "demo",
    stepOverrides: parseStepOverrides(steps),
    profileOverrides: {},
    registry: requireAgentBackendRegistry(context),
    context,
  });
}

test("materializePipeline: keys accumulate from the broadest to the most specific", () => {
  const pipeline = materialize(pipelineOf(claudeStep("one"), claudeStep("two")), {
    "*": { model: "haiku", effort: "low" },
    "demo:*": { model: "sonnet" },
    "demo:two": { model: "opus", effort: "max" },
  });
  const [one, two] = pipeline.steps;
  expect(one!.backend?.options).toEqual({ model: "sonnet", effort: "low" });
  expect(two!.backend?.options).toEqual({ model: "opus", effort: "max" });
});

test("materializePipeline: a key targeting another pipeline writes nothing", () => {
  const pipeline = materialize(pipelineOf(claudeStep("one")), { "other:step": { model: "opus" } });
  expect(pipeline.steps[0]!.backend?.options).toBeUndefined();
});

test("materializePipeline: the steps configuration wins over the Codex profile, axis by axis", () => {
  const step = llmStep(
    { id: "codex", name: "Codex", backend: "codex", profile: "coder", command: "x" },
    REGISTRY,
  ).build();
  materialize({ name: "demo", steps: [step] }, { "demo:codex": { model: CODEX_MODEL.GPT_5_CODEX } });
  expect(step.backend).toEqual({ id: "codex", options: { model: CODEX_MODEL.GPT_5_CODEX, effort: "medium" } });
});

test("materializePipeline: an imposed axis is never written, the free one is", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const pipeline = materialize(
    pipelineOf(claudeStep("s", { command: "/probe arg" })),
    { "*": { model: "opus", effort: "high" } },
    context,
  );
  // Imposed model absent, so options do not lie about the model actually used.
  expect(pipeline.steps[0]!.backend?.options).toEqual({ effort: "high" });
});

test("materializePipeline: an imposed axis ignores the profile configuration too", () => {
  const context = projectWithSkill("probe", "model: haiku\n");
  const pipeline = materialize(
    pipelineOf(claudeStep("a", { profile: "operator", command: "/probe arg" })),
    {},
    context,
    { operator: { backends: { claude: { model: "opus", effort: "high" } } } },
  );
  expect(pipeline.steps[0]!.backend).toEqual({ id: "claude", options: { effort: "high" } });
});

test("materializePipeline: a missing capability file imposes nothing", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const pipeline = materialize(
    pipelineOf(claudeStep("s", { command: "/absente arg" })),
    { "demo:s": { model: "opus" } },
    context,
  );
  expect(pipeline.steps[0]!.backend?.options).toEqual({ model: "opus" });
});

test("materializePipeline: a forked capability leaves the host turn configurable", () => {
  // The host turn only invokes the fork and relays its verdict; configuring it
  // promises no inert behavior, unlike a non-forked skill.
  const context = projectWithSkill("probe", "model: opus\neffort: high\ncontext: fork\n");
  const pipeline = materialize(
    pipelineOf(claudeStep("s", { command: "/probe arg" })),
    { "demo:s": { model: "sonnet", effort: "low" } },
    context,
  );
  expect(pipeline.steps[0]!.backend?.options).toEqual({ model: "sonnet", effort: "low" });
});

test("resolveStepAxes: the configuration wins over the profile", () => {
  const step = claudeStep("one", { profile: "operator" });
  expect(axesOf(step, { "demo:one": { model: "opus", effort: "high" } })).toEqual({
    imposed: {},
    profile: { model: "sonnet", effort: "low" },
    configured: { model: "opus", effort: "high" },
    effective: { model: "opus", effort: "high" },
    sources: { model: "config", effort: "config" },
  });
});

test("resolveStepAxes: one source per axis, capability for one and configuration for the other", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const step = claudeStep("s", { profile: "coder", command: "/probe arg" });
  expect(axesOf(step, { "demo:s": { effort: "high" } }, context)).toEqual({
    capability: { kind: "skill", name: "probe" },
    imposed: { model: "sonnet" },
    profile: { effort: "medium" },
    configured: { effort: "high" },
    effective: { model: "sonnet", effort: "high" },
    sources: { model: "capability", effort: "config" },
  });
});

test("resolveStepAxes: without profile nor configuration, the machine default runs", () => {
  expect(axesOf(claudeStep("one"), {}).sources).toEqual({ model: "machine default", effort: "machine default" });
});

test("stepCapability: a closure command is resolved with the context", () => {
  const step = claudeStep("spec", { command: (ctx) => `/pipeline-spec ${ctx.ticket}` });
  expect(stepCapability(step, buildPipelineContext({ ...builtinRegistries(), cwd: process.cwd() }))).toEqual({
    kind: "skill",
    name: "pipeline-spec",
  });
});

test("stepCapability: a declared agent is the capability", () => {
  const step = claudeStep("review", { backend: { id: "claude", options: { agent: "plugin:checker" } } });
  expect(stepCapability(step)).toEqual({ kind: "agent", name: "plugin:checker" });
});

test("stepCapability: a rejecting async command imposes no capability and leaks no rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const step = claudeStep("checkout", {
      // An async command reading an artifact a LATER step writes rejects on every
      // call made before that step runs, boot-time detection included.
      command: async () => {
        throw new Error("branch.json not found");
      },
    });
    expect(stepCapability(step, buildPipelineContext({ ...builtinRegistries(), cwd: process.cwd() }))).toBeUndefined();
    // Drain the microtask queue: an adopted rejection settles here, an orphan one
    // reaches the process handler.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("imposedAxes: reads the capability frontmatter", () => {
  const context = projectWithSkill("probe", "model: opus\neffort: high\n");
  expect(imposedAxes(claudeStep("s", { command: "/probe arg" }), context)).toEqual({ model: "opus", effort: "high" });
});

test("imposedAxes: a forked capability imposes nothing", () => {
  const context = projectWithSkill("probe", "model: opus\neffort: high\ncontext: fork\n");
  expect(imposedAxes(claudeStep("s", { command: "/probe arg" }), context)).toEqual({});
});

test("parseFrontmatterAxes: reads axes inside the frontmatter only", () => {
  expect(parseFrontmatterAxes(`---\nname: x\nmodel: "opus"\neffort: 'high'\n---\ncorps`)).toEqual({
    model: "opus",
    effort: "high",
  });
  expect(parseFrontmatterAxes("# pas de frontmatter")).toEqual({});
  // `model:` outside the frontmatter block does not count.
  expect(parseFrontmatterAxes(`---\nname: x\n---\nmodel: opus`)).toEqual({});
});

test("parseFrontmatterAxes / isForked: reads the fork context", () => {
  expect(parseFrontmatterAxes(`---\nname: x\ncontext: fork\n---\ncorps`)).toEqual({ context: "fork" });
  expect(isForked({ context: "fork" })).toBe(true);
  expect(isForked({ context: "inline" })).toBe(false);
  expect(isForked({})).toBe(false);
});
