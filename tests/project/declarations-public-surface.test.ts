// The installed DSL declarations are compiled transitively from `definition/project/dsl.ts`.
// The runtime schemas (`run/record/schema.ts`, `shared/env/config.schema.ts`) import zod; a
// public type written as `z.infer<...>` would drag `import "zod"` into a project
// that never installed it. The interfaces stay hand-written, and this test is the
// contract: no declaration reachable from the DSL entry point mentions zod.
//
// The emitted tree also holds declarations nothing public reaches (the schema
// modules themselves, for one). They are inert: the kit tsconfig only includes
// `pipelines/**`, so a file enters a project's typecheck through an import chain
// from `definition/project/dsl.d.ts` or not at all. `reachableDeclarations`
// follows that chain, and installation copies and fingerprints exactly its result.
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  publicDeclarationsHash,
  reachableDeclarations,
  withDslDeclarations,
} from "../../src/definition/project/dsl-types/declarations.ts";
import { DECLARATIONS_ENTRY } from "../../src/definition/project/dsl-types/layout.ts";

setDefaultTimeout(30_000);

let emitted: string;
let surface: Map<string, string>;

beforeAll(() => {
  emitted = mkdtempSync(join(tmpdir(), "dsl-declarations-surface-"));
  withDslDeclarations((declarations) => cpSync(declarations, emitted, { recursive: true }));
  surface = new Map(
    [...reachableDeclarations(emitted)].map((file) => [relative(emitted, file), readFileSync(file, "utf-8")]),
  );
});

test("the walk covers the public surface, not only its entry point", () => {
  expect(surface.size).toBeGreaterThan(20);
  expect(surface.has(join("definition", "dsl", "dsl-types.d.ts"))).toBe(true);
});

test("declarations reachable from the DSL entry point never import zod", () => {
  const offenders = [...surface].filter(([, source]) => /["']zod["']/.test(source)).map(([file]) => file);
  expect(offenders).toEqual([]);
});

// The kit tsconfig written by `types install` declares no `types` and a project
// pipeline directory has no reason to depend on @types/node. A public signature
// naming an ambient node type therefore fails the very first `lancenuit create`
// with "Cannot find namespace 'NodeJS'". Spell such parameters structurally
// (`Record<string, string | undefined>` for an environment, for one).
test("declarations reachable from the DSL entry point never name ambient node types", () => {
  const offenders = [...surface].filter(([, source]) => /\bNodeJS\./.test(source)).map(([file]) => file);
  expect(offenders).toEqual([]);
});

// The kit typecheck sees `llmStep` options through the installed `definition/dsl/dsl-types.d.ts`,
// and `LlmStepOptions` is an intersection whose non-variant members must carry
// every author-facing field. A field present in the source but absent here is
// exactly what a project pipeline reports as TS2353 "'capture' does not exist".
test("the installed LlmStepOptions declaration carries its author-facing fields", () => {
  const options = surface.get(join("definition", "dsl", "dsl-types.d.ts"));
  expect(options).toBeDefined();
  const declaration = options!.slice(options!.indexOf("export type LlmStepOptions<"));
  for (const field of [
    "profile: P;",
    "backend: B;",
    "options?: BackendOptionsFor<B>;",
    "capture?: Readonly<Record<string, CaptureSpec>>;",
  ]) {
    expect(declaration).toContain(field);
  }
  expect(surface.get(DECLARATIONS_ENTRY)).toContain("CaptureSpec,");
});

// `lancenuit typecheck` declares a kit fresh when this fingerprint matches: a
// public declaration it skipped would leave stale types reported as current.
test("the fingerprint follows every reachable declaration and nothing else", () => {
  // A runner laid out as a published install: declarations, no sources.
  const runner = mkdtempSync(join(tmpdir(), "dsl-declarations-runner-"));
  cpSync(emitted, runner, { recursive: true });
  const installed = mkdtempSync(join(tmpdir(), "dsl-declarations-kit-"));
  cpSync(emitted, installed, { recursive: true });
  const before = publicDeclarationsHash(emitted, runner);
  expect(publicDeclarationsHash(installed, runner)).toBe(before);

  writeFileSync(join(runner, "definition", "unreachable.d.ts"), "export type Unreachable = 1;\n");
  expect(publicDeclarationsHash(installed, runner)).toBe(before);

  // Outside the hand-written list the fingerprint used to read.
  const options = join(runner, "definition", "dsl", "dsl-types.d.ts");
  appendFileSync(options, "export type Changed = 1;\n");
  const changed = publicDeclarationsHash(installed, runner);
  expect(changed).not.toBe(before);

  // A checkout: the source wins over its emitted declaration.
  writeFileSync(options.replace(/\.d\.ts$/, ".ts"), "export type OnFail = { retries: number };\n");
  expect(publicDeclarationsHash(installed, runner)).not.toBe(changed);
});
