import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunStep } from "../state/run-step.ts";
import { discardStaleReports, extractErrors } from "./report-extraction.ts";

function phpunitStep(reportPaths: string[]) {
  return makeRunStep({
    id: "tests",
    name: "Tests",
    command: "phpunit",
    runner: "bash",
    error_extractor: "phpunit",
    report_paths: reportPaths,
  });
}

test("discardStaleReports removes the previous report and tolerates a missing one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extract-report-"));
  const report = join(dir, "junit.xml");
  writeFileSync(report, "<testsuites></testsuites>");

  await discardStaleReports(phpunitStep([report, join(dir, "never-written.xml")]));

  expect(existsSync(report)).toBe(false);
});

test("extractErrors reads stdout when the step declares no report", async () => {
  const step = makeRunStep({ id: "tests", name: "Tests", command: "phpunit", runner: "bash" });
  const extraction = await extractErrors(step, "Fatal error: boom");
  expect(extraction).toEqual({ hasErrors: true, errors: "Fatal error: boom" });
});

// A declared report that was never written is the fact `fixOnlyWhenExtracted` acts
// on: `hasErrors: false` alone cannot tell it from a suite that ran and passed.
test("extractErrors reports a missing declared report as reportFound: false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extract-report-"));
  const step = phpunitStep([join(dir, "junit.xml")]);

  const extraction = await extractErrors(step, 'service "php" is not running');

  expect(extraction.reportFound).toBe(false);
  expect(extraction.hasErrors).toBe(false);
  expect(extraction.errors).toContain('service "php" is not running');
});

test("extractErrors reports a green declared report as reportFound: true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extract-report-"));
  const report = join(dir, "junit.xml");
  writeFileSync(report, '<testsuites><testsuite name="unit" failures="0" errors="0"></testsuite></testsuites>');
  const step = phpunitStep([report]);

  const extraction = await extractErrors(step, "OK (12 tests)");

  expect(extraction.reportFound).toBe(true);
  expect(extraction.hasErrors).toBe(false);
});
