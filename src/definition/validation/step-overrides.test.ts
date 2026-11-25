import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBackendRegistry } from "../../contracts/backends.ts";
import { clearCapabilityCache } from "../../shared/env/capability-frontmatter.ts";
import { parseStepOverrides } from "../../shared/env/config.schema.ts";
import type { PipelineContext } from "../../shared/language/context.ts";
import type { PipelineStep } from "../definition.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { checkStepOverrides } from "./step-overrides.ts";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

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

function messages(steps: PipelineStep[], overrides: Record<string, unknown>, context?: PipelineContext): string[] {
  return checkStepOverrides({
    pipelineName: "demo",
    steps,
    overrides: parseStepOverrides(overrides),
    registry: REGISTRY,
    context,
  }).map((finding) => finding.message);
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

test("parseStepOverrides: an absent section is empty", () => {
  expect(parseStepOverrides(undefined)).toEqual({});
});

test("parseStepOverrides: an unknown effort is rejected", () => {
  expect(() => parseStepOverrides({ "a:b": { effort: "highest" } })).toThrow(/\["a:b"\]\.effort/);
});

test("parseStepOverrides: an unknown axis is rejected", () => {
  expect(() => parseStepOverrides({ "a:b": { timeout: 30 } })).toThrow(/Unrecognized key: "timeout"/);
});

test("parseStepOverrides: a blank model is rejected", () => {
  expect(() => parseStepOverrides({ "a:b": { model: "  " } })).toThrow(
    /must be a non-empty string[\s\S]*\["a:b"\]\.model/,
  );
});

test("checkStepOverrides: an exact key must name an existing step", () => {
  expect(messages([claudeStep("one")], { "demo:gone": { model: "opus" } })).toEqual([
    expect.stringMatching(/steps\["demo:gone"\] does not match any step in "demo"/),
  ]);
});

test("checkStepOverrides: a key targeting another pipeline is not judged", () => {
  expect(messages([claudeStep("one")], { "other:step": { model: "opus" } })).toEqual([]);
});

test("checkStepOverrides: an exact key cannot target a bash step", () => {
  const bash: PipelineStep = { id: "sh", name: "sh", command: "make test", runner: "bash" };
  expect(messages([bash], { "demo:sh": { model: "opus" } })).toEqual([expect.stringMatching(/targets a bash step/)]);
});

test("checkStepOverrides: an exact key cannot set an axis the capability imposes", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  expect(messages([claudeStep("s", { command: "/probe arg" })], { "demo:s": { model: "opus" } }, context)).toEqual([
    expect.stringMatching(/is imposed by skill probe \(model: sonnet\)/),
  ]);
});

test("checkStepOverrides: an exact key may set the axis the capability leaves free", () => {
  // /implement-plan declares effort only; the pipeline still controls the model.
  const context = projectWithSkill("probe", "effort: medium\n");
  const step = claudeStep("s", { command: "/probe arg" });
  expect(messages([step], { "demo:s": { model: "opus" } }, context)).toEqual([]);
  expect(messages([step], { "demo:s": { effort: "max" } }, context)).toEqual([
    expect.stringMatching(/is imposed by skill probe \(effort: medium\)/),
  ]);
});

test("checkStepOverrides: a generic key stays silent on an imposed axis", () => {
  const context = projectWithSkill("probe", "model: sonnet\n");
  expect(messages([claudeStep("s", { command: "/probe arg" })], { "*": { model: "opus" } }, context)).toEqual([]);
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
  expect(findings[0]!.message).toMatch(/steps\["\*"\]\.model: axis is not supported by backend "effort-only"/);
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
