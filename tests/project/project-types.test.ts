import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { loadPipelineDefinition } from "../../src/pipeline/loader.js";
import { installProjectTypes, projectTypesDirectory, typecheckProjectPipelines } from "../../src/project/dsl-types.js";
import { commandRegistries } from "../../src/commands/registries.js";

const RUNNER_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Declaration-generation tests invoke TypeScript programs repeatedly. They can
// legitimately exceed Bun's 5-second default when the full suite runs at once.
setDefaultTimeout(15_000);

function project(): string {
  return mkdtempSync(join(tmpdir(), "project-pipeline-types-"));
}

function writePipeline(root: string, source: string): void {
  const dir = join(root, ".lance-nuit", "pipelines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "demo.ts"), source);
}

function readmePipeline(): string {
  const readme = readFileSync(join(RUNNER_DIR, "README.md"), "utf8");
  const match = readme.match(
    /<!-- project-pipeline-example:start -->\s*```ts\n([\s\S]*?)\n```\s*<!-- project-pipeline-example:end -->/,
  );
  if (!match?.[1]) throw new Error("Project pipeline example missing from README");
  return match[1];
}

function nightlyTicketsExample(): string {
  return readFileSync(join(RUNNER_DIR, "examples", "nightly-tickets", "pipeline.ts"), "utf8");
}

test("DSL installation: relative declarations and idempotent reinstall", () => {
  const root = project();
  installProjectTypes(root);
  const typesDir = projectTypesDirectory(root);
  const first = readdirSync(typesDir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => statSync(join(typesDir, entry)).isFile())
    .sort()
    .map((entry) => `${entry}\0${readFileSync(join(typesDir, entry), "utf8")}`)
    .join("\n");

  installProjectTypes(root);
  const second = readdirSync(typesDir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => statSync(join(typesDir, entry)).isFile())
    .sort()
    .map((entry) => `${entry}\0${readFileSync(join(typesDir, entry), "utf8")}`)
    .join("\n");

  expect(second).toBe(first);
  expect(existsSync(join(root, ".lance-nuit", "tsconfig.json"))).toBe(true);
  expect(first).toContain("project/dsl.d.ts");
  expect(readFileSync(join(typesDir, "package.json"), "utf8")).toContain('"types": "./project/dsl.d.ts"');
  expect(first).not.toMatch(/\/home\/|\.claude\/plugins\/cache/);
});

test("DSL installation: only the public declaration graph is installed", () => {
  const root = project();
  installProjectTypes(root);
  const typesDir = projectTypesDirectory(root);
  const installed = readdirSync(typesDir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".d.ts"))
    .map((entry) => entry.split(sep).join("/"));

  expect(installed).toContain("project/dsl.d.ts");
  // Specialized in place after the copy: pruning must never drop it.
  expect(installed).toContain("dsl/profiles.d.ts");

  // Runtime-only subsystems: reachable in the compiled program, absent from the
  // declaration graph. Installing them shipped the runner's internals to every
  // consuming project.
  for (const internal of ["boot/", "dispatch/", "output/", "commands/", "step/", "exec/", "validation/", "runner"]) {
    expect(installed.filter((entry) => entry.startsWith(internal))).toEqual([]);
  }
});

test("project typecheck: valid factory accepted", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, artifact, bashStep, workItemEscalateStep }: Dsl) => {
      const triage = artifact("triage.json", (value: unknown) => ({
        verdict: "escalate" as const,
        reason: String(value),
      }));
      return pipeline("project")
        .forEachWorkItem({
          queue: "featureTodo",
          scan: { limit: 3 },
          before: [bashStep({ id: "preflight", name: "Preflight", command: "true" })],
          load: { retries: 1 },
          do: [workItemEscalateStep({
            id: "review-triage",
            artifact: triage,
            onlyIf: value => value.verdict === "escalate",
            escalation: value => ({ cause: value.reason, state: "no code", action: "review" }),
          })],
        })
        .build();
    };
  `,
  );
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });
});

test("project typecheck: public Claude options are camelCase", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("camel-case")
      .add(llmStep({ id: "review", name: "Review", backend: "claude", profile: "reviewer", options: {
        systemPrompt: "Analyse.",
        strictMcp: true,
        allowedTools: ["Read"],
      }, command: "review" }))
      .build();
  `,
  );

  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });
});

