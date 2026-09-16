import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfileOverrides, parseStepOverrides } from "../env/config.schema.ts";
import { buildPipelineContext, deriveContext } from "../pipeline/context.ts";
import { formatLintReport, lintStepOverrides } from "./lint-config-check.ts";
import { commandRegistries } from "./registries.js";

const runnerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Use `deriveContext`, not a spread: a spread would read the `workItem` getter
 *  and create the tracker bridge for linting that does not use it. */
function contextWith(steps: Record<string, unknown>, profiles: Record<string, unknown> = {}) {
  const base = buildPipelineContext({ ...commandRegistries(), cwd: runnerDir, runnerDir, ticket: "LINT-0" });
  return deriveContext(base, {
    config: { ...base.config, steps: parseStepOverrides(steps), profiles: parseProfileOverrides(profiles) },
  });
}

test("lint: empty config = no issue with the generic shell builtin", async () => {
  const report = await lintStepOverrides(contextWith({}));
  expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
  expect(report.effective).toEqual([]);
});

test("lint: detects the 4 forms of drift for a steps key", async () => {
  const report = await lintStepOverrides(
    contextWith({
      "default:ready": { model: "sonnet" }, // shell step, without an agent backend
      "default:vanished": { model: "opus" }, // step missing from the DSL
      "phantom:step": { effort: "high" }, // pipeline that does not exist
      unscoped: { model: "opus" }, // key without scope
    }),
  );
  const errors = report.findings.filter((f) => f.level === "error").map((f) => f.message);
  expect(errors).toHaveLength(4);
  // Wording shared with the loader and the pipeline validator: lint and execution
  // must not describe the same key in two different ways.
  expect(errors.some((m) => /"default:ready"\] targets a bash step/.test(m))).toBe(true);
  expect(errors.some((m) => /"default:vanished"\] does not match any step in "default"/.test(m))).toBe(true);
  expect(errors.some((m) => /unknown pipeline "phantom"/.test(m))).toBe(true);
  expect(errors.some((m) => /"unscoped"\]: unqualified key/.test(m))).toBe(true);
  expect(formatLintReport(report).exitCode).toBe(1);
});

test("lint: no tracker gateway created (context laziness preserved)", async () => {
  // An unregistered provider → construction THROWS. A lint that runs without error
  // mechanically proves no `{ ...context }` read the `workItem` getter on this path.
  // This test fails if the spread returns.
  const base = buildPipelineContext({ ...commandRegistries(), cwd: runnerDir, runnerDir, ticket: "LINT-0" });
  const ctx = buildPipelineContext({
    ...commandRegistries(),
    cwd: runnerDir,
    runnerDir,
    ticket: "LINT-0",
    config: {
      ...base.config,
      steps: {},
      workItem: { ...base.config.workItem, provider: "provider-qui-nexiste-pas" as never },
    },
  });
  const report = await lintStepOverrides(ctx);
  expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
  expect(() => ctx.workItem).toThrow(/provider-qui-nexiste-pas/);
});

/** Temporary project with one pipeline in `.lance-nuit/pipelines/`. `PIPELINE_HOME`
 *  is redirected so the machine's `~/.lance-nuit` cannot affect linting. */
function projectWithPipeline(name: string, source: string): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-lint-"));
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${name}.ts`), source);
  const previousHome = process.env.PIPELINE_HOME;
  process.env.PIPELINE_HOME = join(cwd, "empty-home");
  return {
    cwd,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.PIPELINE_HOME;
      else process.env.PIPELINE_HOME = previousHome;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const DEMO_PIPELINE = `export default ({ pipeline, bashStep }) =>
  pipeline("demo").add(bashStep({ id: "verifier", name: "Check", command: "true" })).build();
`;

test("lint: a legitimate override appears as config source", async () => {
  const project = projectWithPipeline(
    "agent",
    `export default ({ pipeline, llmStep }) => pipeline("agent").add(
  llmStep({ id: "review", name: "Review", backend: "claude", profile: "reviewer", command: "review" })
).build();\n`,
  );
  try {
    const base = buildPipelineContext({ ...commandRegistries(), cwd: project.cwd, runnerDir, ticket: "LINT-0" });
    const report = await lintStepOverrides(
      deriveContext(base, {
        config: { ...base.config, steps: parseStepOverrides({ "agent:review": { model: "sonnet" } }) },
      }),
    );
    const row = report.effective.find((r) => r.pipeline === "agent" && r.stepId === "review");
    expect(row).toMatchObject({ model: "sonnet", source: "config" });
    expect(formatLintReport(report).exitCode).toBe(0);
  } finally {
    project.cleanup();
  }
});

test("lint: a project pipeline is linted like builtins", async () => {
  // Lint used to read only `runner/pipelines/`: a project pipeline was therefore
  // NEVER examined, and the final `✓ coherent` covered a set that excluded it —
  // the opposite of what an author sees.
  const project = projectWithPipeline("demo", DEMO_PIPELINE);
  try {
    const base = buildPipelineContext({ ...commandRegistries(), cwd: project.cwd, runnerDir, ticket: "LINT-0" });
    const report = await lintStepOverrides(base);
    expect(report.findings.some((f) => /demo/.test(f.message) && f.level === "error")).toBe(false);
    expect(report.effective.some((row) => row.pipeline === "demo")).toBe(false); // no agent step
    // Proof that "demo" was loaded: a key targeting it is no longer rejected as
    // an “unknown pipeline”, but judged against its step.
    const targeted = await lintStepOverrides(
      deriveContext(base, {
        config: { ...base.config, steps: parseStepOverrides({ "demo:verifier": { model: "sonnet" } }) },
      }),
    );
    const errors = targeted.findings.filter((f) => f.level === "error").map((f) => f.message);
    expect(errors.some((m) => /unknown pipeline "demo"/.test(m))).toBe(false);
    expect(errors.some((m) => /"demo:verifier"\] targets a bash step/.test(m))).toBe(true);
  } finally {
    project.cleanup();
  }
});

test("lint: a project pipeline shadows a builtin with the same name", async () => {
  // Same priority as a run (`resolveBuiltinPipeline`): otherwise lint would
  // judge config against a definition nobody executes.
  const project = projectWithPipeline(
    "bugfix",
    `export default ({ pipeline, bashStep }) =>
  pipeline("bugfix").add(bashStep({ id: "seul-step", name: "Seul", command: "true" })).build();
