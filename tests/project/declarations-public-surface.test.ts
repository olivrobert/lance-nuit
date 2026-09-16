// The installed DSL declarations are compiled transitively from `project/dsl.ts`.
// The runtime schemas (`state/schema.ts`, `env/config.schema.ts`) import zod; a
// public type written as `z.infer<...>` would drag `import "zod"` into a project
// that never installed it. The interfaces stay hand-written, and this test is the
// contract: no declaration reachable from the DSL entry point mentions zod.
//
// The emitted tree also holds declarations nothing public reaches (the schema
// modules themselves, for one). They are inert: the kit tsconfig only includes
// `pipelines/**`, so a file enters a project's typecheck through an import chain
// from `project/dsl.d.ts` or not at all. The walk below follows that chain.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DECLARATIONS_ENTRY, generateDslDeclarations } from "../../src/project/dsl-types/declarations.ts";

setDefaultTimeout(30_000);

const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

function resolveDeclaration(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier).replace(/\.(js|ts|d\.ts)$/, "");
  return [`${base}.d.ts`, join(base, "index.d.ts")].find((candidate) => existsSync(candidate));
}

/** Every declaration file reachable from `entry` through relative imports. */
function reachableDeclarations(entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (sources.has(file)) continue;
    const source = readFileSync(file, "utf-8");
    sources.set(file, source);
    for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
      const target = resolveDeclaration(file, match[1]!);
      if (target && !sources.has(target)) queue.push(target);
    }
  }
  return sources;
}

function publicSurface(prefix: string): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), prefix));
  generateDslDeclarations(out);
  const reachable = reachableDeclarations(join(out, DECLARATIONS_ENTRY));
  // Sanity: the walk must actually cover the public surface, not stop at the entry.
  expect(reachable.size).toBeGreaterThan(20);
  return new Map([...reachable].map(([file, source]) => [relative(out, file), source]));
}

test("declarations reachable from the DSL entry point never import zod", () => {
  const offenders = [...publicSurface("dsl-declarations-no-zod-")]
    .filter(([, source]) => /["']zod["']/.test(source))
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});

// The kit tsconfig written by `types install` declares no `types` and a project
// pipeline directory has no reason to depend on @types/node. A public signature
// naming an ambient node type therefore fails the very first `lancenuit create`
// with "Cannot find namespace 'NodeJS'". Spell such parameters structurally
// (`Record<string, string | undefined>` for an environment, for one).
test("declarations reachable from the DSL entry point never name ambient node types", () => {
  const offenders = [...publicSurface("dsl-declarations-ambient-")]
    .filter(([, source]) => /\bNodeJS\./.test(source))
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});

// The kit typecheck sees `llmStep` options through the installed `dsl/dsl-types.d.ts`,
// and `LlmStepOptions` is an intersection whose non-variant members must carry
// every author-facing field. A field present in the source but absent here is
// exactly what a project pipeline reports as TS2353 "'capture' does not exist".
test("the installed LlmStepOptions declaration carries its author-facing fields", () => {
  const surface = publicSurface("dsl-declarations-llm-options-");
  const options = surface.get(join("dsl", "dsl-types.d.ts"));
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
