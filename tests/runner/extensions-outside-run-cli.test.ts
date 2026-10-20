// The commands that run outside a run see the providers a run sees.
//
// A run extends the built-in providers with the project's extension manifest. The
// lint commands load the same pipelines and the same configuration, so they must
// resolve the same backends: otherwise `--lint-pipeline` and `--lint-config`
// reject a project whose run passes. Everything runs the real CLI in a child
// process against a real project; the backend is never invoked.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(60_000);
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runRunner(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 50_000,
    env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
  });
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

/** Imports `lance-nuit/contracts` like a real kit extension, so the lint path
 *  must also vendor the contracts before it imports the manifest. */
const EXTENSIONS = `
import { defineExtension } from "lance-nuit/contracts";

const capabilities = { structuredOutput: true, streaming: false, resume: false, usageTokens: false, cost: "none" };

export default defineExtension({
  backends: [
    {
      id: "custom",
      capabilities,
      create() {
        return { id: "custom", capabilities, async run() { throw new Error("never invoked by a lint"); } };
      },
    },
  ],
});
`;

const DEMO = `export default ({ pipeline, llmStep }: any) => pipeline("demo")
  .add(llmStep({ id: "code", name: "Code", backend: "custom", profile: "coder", command: "go" }))
  .build();
`;

function scratchProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "extensions-outside-run-"));
  scratchRoots.push(cwd);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(join(cwd, ".lance-nuit", "extensions.mjs"), EXTENSIONS);
  writeFileSync(
    join(cwd, ".lance-nuit", "config.json"),
    `${JSON.stringify(
      {
        extensions: { module: "./.lance-nuit/extensions.mjs" },
        profiles: { coder: { backends: { custom: {} } } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", "demo.ts"), DEMO);
  return cwd;
}

test("--lint-pipeline accepts a backend declared by the extension manifest", () => {
  const cwd = scratchProject();

  const lint = runRunner(cwd, "--lint-pipeline", "-p", "demo");

  expect(lint.out).not.toContain('unknown agent backend "custom"');
  expect(lint.out).toContain("✓ definition and references are valid");
  expect(lint.status).toBe(0);
});

test("a manifest that cannot load fails the lint, and leaves the commands that only read runs working", () => {
  const cwd = scratchProject();
  writeFileSync(join(cwd, ".lance-nuit", "extensions.mjs"), `throw new Error("broken manifest");\n`);

  const lint = runRunner(cwd, "--lint-config");
  expect(lint.out).toContain("Unable to load the project configuration");
  expect(lint.out).toContain("broken manifest");
  expect(lint.status).toBe(1);

  // Inspecting the run such a manifest broke must not depend on it.
  const inspect = runRunner(cwd, "--inspect", "T-1");
  expect(inspect.out).not.toContain("broken manifest");
  expect(inspect.status).toBe(0);
});

test("--lint-config accepts a profile naming a backend declared by the extension manifest", () => {
  const cwd = scratchProject();

  const lint = runRunner(cwd, "--lint-config");

  expect(lint.out).not.toContain('unknown backend "custom"');
  expect(lint.out).not.toContain("cannot be loaded outside a run");
  expect(lint.out).toMatch(/code\s.*@coder/);
  expect(lint.out).toContain("✓ Profile/step configuration is consistent with pipelines");
  expect(lint.status).toBe(0);
});