`,
  );
  try {
    const base = buildPipelineContext({ ...commandRegistries(), cwd: project.cwd, runnerDir, ticket: "LINT-0" });
    const report = await lintStepOverrides(
      deriveContext(base, {
        config: { ...base.config, steps: parseStepOverrides({ "bugfix:fix-standard": { model: "sonnet" } }) },
      }),
    );
    // `fix-standard` exists in the builtin, not in the project homonym: this is
    // the one from the loaded project.
    const errors = report.findings.filter((f) => f.level === "error").map((f) => f.message);
    expect(errors.some((m) => /"bugfix:fix-standard"\] does not match any step in "bugfix"/.test(m))).toBe(true);
    expect(report.effective.some((row) => row.pipeline === "bugfix")).toBe(false);
  } finally {
    project.cleanup();
  }
});

test("lint: a project pipeline profile is visible", async () => {
  const project = projectWithPipeline(
    "agent-profile",
    `export default ({ pipeline, llmStep }) => pipeline("agent-profile").add(
  llmStep({ id: "implement", name: "Implement", backend: "claude", profile: "coder", command: "implement" })
).build();\n`,
  );
  try {
    const base = buildPipelineContext({ ...commandRegistries(), cwd: project.cwd, runnerDir, ticket: "LINT-0" });
    const report = await lintStepOverrides(
      deriveContext(base, {
        config: {
          ...base.config,
          profiles: parseProfileOverrides({
            coder: { backends: { claude: { model: "opus[1m]" } } },
            operator: { backends: { claude: { model: "opus" } } },
          }),
        },
      }),
    );
    const row = report.effective.find((r) => r.pipeline === "agent-profile" && r.stepId === "implement");
    expect(row).toMatchObject({ profile: "coder", model: "opus[1m]", source: "profile" });
    expect(report.findings.some((f) => /profiles\["operator"\] is not used by any step/.test(f.message))).toBe(true);
  } finally {
    project.cleanup();
  }
});

test("lint: the three registered backends are linted in one pipeline", async () => {
  // A third provider must not shift the report: model and effort are read from
  // each backend's own role policy, and the axes it declares.
  const project = projectWithPipeline(
    "trois-backends",
    `export default ({ pipeline, llmStep }) => pipeline("trois-backends")
  .add(llmStep({ id: "review", name: "Review", backend: "claude", profile: "reviewer", command: "review" }))
  .add(llmStep({ id: "implement", name: "Implement", backend: "codex", profile: "coder", command: "implement" }))
  .add(llmStep({ id: "sort", name: "Sort", backend: "opencode", profile: "triage", command: "sort" }))
  .build();\n`,
  );
  try {
    const base = buildPipelineContext({ ...commandRegistries(), cwd: project.cwd, runnerDir, ticket: "LINT-0" });
    const report = await lintStepOverrides(
      deriveContext(base, {
        config: { ...base.config, steps: parseStepOverrides({ "trois-backends:sort": { model: "opencode/other" } }) },
      }),
    );
    const row = (stepId: string) =>
      report.effective.find((r) => r.pipeline === "trois-backends" && r.stepId === stepId);
    expect(row("review")).toMatchObject({ profile: "reviewer", model: "opus", effort: "medium" });
    expect(row("implement")).toMatchObject({ profile: "coder", model: "gpt-5.6-luna", effort: "medium" });
    // opencode declares the `model` and `effort` axes, so the override applies
    // instead of being reported as unsupported.
    expect(row("sort")).toMatchObject({ profile: "triage", model: "opencode/other", source: "config" });
    expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
    const rendered = formatLintReport(report);
    expect(rendered.exitCode).toBe(0);
    // A provider-qualified model name is longer than the historical fixed column,
    // and must not push the `@profile` column out of alignment.
    const columns = rendered.text
      .split("\n")
      .filter((line) => line.includes("@"))
      .map((line) => line.indexOf("@"));
    expect(new Set(columns).size).toBe(1);
  } finally {
    project.cleanup();
  }
});
