// Writes the published JSON Schema of the read API, version 1, from the zod
// schemas that prove the contract (`src/dashboard/read-model/read-api.schema.ts`).
// A test compares the committed files with this output: run `bun run docs:read-api`
// after changing the contract, then commit the diff.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readApiJsonSchemas } from "../src/dashboard/read-model/read-api.schema.js";

const OUTPUT_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "docs", "read-api", "v1");

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const [name, schema] of Object.entries(readApiJsonSchemas())) {
  writeFileSync(join(OUTPUT_DIR, name), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote docs/read-api/v1/${name}`);
}
