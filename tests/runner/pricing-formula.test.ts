import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "src");

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.isFile() && /\.tsx?$/.test(path) && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Code lines of `src/` matching `pattern`, as `file:line`. Comments are skipped. */
function codeLinesMatching(pattern: RegExp): string[] {
  return productionSources(SRC).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        !/^\s*(\/\/|\*|\/\*)/.test(line) && pattern.test(line) ? [`${relative(SRC, file)}:${index + 1}`] : [],
      ),
  );
}

test("a token count is multiplied by a rate in contracts/pricing.ts only", () => {
  // `x * p.in`, `x * (rate.cacheRead || 0)`, `x * pricing.cache_read`: a second
  // copy of the formula priced the history and the runner differently.
  const rateProduct = /\*\s*\(?\s*\w+\.(in|out|input|output|cache_?read|cache_?write\w*)\b/i;
  const files = new Set(codeLinesMatching(rateProduct).map((at) => at.split(":")[0]));

  expect([...files]).toEqual(["contracts/pricing.ts"]);
});

test("a model is matched to a rate in contracts/pricing.ts only", () => {
  const files = new Set(codeLinesMatching(/\bmatchingPricingKey\s*\(/).map((at) => at.split(":")[0]));

  expect([...files]).toEqual(["contracts/pricing.ts"]);
});
