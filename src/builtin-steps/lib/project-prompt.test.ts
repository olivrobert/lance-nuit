import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../../pipeline/context.js";
import { createProjectDsl, loadPipelineDefinition } from "../../pipeline/loader.js";
import { createPromptFile } from "./project-prompt.js";
import { commandRegistries } from "../../commands/registries.js";

function folder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("promptFile: resolves relative to pipeline, independent of cwd", () => {
  const root = folder("project-prompt-");
  const prompts = join(root, "prompts");
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, "triage.md"), "Ticket: {{ticket}}\nArtifacts: {{artifactsDir}}\n");

  const render = createPromptFile(root)("./prompts/triage.md", ["ticket", "artifactsDir"] as const);
  expect(render({ ticket: "PROJ-1", artifactsDir: "/tmp/artifacts" })).toBe(
    "Ticket: PROJ-1\nArtifacts: /tmp/artifacts",
  );
});

test("promptFile: loader binds base to pipeline file", async () => {
  const root = folder("project-prompt-loader-");
  const pipelineDir = join(root, ".lance-nuit", "pipelines");
  mkdirSync(join(pipelineDir, "prompts"), { recursive: true });
  writeFileSync(join(pipelineDir, "prompts", "triage.md"), "Ticket {{ticket}}");
  const pipelinePath = join(pipelineDir, "demo.ts");
  writeFileSync(
    pipelinePath,
    `
    export default ({ pipeline, bashStep, promptFile }) => {
      const prompt = promptFile("./prompts/triage.md", ["ticket"] as const);
      return pipeline("project").add(
        bashStep({
          id: "prompt",
          name: "Prompt",
          command: ctx => prompt({ ticket: ctx.ticket ?? "?" }),
        }),
      ).build();
    };
  `,
  );

  const definition = await loadPipelineDefinition(
    pipelinePath,
    buildPipelineContext({ ...commandRegistries(), cwd: root }),
  );
  const command = definition.steps[0]!.command;
  expect(
    typeof command === "function"
      ? command({ ...buildPipelineContext({ ...commandRegistries(), cwd: root }), ticket: "PROJ-2" })
      : command,
  ).toBe("Ticket PROJ-2");
});

test("llmStep.prompt: path relative to loaded pipeline", () => {
  const root = folder("project-prompt-short-");
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "implement.md"), "Implement the ticket.");

  const dsl = createProjectDsl(buildPipelineContext({ ...commandRegistries(), cwd: root }), root);
  const command = dsl
    .llmStep({
      id: "implement",
      name: "Implement",
      profile: "coder",
      backend: "claude",
      prompt: "./prompts/implement.md",
    })
    .build().command;
  expect(command).toBe("Implement the ticket.");
});

test("project DSL: ordinary steps keep their own context", () => {
  const first = buildPipelineContext(commandRegistries());
  const second = buildPipelineContext(commandRegistries());

  const firstDsl = createProjectDsl(first, "/tmp/project-one/.lance-nuit/pipelines");
  const secondDsl = createProjectDsl(second, "/tmp/project-two/.lance-nuit/pipelines");

  const firstCommand = firstDsl.bashStep({ id: "first", name: "First", command: "echo first" }).build().command;
  const secondCommand = secondDsl.bashStep({ id: "second", name: "Second", command: "echo second" }).build().command;
  expect(typeof firstCommand === "function" ? firstCommand(first) : firstCommand).toBe("echo first");
  expect(typeof secondCommand === "function" ? secondCommand(second) : secondCommand).toBe("echo second");
  const firstCommandAgain = firstDsl.bashStep({ id: "first", name: "First", command: "echo first" }).build().command;
  expect(typeof firstCommandAgain === "function" ? firstCommandAgain(first) : firstCommandAgain).toBe("echo first");
});

test("promptFile: missing file, unknown placeholder, and unused key cite project file", () => {
  const root = folder("project-prompt-errors-");
  const prompts = join(root, "prompts");
  mkdirSync(prompts, { recursive: true });
  const file = join(prompts, "broken.md");
  writeFileSync(file, "{{ticket}} {{unknown}}");

  expect(() => createPromptFile(root)("./prompts/missing.md", ["ticket"] as const)).toThrow(/missing\.md/);
  expect(() => createPromptFile(root)("./prompts/broken.md", ["ticket"] as const)).toThrow(/unknown|undeclared/);
  writeFileSync(file, "{{ticket}}");
  expect(() => createPromptFile(root)("./prompts/broken.md", ["ticket", "unused"] as const)).toThrow(/unused|missing/);
});
