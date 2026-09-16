import { describe, expect, test } from "bun:test";
import { isExtractorModuleFile, listAvailableExtractors } from "./registry.js";
import { extract as extractTestsJson } from "./tests-json.js";
import { extract as extractTsc } from "./tsc.js";

test("registry lists the shipped extractors and hides internals", () => {
  const available = listAvailableExtractors();
  expect(available.has("tsc")).toBe(true);
  expect(available.has("tests-json")).toBe(true);
  expect(available.has("phpstan")).toBe(true);
  expect(available.has("phpunit")).toBe(true);
  expect(available.has("infection")).toBe(true);
  expect(available.has("registry")).toBe(false);
  expect(available.has("extractors.test")).toBe(false);
  expect(available.has("php.test")).toBe(false);
  expect(available.has("lib")).toBe(false);
});

test("dist declaration files are not offered as extractors", () => {
  expect(isExtractorModuleFile("tsc.js")).toBe(true);
  expect(isExtractorModuleFile("tsc.ts")).toBe(true);
  expect(isExtractorModuleFile("tsc.d.ts")).toBe(false);
  expect(isExtractorModuleFile("registry.d.ts")).toBe(false);
  expect(isExtractorModuleFile("extractors.test.ts")).toBe(false);
  expect(isExtractorModuleFile("tsc.js.map")).toBe(false);
});

describe("tsc extractor", () => {
  test("keeps diagnostics and their continuation lines, drops noise", () => {
    const output = [
      "src/a.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
      "",
      "12     const n: number = value;",
      "src/b.ts(3,1): error TS1005: ';' expected.",
      "Found 2 errors in 2 files.",
    ].join("\n");
    const result = extractTsc(output);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("TS2322");
    expect(result.errors).toContain("TS1005");
    expect(result.errors).not.toContain("Found 2 errors");
  });

  test("clean output yields no errors", () => {
    expect(extractTsc("Checked 312 files in 41ms.")).toEqual({ hasErrors: false, errors: "" });
  });
});

describe("tests-json extractor", () => {
  test("collects failed assertions from a jest-style report", () => {
    const report = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: "adds numbers", status: "passed" },
            { fullName: "divides by zero", status: "failed", failureMessages: ["expected Infinity"] },
          ],
        },
      ],
    });
    const result = extractTestsJson(report);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("divides by zero");
    expect(result.errors).toContain("expected Infinity");
    expect(result.errors).not.toContain("adds numbers");
  });

  test("collects failures from a flat tests array", () => {
    const report = JSON.stringify({
      tests: [
        { name: "ok test", status: "passed" },
        { name: "broken test", state: "failed", message: "boom" },
      ],
    });
    const result = extractTestsJson(report);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("broken test");
    expect(result.errors).toContain("boom");
  });

  // `reportFound` separates the two: unparsable input means no report was produced,
  // an empty green report means the suite ran and passed.
  test("non-JSON output falls back to hasErrors=false so raw output is used", () => {
    expect(extractTestsJson("not json at all")).toEqual({ hasErrors: false, errors: "", reportFound: false });
  });

  test("green report yields no errors", () => {
    expect(extractTestsJson(JSON.stringify({ testResults: [] }))).toEqual({
      hasErrors: false,
      errors: "",
      reportFound: true,
    });
  });
});
