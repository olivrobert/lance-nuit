import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerArgs } from "../model/cli-options.ts";
import { pipelinePathStep } from "./pipeline-path.ts";
import type { BootState } from "./boot-state.ts";
import { createDefaultRunnerRegistries } from "../entry/registries.js";

const originalHome = process.env.PIPELINE_HOME;
const originalExit = process.exit;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  process.exit = originalExit;
});

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `boot-pipeline-path-${prefix}-`));
}

function writePipeline(kitDir: string, name: string): string {
  const target = join(kitDir, "pipelines", `${name}.ts`);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "export default () => ({});\n");
  return target;
}

function state(cwd: string, pipelinePath?: string): BootState {
  return {
    args: {} as RunnerArgs,
    cwd,
    worktreeMode: false,
    baseRegistries: createDefaultRunnerRegistries(),
    ...(pipelinePath === undefined ? {} : { pipelinePath }),
  };
}

test("applies: names are resolved, paths are not", () => {
  const cwd = dir("applies");
  expect(pipelinePathStep.applies(state(cwd))).toBe(true);
  expect(pipelinePathStep.applies(state(cwd, "deploy"))).toBe(true);
  expect(pipelinePathStep.applies(state(cwd, "deploy-staging"))).toBe(true);

  // Anything with a separator, extension, or uppercase letter is a path.
  for (const path of ["./deploy.ts", "deploy.ts", "/abs/deploy.ts", "a/b.ts", "Deploy", ".lance-nuit/pipelines/x.ts"]) {
    expect(pipelinePathStep.applies(state(cwd, path))).toBe(false);
  }
});

test("run: bare name resolves in the project's .lance-nuit", () => {
  process.env.PIPELINE_HOME = dir("home");
  const cwd = dir("project");
  const target = writePipeline(join(cwd, ".lance-nuit"), "deploy");
  expect(pipelinePathStep.run(state(cwd, "deploy"))).toEqual({ pipelinePath: target });
});

test("run: bare name falls back to the shared pipeline", () => {
  const home = dir("home");
  process.env.PIPELINE_HOME = home;
  const target = writePipeline(home, "deploy");
  expect(pipelinePathStep.run(state(dir("project"), "deploy"))).toEqual({ pipelinePath: target });
});

// Use the STATE cwd, not process.cwd(): after a worktree chdir, the worktree owns
// the .lance-nuit/ to inspect.
test("run: resolution follows state cwd, not process cwd", () => {
  process.env.PIPELINE_HOME = dir("home");
  const worktree = dir("worktree");
  const target = writePipeline(join(worktree, ".lance-nuit"), "deploy");
  expect(pipelinePathStep.run(state(worktree, "deploy"))).toEqual({ pipelinePath: target });
});

test("run: missing --pipeline resolves the `default` pipeline", () => {
  process.env.PIPELINE_HOME = dir("home");
  const cwd = dir("project");
  const target = writePipeline(join(cwd, ".lance-nuit"), "default");
  expect(pipelinePathStep.run(state(cwd))).toEqual({ pipelinePath: target });
});

test("run: unknown name → exit(1) after listing searched paths", () => {
  process.env.PIPELINE_HOME = dir("home");
  const cwd = dir("project");
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit;

  try {
    expect(() => pipelinePathStep.run(state(cwd, "missing"))).toThrow("exit:1");
  } finally {
    process.stderr.write = write;
  }

  const output = lines.join("");
  expect(output).toContain("Pipeline `missing` not found");
  expect(output).toContain(join(cwd, ".lance-nuit", "pipelines", "missing.ts"));
  expect(output).toContain(join(process.env.PIPELINE_HOME!, "pipelines", "missing.ts"));
});
