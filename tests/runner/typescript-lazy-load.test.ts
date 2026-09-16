// `typescript` is the heaviest runtime dependency and only `create`,
// `--typecheck`, and `types install` need it. Loading it at startup would tax
// every `lancenuit run` with its parse time; it must stay behind a call.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const startup = resolve(import.meta.dir, "../../src/entry/startup.ts");
const dslTypes = resolve(import.meta.dir, "../../src/project/dsl-types.ts");
const typescriptRuntime = resolve(import.meta.dir, "../../src/project/dsl-types/typescript-runtime.ts");

function loadedModules(script: string): string[] {
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

const LIST_TYPESCRIPT = `console.log(JSON.stringify(Object.keys(require.cache).filter((m) => m.includes("/node_modules/typescript/"))));`;

test("importing the CLI startup does not load typescript", () => {
  expect(loadedModules(`await import(${JSON.stringify(startup)}); ${LIST_TYPESCRIPT}`)).toEqual([]);
});

test("importing the dsl-types facade does not load typescript", () => {
  expect(loadedModules(`await import(${JSON.stringify(dslTypes)}); ${LIST_TYPESCRIPT}`)).toEqual([]);
});

test("loadTypeScript brings the compiler in on first call", () => {
  const script = `
    const { loadTypeScript } = await import(${JSON.stringify(typescriptRuntime)});
    if (typeof loadTypeScript().version !== "string") throw new Error("no compiler");
    ${LIST_TYPESCRIPT}`;
  expect(loadedModules(script)).not.toEqual([]);
});