test("project typecheck: backend × profile = builtin union project overrides", () => {
  const configuredRoot = project();
  const kitDir = join(configuredRoot, ".lance-nuit");
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(
    join(kitDir, "config.json"),
    JSON.stringify({
      profiles: { planner: { backends: { codex: { model: "gpt-project", effort: "high" } } } },
    }),
  );
  installProjectTypes(configuredRoot);
  writePipeline(
    configuredRoot,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("configured-backend")
      .add(llmStep({
        id: "plan",
        name: "Plan",
        profile: "planner",
        backend: "codex",
        options: { sandbox: "read-only" },
        command: "plan",
      }))
      .build();
  `,
  );
  expect(typecheckProjectPipelines(configuredRoot)).toMatchObject({ ok: true });
  expect(readFileSync(join(projectTypesDirectory(configuredRoot), "dsl", "profiles.d.ts"), "utf8")).toContain(
    'readonly "codex": true',
  );

  const builtinOnlyRoot = project();
  installProjectTypes(builtinOnlyRoot);
  writePipeline(
    builtinOnlyRoot,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("invalid-backend")
      .add(llmStep({
        id: "plan",
        name: "Plan",
        profile: "planner",
        backend: "codex",
        command: "plan",
      }))
      .build();
  `,
  );
  const invalid = typecheckProjectPipelines(builtinOnlyRoot);
  expect(invalid.ok).toBe(false);
  expect(invalid.output).toMatch(/codex|BackendFor/);
});

test("project typecheck: a third backend reaches ProjectProfileBackends", async () => {
  // The injection is generic over provider names, but nothing proved it beyond
  // the two builtin providers: a third one must land in the same interface.
  const root = project();
  const kitDir = join(root, ".lance-nuit");
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(
    join(kitDir, "config.json"),
    JSON.stringify({
      profiles: {
        planner: {
          backends: {
            codex: { model: "gpt-project", effort: "high" },
            opencode: { model: "opencode/nemotron-3-ultra-free", effort: "medium" },
          },
        },
      },
    }),
  );
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("trois-backends")
      .add(llmStep({ id: "plan", name: "Plan", profile: "planner", backend: "opencode", command: "plan" }))
      .add(llmStep({ id: "sort", name: "Sort", profile: "triage", backend: "opencode", command: "sort" }))
      .build();
  `,
  );
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });
  const declaration = readFileSync(join(projectTypesDirectory(root), "dsl", "profiles.d.ts"), "utf8");
  expect(declaration).toContain('readonly "codex": true');
  expect(declaration).toContain('readonly "opencode": true');
});

test("project typecheck: removed profile override invalidates installed declarations", () => {
  const root = project();
  const configPath = join(root, ".lance-nuit", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      profiles: { planner: { backends: { codex: { model: "gpt-project", effort: "high" } } } },
    }),
  );
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("configured-backend")
      .add(llmStep({ id: "plan", name: "Plan", profile: "planner", backend: "codex", command: "plan" }))
      .build();
  `,
  );
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });

  // Public sources did not change: only a hash covering the config can detect that
  // dsl/profiles.d.ts no longer describes the project's configuration.
  writeFileSync(configPath, JSON.stringify({ profiles: {} }));
  const stale = typecheckProjectPipelines(root);
  expect(stale.ok).toBe(false);
  expect(stale.output).toContain("stale DSL declarations");

  installProjectTypes(root);
  expect(typecheckProjectPipelines(root).ok).toBe(false);
});

