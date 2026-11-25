// The authoring surface has one list: the `Dsl` interface. `createProjectDsl`
// is tied to it by the compiler, `@lance-nuit/dsl` publishes only types, and
// the generated reference must document every injected value and exported type.
// Adding a builder in one place only fails here or in `tsc`.
import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type DslPublicSurface, DSL_API_FILE, generateDslApi } from "../../scripts/generate-dsl-api.ts";

setDefaultTimeout(60_000);

let generated: { readonly text: string; readonly surface: DslPublicSurface };

beforeAll(() => {
  generated = generateDslApi();
});

test("every injected value and every facade type is documented", () => {
  const { injected, facade, documented } = generated.surface;
  expect(injected.size).toBeGreaterThan(30);
  expect([...injected.values()].filter((name) => !documented.has(name))).toEqual([]);
  expect([...facade].filter((name) => !documented.has(name))).toEqual([]);
  expect(facade.has("Dsl")).toBe(true);
});

test("the facade publishes no value a pipeline could import and fail to load", async () => {
  const facade = await import("../../src/definition/project/dsl.ts");
  expect(Object.keys(facade)).toEqual([]);
});

test("docs/DSL-API.md is the generated reference", () => {
  expect(readFileSync(DSL_API_FILE, "utf8")).toBe(generated.text);
});
