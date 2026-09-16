import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipelineConfig } from "../env/config.js";
import { executeStep } from "../exec/runners.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { createProjectDsl, validatePipeline } from "../pipeline/loader.js";
import { parseRunnerArgs } from "../cli/parse.js";
import { makeRunStep } from "../state/run-step.js";
import { createDefaultRunnerRegistries } from "../entry/registries.js";
import { configStep } from "./config.js";
import { loadRunnerRegistries } from "./extensions.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-extensions-"));
}

function writeModule(root: string, name: string, source: string): string {
  const path = join(root, `${name}.ts`);
  writeFileSync(path, source, "utf8");
  return path;
}

describe("explicit runner extensions", () => {
  test("loads a local work-item factory without constructing it", async () => {
    const root = project();
    const modulePath = writeModule(
      root,
      "extensions",
      `export default {
        workItems: [{ id: "redmine", create() { throw new Error("factory constructed"); } }]
      };`,
    );

    const registries = await loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root);
    expect(registries.workItems.known()).toContain("redmine");
    expect(() =>
      registries.workItems.resolve({
        workItem: { provider: "redmine", project: "", todoState: "New", reviewState: "Review" },
        labels: { bugTodo: "bug", featureTodo: "feature", done: "done", escalate: "escalate" },
      }),
    ).toThrow(/factory constructed/);
  });

  test("resolves a package-like specifier from the project", async () => {
    const root = project();
    const packageRoot = join(root, "node_modules", "@acme", "pipeline-redmine");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@acme/pipeline-redmine", type: "module", exports: "./index.mjs" }),
      "utf8",
    );
    writeFileSync(
      join(packageRoot, "index.mjs"),
      `export default { workItems: [{ id: "redmine", create: () => ({ provider: "redmine" }) }] };`,
      "utf8",
    );

    const registries = await loadRunnerRegistries("@acme/pipeline-redmine", createDefaultRunnerRegistries(), root);
    expect(registries.workItems.known()).toContain("redmine");
  });

  test("package-like manifest can register a work-item factory", async () => {
    const root = mkdtempSync(join(process.cwd(), ".extensions-test-"));
    try {
      const packageRoot = join(root, "node_modules", "@acme", "jira-manifest");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "@acme/jira-manifest", type: "module", exports: "./index.mjs" }),
        "utf8",
      );
      writeFileSync(
        join(packageRoot, "index.mjs"),
        `export default { workItems: [{ id: "package-work-item", create: () => ({ provider: "package-work-item" }) }] };`,
        "utf8",
      );
      const registries = await loadRunnerRegistries("@acme/jira-manifest", createDefaultRunnerRegistries(), root);
      expect(registries.workItems.has("package-work-item")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed manifests", async () => {
    const root = project();
    const modulePath = writeModule(root, "bad", `export default { workItems: "redmine" };`);
    await expect(loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root)).rejects.toThrow(
      /workItems must be an array/,
    );
  });

  test("rejects duplicate built-in registrations", async () => {
    const root = project();
    const modulePath = writeModule(
      root,
      "duplicate",
      `export default { workItems: [{ id: "jira", create: () => ({ provider: "jira" }) }] };`,
    );
    await expect(loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root)).rejects.toThrow(
      /already registered/,
    );
  });

  test("accepts a manifest written with defineExtension", async () => {
    const root = project();
    const contracts = join(process.cwd(), "src", "contracts", "extensions.ts");
    const modulePath = writeModule(
      root,
      "extensions",
      `import { defineExtension } from ${JSON.stringify(contracts)};
      export default defineExtension({
        workItems: [{ id: "redmine", create: () => ({ provider: "redmine" }) }]
      });`,
    );

    const registries = await loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root);
    expect(registries.workItems.known()).toContain("redmine");
  });

  test("rejects a manifest key outside the public contract", async () => {
    const root = project();
    const modulePath = writeModule(root, "extensions", `export default { cliOptions: [] };`);

    await expect(loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root)).rejects.toThrow(
      /unknown key\(s\): cliOptions/,
    );
  });

  test("refuses to shadow a provider the base registries already know", async () => {
    const root = project();
    const modulePath = writeModule(
      root,
      "extensions",
      `export default { workItems: [{ id: "jira", create: () => ({ provider: "jira" }) }] };`,
    );

    await expect(loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root)).rejects.toThrow(
      /"jira" is already registered/,
    );
  });

  test("keeps unknown providers explicit instead of falling back", async () => {
    const registries = await loadRunnerRegistries(undefined, createDefaultRunnerRegistries(), project());
    expect(() =>
      registries.workItems.resolve({
        workItem: { provider: "redmine", project: "", todoState: "New", reviewState: "Review" },
        labels: { bugTodo: "bug", featureTodo: "feature", done: "done", escalate: "escalate" },
      }),
    ).toThrow(/redmine/);
  });

  test("config boot loads and injects the explicit registries", async () => {
    const root = project();
    mkdirSync(join(root, ".lance-nuit"), { recursive: true });
    writeFileSync(
      join(root, ".lance-nuit", "config.json"),
      JSON.stringify({ extensions: { module: "./extensions.ts" }, workItem: { provider: "redmine" } }),
      "utf8",
    );
    writeModule(
      root,
      "extensions",
      `export default { workItems: [{ id: "redmine", create: () => ({ provider: "redmine" }) }] };`,
    );

    const state = await configStep.run({
      cwd: root,
      args: parseRunnerArgs([]),
      worktreeMode: false,
      baseRegistries: createDefaultRunnerRegistries(),
    });
    expect(state.registries?.workItems.known()).toContain("redmine");
    expect(state.context?.workItem.provider).toBe("redmine");
    expect(state.registries?.backends.known()).toEqual(["claude", "codex", "opencode"]);
  });

  test("an extension inside the kit imports lance-nuit/contracts without any local install", async () => {
    // No node_modules anywhere above the project: the contracts can only come
    // from the package the runner vendors into the kit itself.
    const root = project();
    const kit = join(root, ".lance-nuit");
    mkdirSync(kit, { recursive: true });
    writeFileSync(
      join(kit, "config.json"),
      JSON.stringify({ extensions: { module: "./.lance-nuit/extensions.mjs" }, workItem: { provider: "redmine" } }),
      "utf8",
    );
    writeFileSync(
      join(kit, "extensions.mjs"),
      `import { defineExtension } from "lance-nuit/contracts";
       export default defineExtension({ workItems: [{ id: "redmine", create: () => ({ provider: "redmine" }) }] });`,
      "utf8",
    );

    const state = await configStep.run({
      cwd: root,
      args: parseRunnerArgs([]),
      worktreeMode: false,
      baseRegistries: createDefaultRunnerRegistries(),
    });
    expect(state.registries?.workItems.known()).toContain("redmine");
    const manifestPath = join(kit, "node_modules", "lance-nuit", "package.json");
    expect(existsSync(manifestPath)).toBe(true);

    // A CLI update leaves a stale copy behind: boot rewrites it before importing.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, lanceNuitContracts: { sourceHash: "stale" } }));
    await configStep.run({
      cwd: root,
      args: parseRunnerArgs([]),
      worktreeMode: false,
      baseRegistries: createDefaultRunnerRegistries(),
    });
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).lanceNuitContracts.sourceHash).toBe(
      manifest.lanceNuitContracts.sourceHash,
    );
  });

  test("an extension outside every kit leaves the kit untouched", async () => {
    const root = project();
    mkdirSync(join(root, ".lance-nuit"), { recursive: true });
    writeFileSync(
      join(root, ".lance-nuit", "config.json"),
      JSON.stringify({ extensions: { module: "./extensions.ts" }, workItem: { provider: "redmine" } }),
      "utf8",
    );
    writeModule(
      root,
      "extensions",
      `export default { workItems: [{ id: "redmine", create: () => ({ provider: "redmine" }) }] };`,
    );
    await configStep.run({
      cwd: root,
      args: parseRunnerArgs([]),
      worktreeMode: false,
      baseRegistries: createDefaultRunnerRegistries(),
    });
    expect(existsSync(join(root, ".lance-nuit", "node_modules"))).toBe(false);
  });

  test("an external backend is used by injected DSL, validation, and execution", async () => {
    const root = project();
    mkdirSync(join(root, ".lance-nuit"), { recursive: true });
    writeFileSync(
      join(root, ".lance-nuit", "config.json"),
      JSON.stringify({
        profiles: { coder: { backends: { "local-e2e": { effort: "medium" } } } },
      }),
      "utf8",
    );
    const modulePath = writeModule(
      root,
      "backend-extension",
      `export default { backends: [{
        id: "local-e2e",
        capabilities: { structuredOutput: true, streaming: false, resume: false, usageTokens: false, cost: "none", configurationAxes: ["effort"] },
        normalizeAuthorOptions: (options) => options,
        create() {
          return {
            id: "local-e2e",
            capabilities: this.capabilities,
            async run(request) {
              return { provider: "local-e2e", output: request.prompt, ok: true, stats: { duration_ms: 1 } };
            }
          };
        }
      }] };`,
    );

    const registries = await loadRunnerRegistries(modulePath, createDefaultRunnerRegistries(), root);
    const config = loadPipelineConfig(root);
    const context = buildPipelineContext({
      cwd: root,
      runnerDir: root,
      ticket: "EXT-1",
      config,
      agentBackendRegistry: registries.backends,
    });
    const dsl = createProjectDsl(context, root);
    const builder = (dsl.llmStep as unknown as (options: Record<string, unknown>) => any)({
      id: "external",
      name: "External backend",
      profile: "coder",
      backend: "local-e2e",
      command: "hello extension",
    });
    const step = builder.build();
    const pipeline = dsl.pipeline("extension").add(builder).build();
    validatePipeline(pipeline, "extension.ts", {
      profileOverrides: config.profiles,
      context,
    });

    const result = await executeStep(makeRunStep(step), "hello extension", {}, context);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello extension");
  });
});