test("project typecheck: Claude snake_case options are rejected", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("snake-case")
      .add(llmStep({ id: "review", name: "Review", backend: "claude", profile: "reviewer", options: { strict_mcp: true }, command: "review" }))
      .build();
  `,
  );

  const result = typecheckProjectPipelines(root);
  expect(result.ok).toBe(false);
  expect(result.output).toContain("strict_mcp");
});

test("project typecheck: scan does not carry the work-item queue", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline }: Dsl) => pipeline("scan-queue")
      .forEachWorkItem({
        queue: "featureTodo",
        scan: { queue: "featureTodo" },
        do: [],
      })
      .build();
  `,
  );

  const result = typecheckProjectPipelines(root);
  expect(result.ok).toBe(false);
  expect(result.output).toContain("queue");
});

test("public surface: internal runner primitives are hidden", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import { workItemSourceStep } from "@lance-nuit/dsl";
    import type { ExecutionKey, MoveTarget, PipelineStep } from "@lance-nuit/dsl";
    void workItemSourceStep;
    const key: ExecutionKey = { ticket: "X", stepId: "Y" };
    const move: MoveTarget = {};
    const step: PipelineStep = move as never;
    void key; void step;
    export default ({ pipeline }: import("@lance-nuit/dsl").Dsl) => pipeline("hidden").add([]).build();
  `,
  );
  const result = typecheckProjectPipelines(root);
  expect(result.ok).toBe(false);
  // Each primitive must be hidden on its own: a single leak has to fail here.
  expect(result.output).toContain("workItemSourceStep");
  expect(result.output).toContain("ExecutionKey");
  expect(result.output).toContain("MoveTarget");
  expect(result.output).toContain("PipelineStep");
});

test("public surface: CodexSandbox remains a literal union", () => {
  const validRoot = project();
  installProjectTypes(validRoot);
  writePipeline(
    validRoot,
    `
    import type { CodexSandbox, Dsl } from "@lance-nuit/dsl";
    const sandbox: CodexSandbox = "workspace-write";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("sandbox")
      .add(llmStep({ id: "step", name: "Step", backend: "codex", profile: "coder", options: { sandbox }, command: "true" }))
      .build();
  `,
  );
  expect(typecheckProjectPipelines(validRoot)).toMatchObject({ ok: true });

  const invalidRoot = project();
  installProjectTypes(invalidRoot);
  writePipeline(
    invalidRoot,
    `
    import type { CodexSandbox, Dsl } from "@lance-nuit/dsl";
    const sandbox: CodexSandbox = "unsafe";
    export default ({ pipeline, llmStep }: Dsl) => pipeline("sandbox").add(
      llmStep({ id: "step", name: "Step", backend: "codex", profile: "coder", options: { sandbox }, command: "true" }),
    ).build();
  `,
  );
  expect(typecheckProjectPipelines(invalidRoot).ok).toBe(false);
});

test("public surface: add and forEachWorkItem modes are mutually exclusive through the types", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, bashStep }: Dsl) => pipeline("mixed")
      .add(bashStep({ id: "one", name: "One", command: "true" }))
      .forEachWorkItem({ queue: "featureTodo", do: [] })
      .build();
  `,
  );
  const result = typecheckProjectPipelines(root);
  expect(result.ok).toBe(false);
  expect(result.output).toContain("not callable");
});

