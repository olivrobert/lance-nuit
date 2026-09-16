// runner/exec/self-spawn.test.ts
//
// A relaunch has to land on the same interpreter as its parent: that is what makes
// Bun the runtime of every phase the runner delegates to itself (sub-work-item,
// commit, finalize, scan) without a loader flag travelling in the environment.
// A green suite proves nothing about the runtime unless a child reports its own.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const selfSpawnModule = resolve(import.meta.dir, "self-spawn.ts");

interface ChildRuntime {
  bun: string | null;
  execPath: string;
  argv1: string;
}

test("a relaunched runner reports Bun and the interpreter of its parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-spawn-runtime-"));
  try {
    const proof = join(dir, "child-runtime.json");
    // The harness plays both roles: without the marker it relaunches itself
    // through selfSpawnRunner, with it, it records the runtime it was given.
    const harness = join(dir, "harness.ts");
    writeFileSync(
      harness,
      [
        'import { writeFileSync } from "node:fs";',
        `import { selfSpawnRunner } from ${JSON.stringify(selfSpawnModule)};`,
        "",
        'if (process.argv.includes("--relaunched")) {',
        `  writeFileSync(${JSON.stringify(proof)}, JSON.stringify({`,
        "    bun: process.versions.bun ?? null,",
        "    execPath: process.execPath,",
        "    argv1: process.argv[1],",
        "  }));",
        "  process.exit(0);",
        "}",
        'process.exit(await selfSpawnRunner(["--relaunched"]));',
        "",
      ].join("\n"),
    );

    const parent = spawnSync(process.execPath, [harness], { cwd: dir, encoding: "utf8" });
    expect(`${parent.stdout}${parent.stderr}`).toBe("");
    expect(parent.status).toBe(0);

    const child = JSON.parse(readFileSync(proof, "utf8")) as ChildRuntime;
    expect(child.bun).toMatch(/^\d+\.\d+\.\d+/);
    expect(child.execPath).toBe(process.execPath);
    expect(child.argv1).toBe(harness);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
