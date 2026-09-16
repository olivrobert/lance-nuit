import type { ExtractionResult } from "../contracts/extraction.js";

interface ReportedFailure {
  name?: string;
  fullName?: string;
  title?: string;
  message?: string;
  failureMessages?: string[];
  status?: string;
}

/**
 * Extracts failed assertions from a JSON test report.
 *
 * Accepts the common reporter shapes (jest/vitest `testResults`, mocha-style
 * `failures`, a flat `tests` array with a `status`/`state` field). Anything the
 * parser does not recognize yields `hasErrors: false`, which makes the runner
 * fall back to the raw step output instead of hiding the failure.
 */
export function extract(output: string): ExtractionResult {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    // Not JSON: no report was produced (or not the one declared), so the caller
    // can tell an unrun suite from a green one.
    return { hasErrors: false, errors: "", reportFound: false };
  }
  const failures = collectFailures(report);
  const errors = failures
    .map((failure) => {
      const label = failure.fullName ?? failure.name ?? failure.title ?? "unnamed test";
      const detail = failure.failureMessages?.join("\n") ?? failure.message ?? "";
      return detail ? `✗ ${label}\n${detail}` : `✗ ${label}`;
    })
    .join("\n\n");
  return { hasErrors: errors.length > 0, errors, reportFound: true };
}

function collectFailures(report: unknown): ReportedFailure[] {
  if (typeof report !== "object" || report === null) return [];
  const root = report as Record<string, unknown>;
  const failures: ReportedFailure[] = [];

  if (Array.isArray(root.failures)) {
    failures.push(...(root.failures as ReportedFailure[]));
  }
  const flatTests = Array.isArray(root.tests) ? (root.tests as Array<ReportedFailure & { state?: string }>) : [];
  failures.push(...flatTests.filter((test) => (test.status ?? test.state) === "failed"));

  const suites = Array.isArray(root.testResults) ? (root.testResults as Array<Record<string, unknown>>) : [];
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults)
      ? (suite.assertionResults as ReportedFailure[])
      : Array.isArray(suite.testResults)
        ? (suite.testResults as ReportedFailure[])
        : [];
    failures.push(...assertions.filter((assertion) => assertion.status === "failed"));
  }
  return failures;
}