test("public surface: composition and work-item budget are typed", () => {
  const validRoot = project();
  installProjectTypes(validRoot);
  writePipeline(
    validRoot,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, forEachPipeline, bashStep }: Dsl) => pipeline("composition")
      .forEachWorkItem({
        queue: "featureTodo",
        maxCostPerWorkItemUsd: 4,
        do: [forEachPipeline({
          id: "children",
          name: "Children",
          items: ctx => [ctx.ticket ?? "CHILD"],
          pipeline: "default",
          afterEach: { pipeline: "commit", when: () => true },
          afterAll: { pipeline: "finalize", ticket: ctx => ctx.ticket },
        })],
      })
      .build();
  `,
  );
  expect(typecheckProjectPipelines(validRoot)).toMatchObject({ ok: true });

  const injectedHelpersRoot = project();
  installProjectTypes(injectedHelpersRoot);
  writePipeline(
    injectedHelpersRoot,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, runPipeline, forEachPipeline }: Dsl) => pipeline("composition")
      .add(
        runPipeline({ id: "once", name: "Once", pipeline: "default" }),
        forEachPipeline({ id: "many", name: "Many", items: ["P-1"], pipeline: "default" }),
      )
      .build();
  `,
  );
  expect(typecheckProjectPipelines(injectedHelpersRoot)).toMatchObject({ ok: true });

  const invalidRoot = project();
  installProjectTypes(invalidRoot);
  writePipeline(
    invalidRoot,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, bashStep }: Dsl) => pipeline("invalid-budget")
      .maxCost(4)
      .forEachWorkItem({ queue: "featureTodo", do: [bashStep({ id: "x", name: "X", command: "true" })] })
      .build();
  `,
  );
  const result = typecheckProjectPipelines(invalidRoot);
  expect(result.ok).toBe(false);
  expect(result.output).toContain("not callable");
});

test("DSL documentation: README example typechecks and loads", async () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(root, readmePipeline());
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });

  const definition = await loadPipelineDefinition(
    join(root, ".lance-nuit", "pipelines", "demo.ts"),
    buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "PROJ-42" }),
  );
  expect(definition.name).toBe("nightly");
  expect(definition.steps.map((step) => step.id)).toEqual(["implement", "test", "review"]);
});

test("DSL documentation: nightly ticket loop example typechecks and loads", async () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(root, nightlyTicketsExample());
  const prompts = join(root, ".lance-nuit", "pipelines", "prompts");
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, "triage.md"), "Analyze ticket {{ticket}} and write triage.json into {{artifactsDir}}.\n");

  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });

  const definition = await loadPipelineDefinition(
    join(root, ".lance-nuit", "pipelines", "demo.ts"),
    buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "PROJ-42" }),
  );
  expect(definition.name).toBe("nightly");
  expect(definition.steps.map((step) => step.id)).toEqual([
    "ticket",
    "branch",
    "implement",
    "test",
    "commit",
    "review",
    "hand-over",
  ]);
});

test("DSL documentation: composition helpers are shown in their injected form", () => {
  const readme = readFileSync(join(RUNNER_DIR, "README.md"), "utf8");
  expect(readme).toContain("Composition helpers are injected into the DSL:");
  expect(readme).toContain("forEachPipeline({ id, name, items, pipeline, when?, afterEach?, afterAll? });");
  expect(readme).not.toContain("`.runPipeline(");
  expect(readme).not.toContain("`.forEachPipeline(");
  expect(readme).toContain("Composition helpers are injected into");
});

test("project typecheck: escalation errors and artifact properties rejected", () => {
  const root = project();
  installProjectTypes(root);
  writePipeline(
    root,
    `
    import type { Dsl } from "@lance-nuit/dsl";
    export default ({ pipeline, artifact, workItemEscalateStep }: Dsl) => {
      const triage = artifact("triage.json", () => ({ verdict: "escalate" as const, reason: "x" }));
      return pipeline("broken").add(workItemEscalateStep({
        artifact: triage,
        escalation: value => ({ cause: value.unknown, state: "no code" }),
        note: () => ({ headline: "note", fields: [] }),
      })).build();
    };
  `,
  );
  const result = typecheckProjectPipelines(root);
  expect(result.ok).toBe(false);
  expect(result.output).toContain(".lance-nuit/pipelines/demo.ts");
  expect(result.output).toMatch(/unknown|note|action/);
});
