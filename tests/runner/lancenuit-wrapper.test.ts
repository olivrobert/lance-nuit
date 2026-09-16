import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

const wrapper = resolve(import.meta.dir, "../../bin/lancenuit");

// Every test spawns the wrapper, which boots Bun and compiles declarations
// with TypeScript; under machine load that exceeds the 5-second default.
setDefaultTimeout(30_000);

function runLancenuit(cwd: string, ...args: string[]) {
  return spawnSync("bash", [wrapper, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
  });
}

/** The current PATH minus every directory that provides a `bun` executable. */
function pathWithoutBun(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, "bun")))
    .join(delimiter);
}

test("version reports package metadata without loading project configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-version-"));
  try {
    mkdirSync(join(root, ".lance-nuit"));
    writeFileSync(join(root, ".lance-nuit/config.json"), "invalid config");
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    for (const flag of ["version", "--version"]) {
      const result = runLancenuit(root, flag);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`lance-nuit ${version}`);
    }
    expect(existsSync(join(root, ".lance-nuit/work-items"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public lancenuit types install wrapper generates project and user declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-wrapper-"));
  try {
    const project = runLancenuit(root, "types", "install");
    expect(project.status).toBe(0);
    expect(`${project.stdout}${project.stderr}`).toContain("DSL types installed");
    expect(existsSync(join(root, ".lance-nuit", ".lance-nuit-types", "project", "dsl.d.ts"))).toBe(true);

    mkdirSync(join(root, ".lance-nuit", "pipelines"), { recursive: true });
    writeFileSync(
      join(root, ".lance-nuit", "pipelines", "typed.ts"),
      `import type { Dsl } from "@lance-nuit/dsl";
const metadata = { name: "typed" } satisfies Record<string, string>;
export default ({ pipeline, bashStep }: Dsl) => pipeline(metadata.name)
  .add(bashStep({ id: "check", name: "Check", command: "true" }))
  .build();
`,
    );
    const lint = runLancenuit(root, "lint", "-p", ".lance-nuit/pipelines/typed.ts");
    expect(lint.status).toBe(0);
    expect(`${lint.stdout}${lint.stderr}`).toContain("definition and references are valid");

    // `run` no longer treats its first argument as the ticket: options may come
    // first, and a ticket-less invocation reaches the runner intact.
    const optionsFirst = runLancenuit(root, "run", "-p", ".lance-nuit/pipelines/typed.ts", "--lint-pipeline");
    expect(optionsFirst.status).toBe(0);
    expect(`${optionsFirst.stdout}${optionsFirst.stderr}`).toContain("definition and references are valid");
    expect(optionsFirst.stderr).not.toContain("expects a value");

    const user = runLancenuit(root, "types", "install", "--user");
    expect(user.status).toBe(0);
    expect(existsSync(join(root, "shared-kit", ".lance-nuit-types", "project", "dsl.d.ts"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The suite passing says nothing about the runtime the wrapper chose: `bun test`
// would report the same result if the wrapper had launched the runner on Node.
// The pipeline module is loaded by the runner process itself, so recording
// `process.versions.bun` while it is imported reports that process's runtime.
test("the wrapper runs the runner on Bun", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-wrapper-runtime-"));
  try {
    const proof = join(root, "runtime.json");
    const pipelineDir = join(root, ".lance-nuit", "pipelines");
    mkdirSync(pipelineDir, { recursive: true });
    const pipeline = join(pipelineDir, "runtime.ts");
    writeFileSync(
      pipeline,
      `import { writeFileSync } from "node:fs";
writeFileSync(
  ${JSON.stringify(proof)},
  JSON.stringify({ bun: process.versions.bun ?? null, execPath: process.execPath }),
);
export default ({ pipeline, bashStep }: any) => pipeline("runtime-proof")
  .add(bashStep({ id: "noop", name: "No-op", command: "true" }))
  .build();
`,
    );

    const result = runLancenuit(root, "run", "RUNTIME-1", "-p", pipeline);
    expect(`${result.stdout}${result.stderr}`).toContain("SUCCESS");
    expect(result.status).toBe(0);

    const observed = JSON.parse(readFileSync(proof, "utf8")) as { bun: string | null; execPath: string };
    expect(observed.bun).toMatch(/^\d+\.\d+\.\d+/);
    expect(basename(observed.execPath)).toBe("bun");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the wrapper refuses with exit 127 when bun is absent from PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-wrapper-no-bun-"));
  try {
    const result = spawnSync("bash", [wrapper, "help"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: pathWithoutBun() },
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("bun was not found on PATH");
    expect(result.stderr).toContain("https://bun.sh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("types wrapper rejects unsupported forms cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-wrapper-errors-"));
  try {
    for (const args of [["types"], ["types", "nope"], ["types", "install", "unexpected"]]) {
      const result = runLancenuit(root, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toMatch(/Error:|at .*\(/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `dist/` in a source checkout is a git-ignored packaging product; it is stale as
// soon as a source changes. When the wrapper preferred it, `lancenuit types
// install` from a checkout installed the declarations of an old build and every
// new DSL field was "unknown" to project pipelines. The wrapper resolves its
// entry point from its own location, so a copy in a tree holding both entries,
// with a fake `bun` that echoes its arguments, shows which one it launches.
test("the wrapper prefers the source entry point over a built dist/ in a checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "lancenuit-wrapper-entry-"));
  try {
    const checkout = join(root, "checkout");
    for (const dir of ["bin", "src", "dist"]) mkdirSync(join(checkout, dir), { recursive: true });
    writeFileSync(join(checkout, "bin", "lancenuit"), readFileSync(wrapper));
    writeFileSync(join(checkout, "src", "runner.ts"), "");
    writeFileSync(join(checkout, "dist", "runner.js"), "");

    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeBun = join(fakeBin, "bun");
    writeFileSync(fakeBun, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    chmodSync(fakeBun, 0o755);

    const result = spawnSync("bash", [join(checkout, "bin", "lancenuit"), "typecheck"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(result.status).toBe(0);
    const [entry] = result.stdout.split("\n");
    expect(entry).toBe(join(checkout, "src", "runner.ts"));

    // A published package has no sources: the compiled entry point is the one left.
    rmSync(join(checkout, "src"), { recursive: true, force: true });
    const published = spawnSync("bash", [join(checkout, "bin", "lancenuit"), "typecheck"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(published.stdout.split("\n")[0]).toBe(join(checkout, "dist", "runner.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
