import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBackendRegistry } from "../contracts/backends.ts";
import { CODEX_MODEL, llmStep } from "../dsl.js";
import { clearCapabilityCache, isForked, parseFrontmatterAxes } from "../env/capability-frontmatter.ts";
import { parseStepOverrides } from "../env/config.schema.ts";
import type { PipelineContext } from "../model/context.ts";
import type { Pipeline, PipelineStep } from "../model/definition.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import {
  applyStepOverrides,
  checkStepOverrides,
  imposedAxes,
  resolveEffectiveAxes,
  stepCapability,
  stepOverrideFor,
} from "./step-overrides.ts";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { commandRegistries } from "../commands/registries.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

const CONFIG = ".lance-nuit/config.json";
/** The registry travels with the context; `applyStepOverrides` reads it from there. */
const CONTEXT = buildPipelineContext({ ...commandRegistries(), agentBackendRegistry: REGISTRY });

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
    ...commandRegistries(),
    cwd: dir,
    runnerDir: join(dir, "kit", "lance-nuit", "runner"),
  });
}

test("parseStepOverrides: validates the contract", () => {
  const parsed = parseStepOverrides({
    "*": { model: "opus" },
    "bugfix:triage": { model: "opus", effort: "high" },
    "bugfix:*": { effort: "medium" },
  });
  expect(parsed["*"]).toEqual({ model: "opus" });
  expect(parsed["bugfix:triage"]).toEqual({ model: "opus", effort: "high" });
  expect(parsed["bugfix:*"]).toEqual({ effort: "medium" });
});

test("parseStepOverrides: validates the contract", () => {
  expect(parseStepOverrides(undefined)).toEqual({});
});

test("parseStepOverrides: validates the contract", () => {
  expect(() => parseStepOverrides({ "a:b": { effort: "highest" } })).toThrow(/\["a:b"\]\.effort/);
});

test("parseStepOverrides: validates the contract", () => {
  expect(() => parseStepOverrides({ "a:b": { timeout: 30 } })).toThrow(/Unrecognized key: "timeout"/);
});

test("parseStepOverrides: validates the contract", () => {
  expect(() => parseStepOverrides({ "a:b": { model: "  " } })).toThrow(
    /must be a non-empty string[\s\S]*\["a:b"\]\.model/,
  );
});

test("applyStepOverrides: validates the contract", () => {
  const pipeline = pipelineOf(claudeStep("one"), claudeStep("two"));
  applyStepOverrides(
    pipeline,
    parseStepOverrides({
      "*": { model: "haiku", effort: "low" },
      "demo:*": { model: "sonnet" },
      "demo:two": { model: "opus", effort: "max" },
    }),
    CONFIG,
    CONTEXT,
  );
  const [one, two] = pipeline.steps;
  expect(one.backend?.options).toEqual({ model: "sonnet", effort: "low" });
  expect(two.backend?.options).toEqual({ model: "opus", effort: "max" });
});

test("resolveEffectiveAxes: validates the contract", () => {
  const step = claudeStep("one", {
    profile: "operator",
    backend: { id: "claude", options: { model: "sonnet", effort: "low" } },
  });
  expect(resolveEffectiveAxes(step, undefined, { model: "opus", effort: "high" })).toEqual({
    imposed: {},
    configured: { model: "opus", effort: "high" },
    effective: { model: "opus", effort: "high" },
    source: "config",
  });
});

test("stepOverrideFor: validates the contract", () => {
  const overrides = parseStepOverrides({
    "*": { effort: "low" },
    "demo:*": { model: "sonnet" },
    "demo:one": { effort: "high" },
  });
  expect(stepOverrideFor("demo", "one", overrides)).toEqual({ model: "sonnet", effort: "high" });
});

test("applyStepOverrides: validates the contract", () => {
  const pipeline = pipelineOf(claudeStep("one"));
  expect(() =>
    applyStepOverrides(pipeline, parseStepOverrides({ "demo:gone": { model: "opus" } }), CONFIG, CONTEXT),
  ).toThrow(/steps\["demo:gone"\] does not match any step in "demo"/);
});

