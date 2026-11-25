import { describe, expect, test } from "bun:test";
import { errorExtractor, errorExtractorNames } from "./registry.js";
import { extract as extractTestsJson } from "./tests-json.js";
import { extract as extractTsc } from "./tsc.js";

test("the registry names the shipped extractors and resolves each to its module", () => {
  expect(errorExtractorNames().sort()).toEqual(["infection", "phpstan", "phpunit", "tests-json", "tsc"]);
  expect(errorExtractor("tsc")).toBe(extractTsc);
  expect(errorExtractor("tests-json")).toBe(extractTestsJson);
});

test("a name outside the table resolves to nothing, prototype keys included", () => {
  expect(errorExtractor("registry")).toBeUndefined();
  expect(errorExtractor("constructor")).toBeUndefined();
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
