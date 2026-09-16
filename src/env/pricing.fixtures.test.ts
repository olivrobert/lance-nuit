// `pricing.json` is optional and user-written: a valid table must keep loading
// unchanged, and a malformed one must be reported once and treated as absent
// (see the header of `env/pricing.schema.ts`).
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPricingForModel } from "../contracts/pricing.js";
import { loadProjectPricing, resolveProjectPricing } from "./pricing.js";
import { diagnoseProjectPricing, readProjectPricingFile } from "./pricing.schema.js";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/pricing/", import.meta.url));

function fixture(name: string): string {
  return `${FIXTURES}${name}.json`;
}

/** Write `content` verbatim: the malformed cases are not representable as JSON. */
function tempPricingFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pricing-fixture-")), "pricing.json");
  writeFileSync(path, content, "utf-8");
  return path;
}

let warnings: string[] = [];

function captureWarnings(): void {
  warnings = [];
  spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
}

afterEach(() => {
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test("pricing fixtures: a table with object entries and the `_currency` string loads", () => {
  const table = readProjectPricingFile(fixture("project-full"));
  expect(table).not.toBeNull();
  expect(table!._currency).toBe("$");
  expect(projectPricingForModel("claude-opus-4-8-20260101", table!)).toEqual({
    input: 6,
    output: 30,
    cache_read: 0.6,
    cache_write_5m: 7.5,
    cache_write_1h: 7.5,
  });
  // A partial entry stays partial: the missing rates are zero, not the default table's.
  expect(projectPricingForModel("zai-org/glm-4.7", table!)).toEqual({
    input: 0.6,
    output: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
  });
});

test("pricing fixtures: a minimal table without `_currency` loads (default currency is $)", () => {
  const table = readProjectPricingFile(fixture("project-minimal"));
  expect(table).toEqual({ opus: { in: 6, out: 30 } });
  expect(projectPricingForModel("opus", table!)?.output).toBe(30);
});

test("an unknown key on a model entry is a typo, not a rate: the table is refused", () => {
  captureWarnings();
  const path = tempPricingFile(JSON.stringify({ opus: { in: 6, cachRead: 0.6 } }));
  expect(readProjectPricingFile(path)).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(path);
  expect(warnings[0]).toContain("cachRead");
  expect(warnings[0]).toContain("treating it as absent");
});

test("a rate of the wrong type is refused and named", () => {
  captureWarnings();
  const path = tempPricingFile(JSON.stringify({ opus: { in: "6", out: 30 } }));
  expect(readProjectPricingFile(path)).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("opus");
  expect(warnings[0]).toContain("in");
});

test("invalid JSON is reported and treated as absent, never thrown", () => {
  captureWarnings();
  const path = tempPricingFile('{ "opus": { "in": 6, } }');
  expect(readProjectPricingFile(path)).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(path);
});

test("a missing file is not a diagnostic: no warning, no table", () => {
  captureWarnings();
  expect(readProjectPricingFile(join(tmpdir(), "no-such-dir-pricing", "pricing.json"))).toBeNull();
  expect(warnings).toEqual([]);
});

test("a top-level value that is not an object is refused", () => {
  captureWarnings();
  expect(readProjectPricingFile(tempPricingFile("[]"))).toBeNull();
  expect(readProjectPricingFile(tempPricingFile('"free"'))).toBeNull();
  expect(warnings).toHaveLength(2);
});

test("diagnoseProjectPricing: the reason without the reading", () => {
  expect(diagnoseProjectPricing({ _currency: "$", opus: { in: 6 } })).toBeUndefined();
  expect(diagnoseProjectPricing({ opus: { in: true } })).toContain("in");
  expect(diagnoseProjectPricing(42)).toBeDefined();
});

test("loadProjectPricing caches its answer for the process", () => {
  // The repository has no `.lance-nuit/pipeline-history/pricing.json`; what matters
  // here is that the second call returns the first answer without reading again.
  expect(loadProjectPricing()).toBe(loadProjectPricing());
});

test("resolveProjectPricing: the user kit supplies rates, the project overrides them model by model", () => {
  const root = mkdtempSync(join(tmpdir(), "pricing-chain-"));
  const userKit = join(root, "user-kit");
  const project = join(root, "project");
  mkdirSync(join(userKit, "pipeline-history"), { recursive: true });
  mkdirSync(join(project, ".lance-nuit", "pipeline-history"), { recursive: true });
  writeFileSync(
    join(userKit, "pipeline-history", "pricing.json"),
    JSON.stringify({ "claude-fable-5-1": { in: 10, out: 50 }, opus: { in: 5, out: 25 } }),
  );
  const env = { ...process.env, PIPELINE_HOME: userKit };

  // Only the shared table: it is the answer.
  expect(resolveProjectPricing(project, env)).toEqual({
    "claude-fable-5-1": { in: 10, out: 50 },
    opus: { in: 5, out: 25 },
  });

  // The project reprices one model and leaves the other to the shared table.
  writeFileSync(
    join(project, ".lance-nuit", "pipeline-history", "pricing.json"),
    JSON.stringify({ opus: { in: 6, out: 30 } }),
  );
  expect(resolveProjectPricing(project, env)).toEqual({
    "claude-fable-5-1": { in: 10, out: 50 },
    opus: { in: 6, out: 30 },
  });
});

test("resolveProjectPricing: a malformed layer is skipped, the other one still applies", () => {
  captureWarnings();
  const root = mkdtempSync(join(tmpdir(), "pricing-chain-"));
  const userKit = join(root, "user-kit");
  const project = join(root, "project");
  mkdirSync(join(userKit, "pipeline-history"), { recursive: true });
  mkdirSync(join(project, ".lance-nuit", "pipeline-history"), { recursive: true });
  writeFileSync(join(userKit, "pipeline-history", "pricing.json"), JSON.stringify({ opus: { in: 5, out: 25 } }));
  writeFileSync(join(project, ".lance-nuit", "pipeline-history", "pricing.json"), "{ not json");
  expect(resolveProjectPricing(project, { ...process.env, PIPELINE_HOME: userKit })).toEqual({
    opus: { in: 5, out: 25 },
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("invalid JSON");
});