test("applyStepOverrides: validates the contract", () => {
  const pipeline = pipelineOf(claudeStep("one"));
  applyStepOverrides(pipeline, parseStepOverrides({ "other:step": { model: "opus" } }), CONFIG, CONTEXT);
  expect(pipeline.steps[0].backend?.options).toBeUndefined();
});

test("applyStepOverrides: validates the contract", () => {
  const pipeline = pipelineOf({ id: "sh", name: "sh", command: "make test", runner: "bash" });
  expect(() =>
    applyStepOverrides(pipeline, parseStepOverrides({ "demo:sh": { model: "opus" } }), CONFIG, CONTEXT),
  ).toThrow(/targets a bash step/);
});

test("applyStepOverrides: validates the contract", () => {
  const step = llmStep(
    { id: "codex", name: "Codex", backend: "codex", profile: "coder", command: "x" },
    REGISTRY,
  ).build();
  const pipeline = { name: "demo", steps: [step] };
  applyStepOverrides(
    pipeline,
    parseStepOverrides({ "demo:codex": { model: CODEX_MODEL.GPT_5_CODEX } }),
    CONFIG,
    CONTEXT,
  );
  expect(pipeline.steps[0].backend).toEqual({ id: "codex", options: { model: CODEX_MODEL.GPT_5_CODEX } });
  const effortStep = llmStep(
    { id: "codex", name: "Codex", backend: "codex", profile: "coder", command: "x" },
    REGISTRY,
  ).build();
  const effortPipeline = { name: "demo", steps: [effortStep] };
  applyStepOverrides(effortPipeline, parseStepOverrides({ "demo:codex": { effort: "high" } }), CONFIG, CONTEXT);
  expect(effortStep.backend).toEqual({ id: "codex", options: { effort: "high" } });
});

/** Registry with a single backend that translates `effort` but not `model`. The
 *  three builtin providers declare both axes, so only a custom one can exercise the
 *  unsupported-axis rule. */
function effortOnlyRegistry(): AgentBackendRegistry {
  return new AgentBackendRegistry().register({
    id: "effort-only",
    capabilities: { configurationAxes: ["effort"] } as never,
    create() {
      return {
        id: "effort-only",
        capabilities: this.capabilities,
        applyConfigAxes: (options: unknown, axes: unknown) => ({ ...(options as object), ...(axes as object) }),
        run: async () => ({}),
      } as never;
    },
  });
}

function effortOnlyStep(id: string): PipelineStep {
  return {
    id,
    name: id,
    command: `prompt ${id}`,
    runner: "agent",
    backend: { id: "effort-only" },
    output_format: "json",
  };
}

test("checkStepOverrides: a generic key is judged like an exact one", () => {
  // The regression this rule closes: lint skipped `*` and `<pipeline>:*`, so this
  // configuration was reported consistent and then rejected at load time.
  const findings = checkStepOverrides({
    pipelineName: "demo",
    steps: [effortOnlyStep("one")],
    overrides: parseStepOverrides({ "*": { model: "opus" } }),
    registry: effortOnlyRegistry(),
  });
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toMatch(/steps\["\*"\]\.model: axis is not supported by backend "effort-only"/);
});

test("checkStepOverrides: one generic key reaching N steps reports once", () => {
  const findings = checkStepOverrides({
    pipelineName: "demo",
    steps: [effortOnlyStep("one"), effortOnlyStep("two"), effortOnlyStep("three")],
    overrides: parseStepOverrides({ "demo:*": { model: "opus" } }),
    registry: effortOnlyRegistry(),
  });
  expect(findings).toHaveLength(1);
});

test("stepCapability: validates the contract", () => {
  const step = claudeStep("spec", { command: (ctx) => `/pipeline-spec ${ctx.ticket}` });
  expect(stepCapability(step, buildPipelineContext({ ...commandRegistries(), cwd: process.cwd() }))).toEqual({
    kind: "skill",
    name: "pipeline-spec",
  });
});

