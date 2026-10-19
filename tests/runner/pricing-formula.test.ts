import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mapCodexExecutionResult } from "../../src/engine/backends/codex/result.js";
import { CODEX_MODEL } from "../../src/engine/backends/codex/types.js";
import { costOf } from "../../src/run-stats/stats-core.js";

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

test("a Codex run costs the same in the history as the runner charged it", () => {
  // Codex reports `input_tokens` with the cached reads inside; the runner bills
  // them once, at the cache rate. The history must not bill them a second time
  // at the input rate.
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 10 };
  const output = JSON.stringify({ type: "turn.completed", model: CODEX_MODEL.GPT_5_6_LUNA, usage });
  const { stats } = mapCodexExecutionResult({ output, code: 0, killed: false, durationMs: 1 });
  // The runner's built-in Codex rates, as a project would declare them.
  const table = {
    _currency: "$",
    [CODEX_MODEL.GPT_5_6_LUNA]: { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  };
  const models = {
    [CODEX_MODEL.GPT_5_6_LUNA]: {
      in: stats?.input_tokens ?? 0,
      out: stats?.output_tokens ?? 0,
      cacheRead: stats?.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
  };

  expect(stats?.total_cost_usd).toBeCloseTo((200_000 * 0.2 + 800_000 * 0.02 + 10 * 1.2) / 1_000_000, 12);
  expect(costOf(models, table)).toBe(stats?.total_cost_usd ?? Number.NaN);
});
