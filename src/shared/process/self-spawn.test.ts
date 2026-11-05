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

import { DISPATCH_CHILD_ENV, withoutRunnerInternalEnv } from "./self-spawn.js";

const selfSpawnModule = resolve(import.meta.dir, "self-spawn.ts");

const INTERNAL_VALUES = {
  RUNNER_LOCK_HELD: "1",
  RUNNER_IN_WORKTREE: "1",
  RUNNER_EVENTS_FILE: "/tmp/parent-events.jsonl",
  RUNNER_LIVE_FEED: "/tmp/parent-live.jsonl",
  RUNNER_DISABLE_DISPATCH: "1",
};

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

test("withoutRunnerInternalEnv drops the runner-internal variables and keeps everything else", () => {
  const input: NodeJS.ProcessEnv = {
    ...INTERNAL_VALUES,
    RUNNER_BIN: "/opt/runner.ts",
    RUNNER_DIR: "/opt",
    RUNNER_VERDICT_MODE: "strict",
    PATH: "/usr/bin",
  };
  const snapshot = { ...input };

  const stripped = withoutRunnerInternalEnv(input);

  expect(stripped).toEqual({
    RUNNER_BIN: "/opt/runner.ts",
    RUNNER_DIR: "/opt",
    RUNNER_VERDICT_MODE: "strict",
    PATH: "/usr/bin",
  });
  expect(input).toEqual(snapshot);
});

test("a relaunched runner still inherits the runner-internal variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-spawn-env-"));
  try {
    const proof = join(dir, "child-env.json");
    const names = Object.keys(INTERNAL_VALUES);
    const harness = join(dir, "harness.ts");
    writeFileSync(
      harness,
      [
        'import { writeFileSync } from "node:fs";',
        `import { selfSpawnRunner, DISPATCH_CHILD_ENV } from ${JSON.stringify(selfSpawnModule)};`,
        "",
        'if (process.argv.includes("--relaunched")) {',
        `  const names = ${JSON.stringify(names)};`,
        `  writeFileSync(${JSON.stringify(proof)}, JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))));`,
        "  process.exit(0);",
        "}",
        `Object.assign(process.env, ${JSON.stringify({ ...INTERNAL_VALUES, RUNNER_DISABLE_DISPATCH: undefined })});`,
        'process.exit(await selfSpawnRunner(["--relaunched"], { ...DISPATCH_CHILD_ENV }));',
        "",
      ].join("\n"),
    );

    const parent = spawnSync(process.execPath, [harness], { cwd: dir, encoding: "utf8" });
    expect(`${parent.stdout}${parent.stderr}`).toBe("");
    expect(parent.status).toBe(0);

    const child = JSON.parse(readFileSync(proof, "utf8")) as Record<string, string | null>;
    expect(child).toEqual({
      ...INTERNAL_VALUES,
      ...DISPATCH_CHILD_ENV,
      // selfSpawnRunner has always dropped this one; RUNNER_EVENTS_FILE still carries the feed.
      RUNNER_LIVE_FEED: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