test("stepCapability: validates the contract", () => {
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
    expect(stepCapability(step, buildPipelineContext({ ...commandRegistries(), cwd: process.cwd() }))).toBeUndefined();
    // Drain the microtask queue: an adopted rejection settles here, an orphan one
    // reaches the process handler.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("imposedAxes: validates the contract", () => {
  const context = projectWithSkill("probe", "model: opus\neffort: high\n");
  const step = claudeStep("s", { command: "/probe arg" });
  expect(imposedAxes(step, context)).toEqual({ model: "opus", effort: "high" });
});

test("applyStepOverrides: validates the contract", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const pipeline = pipelineOf(claudeStep("s", { command: "/probe arg" }));
  expect(() =>
    applyStepOverrides(pipeline, parseStepOverrides({ "demo:s": { model: "opus" } }), CONFIG, context),
  ).toThrow(/is imposed by skill probe \(model: sonnet\)/);
});

test("applyStepOverrides: validates the contract", () => {
  // /implement-plan declares effort only; the pipeline still controls the model.
  const context = projectWithSkill("probe", "effort: medium\n");
  const pipeline = pipelineOf(claudeStep("s", { command: "/probe arg" }));
  applyStepOverrides(pipeline, parseStepOverrides({ "demo:s": { model: "opus" } }), CONFIG, context);
  expect(pipeline.steps[0].backend?.options).toEqual({ model: "opus" });

  expect(() =>
    applyStepOverrides(pipeline, parseStepOverrides({ "demo:s": { effort: "max" } }), CONFIG, context),
  ).toThrow(/is imposed by skill probe \(effort: medium\)/);
});

test("applyStepOverrides: validates the contract", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const pipeline = pipelineOf(claudeStep("s", { command: "/probe arg" }));
  applyStepOverrides(pipeline, parseStepOverrides({ "*": { model: "opus", effort: "high" } }), CONFIG, context);
  // Free effort -> applied; imposed model -> absent, so options do not lie about
  // the model actually used.
  expect(pipeline.steps[0].backend?.options).toEqual({ effort: "high" });
});

test("applyStepOverrides: validates the contract", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  const pipeline = pipelineOf(claudeStep("s", { command: "/absente arg" }));
  applyStepOverrides(pipeline, parseStepOverrides({ "demo:s": { model: "opus" } }), CONFIG, context);
  expect(pipeline.steps[0].backend?.options).toEqual({ model: "opus" });
});

test("imposedAxes: validates the contract", () => {
  const context = projectWithSkill("probe", "model: opus\neffort: high\ncontext: fork\n");
  const step = claudeStep("s", { command: "/probe arg" });
  expect(imposedAxes(step, context)).toEqual({});
});

test("applyStepOverrides: validates the contract", () => {
  // The host turn only invokes the fork and relays its verdict; configuring it does not
  // promises no inert behavior, unlike a non-forked skill.
  const context = projectWithSkill("probe", "model: opus\neffort: high\ncontext: fork\n");
  const pipeline = pipelineOf(claudeStep("s", { command: "/probe arg" }));
  applyStepOverrides(pipeline, parseStepOverrides({ "demo:s": { model: "sonnet", effort: "low" } }), CONFIG, context);
  expect(pipeline.steps[0].backend?.options).toEqual({ model: "sonnet", effort: "low" });
});

test("parseFrontmatterAxes: validates the contract", () => {
  expect(parseFrontmatterAxes(`---\nname: x\nmodel: "opus"\neffort: 'high'\n---\ncorps`)).toEqual({
    model: "opus",
    effort: "high",
  });
  expect(parseFrontmatterAxes("# pas de frontmatter")).toEqual({});
  // `model:` outside the frontmatter block does not count.
  expect(parseFrontmatterAxes(`---\nname: x\n---\nmodel: opus`)).toEqual({});
});

test("parseFrontmatterAxes / isForked: validates the contract", () => {
  expect(parseFrontmatterAxes(`---\nname: x\ncontext: fork\n---\ncorps`)).toEqual({ context: "fork" });
  expect(isForked({ context: "fork" })).toBe(true);
  expect(isForked({ context: "inline" })).toBe(false);
  expect(isForked({})).toBe(false);
});
