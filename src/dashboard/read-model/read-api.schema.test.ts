import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readApiJsonSchemas } from "./read-api.schema.ts";

const PUBLISHED_DIR = join(import.meta.dir, "..", "..", "..", "docs", "read-api", "v1");

test("read api schema: the published JSON Schema is the one the contract generates", () => {
  for (const [name, schema] of Object.entries(readApiJsonSchemas())) {
    const published: unknown = JSON.parse(readFileSync(join(PUBLISHED_DIR, name), "utf-8"));
    // Compared as values, so a formatter may rewrap the file freely.
    expect(published, `docs/read-api/v1/${name} is stale: run \`bun run docs:read-api\``).toEqual(schema);
  }
});

test("read api schema: the published copy lets a later release add fields", () => {
  const text = JSON.stringify(readApiJsonSchemas());
  expect(text).not.toContain('"additionalProperties":false');
});
