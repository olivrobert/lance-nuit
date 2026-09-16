import type { ErrorExtractor } from "../contracts/extraction.js";
import { truncate } from "../lib/truncate.js";
import { type JsonObject, object, parseJsonReport } from "./lib/json-report.js";

/**
 * Actual shape of `logs.json`: one array per status, with the mutant
 * coordinates nested under `mutator` rather than at the entry root.
 *   { "stats": {...}, "escaped": [ { "mutator": { "mutatorName",
 *     "originalFilePath", "originalStartLine" }, "diff": "..." } ],
 *     "killed": [...], "uncovered": [...] }
 */
const SURVIVOR_KEYS = ["escaped", "timeouted"] as const;
const UNCOVERED_KEYS = ["uncovered", "notCovered"] as const;

function describe(entry: JsonObject): string {
  // Tolerance: some loggers flatten the fields onto the mutant root.
  const mutator = object(entry.mutator) ?? entry;
  const file = typeof mutator.originalFilePath === "string" ? mutator.originalFilePath : "unknown file";
  // `originalStartLine` is the key the JsonReporter emits; `originalStartingLine`
  // comes from the PHP accessor name and lingers in docs and third-party loggers.
  const lineValue = mutator.originalStartLine ?? mutator.originalStartingLine;
  const line = typeof lineValue === "number" ? `:${lineValue}` : "";
  const name =
    typeof mutator.mutatorName === "string"
      ? mutator.mutatorName
      : typeof entry.mutator === "string"
        ? entry.mutator
        : "unknown mutation";
  const diff = typeof entry.diff === "string" ? `\n${entry.diff.trim()}` : "";
  return `${file}${line} — ${name}${diff}`;
}

function collect(report: JsonObject, keys: readonly string[]): JsonObject[] {
  const found: JsonObject[] = [];
  for (const key of keys) {
    const entries = Array.isArray(report[key]) ? (report[key] as unknown[]) : [];
    for (const entry of entries) {
      const mutant = object(entry);
      if (mutant) found.push(mutant);
    }
  }
  return found;
}

/** Reads Infection's JSON report rather than the shifting terminal labels. */
export const extract: ErrorExtractor = (output) => {
  const report = parseJsonReport(
    output,
    (candidate) => "stats" in candidate || SURVIVOR_KEYS.some((key) => key in candidate) || "mutants" in candidate,
  );
  if (!report) return { hasErrors: false, errors: truncate(output), reportFound: false };

  const survivors = collect(report, SURVIVOR_KEYS);

  // Tolerance: flat `{ mutants: [{ status, ... }] }` report.
  const flat = Array.isArray(report.mutants) ? (report.mutants as unknown[]) : [];
  for (const entry of flat) {
    const mutant = object(entry);
    const status = typeof mutant?.status === "string" ? mutant.status.toLowerCase() : "";
    if (mutant && (status === "escaped" || status === "survived" || status === "timeouted")) survivors.push(mutant);
  }

  // The report can announce escaped mutants without detailing the array
  // (partial logger): the counter stays authoritative so a failure is never mute.
  const stats = object(report.stats);
  const escapedCount = typeof stats?.escapedCount === "number" ? stats.escapedCount : 0;

  if (survivors.length > 0 || escapedCount > 0) {
    // The total precedes truncation: a fix handed 3 mutants out of 40 must know
    // more remain, otherwise it declares itself done after the first three.
    const header = survivors.length > 1 ? `${survivors.length} surviving mutants:\n\n` : "";
    const detail = survivors.map(describe).join("\n\n") || `${escapedCount} escaped mutant(s), report without detail`;
    return { hasErrors: true, errors: header + truncate(detail), reportFound: true };
  }

  // No survivor yet a failing step: the MSI threshold is what blocks, on
  // uncovered code. The exit code remains authoritative (hasErrors false), but
  // listing the uncovered mutants says what to test — the stdout MSI summary does not.
  const uncovered = collect(report, UNCOVERED_KEYS);
  if (uncovered.length > 0) {
    return {
      hasErrors: false,
      errors: `${uncovered.length} mutant(s) not covered by the tests:\n\n${truncate(uncovered.map(describe).join("\n\n"))}`,
      reportFound: true,
    };
  }

  return { hasErrors: false, errors: "", reportFound: true };
};
