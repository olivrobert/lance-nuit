// The commands that run outside a run see the providers a run sees.
//
// A run extends the built-in providers with the project's extension manifest. The
// lint commands load the same pipelines and the same configuration, so they must
// resolve the same backends: otherwise `--lint-pipeline` and `--lint-config`
// reject a project whose run passes. Everything runs the real CLI in a child
// process against a real project; the backend is never invoked.

import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(60_000);

function runRunner(
  cwd: string,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string; out: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerEntry, ...args], {
      cwd,
      env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, out: `${stdout}${stderr}` });
    });
  });
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
  .add(llmStep({ id: "code", name: "Code", backend: "custom", profile: "coder", command: "go", rerunOnResume: true }))
  .build();
`;

function scratchProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "extensions-outside-run-"));
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

test.concurrent("--lint-pipeline accepts a backend declared by the extension manifest", async () => {
  const cwd = scratchProject();
  try {
    const lint = await runRunner(cwd, "--lint-pipeline", "-p", "demo");

    expect(lint.out).not.toContain('unknown agent backend "custom"');
    expect(lint.out).toContain("✓ definition and references are valid");
    expect(lint.status).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("a manifest that cannot load fails the lint, and leaves the commands that only read runs working", async () => {
  const cwd = scratchProject();
  try {
    writeFileSync(join(cwd, ".lance-nuit", "extensions.mjs"), `throw new Error("broken manifest");\n`);

    const [lint, inspect] = await Promise.all([
      runRunner(cwd, "--lint-config"),
      // Inspecting the run such a manifest broke must not depend on it.
      runRunner(cwd, "--inspect", "T-1"),
    ]);
    expect(lint.out).toContain("Unable to load the project configuration");
    expect(lint.out).toContain("broken manifest");
    expect(lint.status).toBe(1);

    expect(inspect.out).not.toContain("broken manifest");
    expect(inspect.status).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("--lint-config accepts a profile naming a backend declared by the extension manifest", async () => {
  const cwd = scratchProject();
  try {
    const lint = await runRunner(cwd, "--lint-config");

    expect(lint.out).not.toContain('unknown backend "custom"');
    expect(lint.out).not.toContain("cannot be loaded outside a run");
    expect(lint.out).toMatch(/code\s.*@coder/);
    expect(lint.out).toContain("✓ Profile/step configuration is consistent with pipelines");
    expect(lint.status).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
