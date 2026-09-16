// runner/exec/report-extraction.ts
//
// Machine reports declared by `.report()` and the error extraction that reads
// them. Owns three rules: a stale report is removed before a step runs, a report
// that was never written is a fact of its own (`reportFound: false`), and stdout
// is the fallback when no report exists.

import { readFile, unlink } from "node:fs/promises";
import type { ErrorExtractor, ExtractionResult } from "../contracts/extraction.js";
import { errnoCode, isErrno } from "../lib/errors.js";
import { MAX_ERROR_CHARS, truncate } from "../lib/truncate.js";
import type { RunStep } from "../model/run.js";
import { log } from "../runtime/logging.js";

const extractors = new Map<string, ErrorExtractor>();

/** Load an extractor module by name, once. Resolved dynamically: `exec/` sits
 *  below `extractors/` in the layering, and the name was already validated
 *  against `listAvailableExtractors` when the definition loaded. */
async function loadExtractor(name: string): Promise<ErrorExtractor> {
  const cached = extractors.get(name);
  if (cached) return cached;
  const mod = (await import(`../extractors/${name}.js`)) as { extract: ErrorExtractor };
  extractors.set(name, mod.extract);
  return mod.extract;
}

/** Remove a previous report before rerunning so stale errors cannot be extracted or
 * hide a crash that happened before the report was written. */
export async function discardStaleReports(step: RunStep): Promise<void> {
  for (const path of step.def.report_paths ?? []) {
    try {
      await unlink(path);
    } catch (e) {
      // Missing is already clean. Other causes (permissions, read-only mount) leave
      // a stale report in place; report them or extraction may reuse the prior run's
      // errors as if they belonged to this attempt.
      if (!isErrno(e, "ENOENT")) {
        log.warn(`  report ${path} could not be removed (${errnoCode(e) ?? e}) — extraction may be stale`);
      }
    }
  }
}

/**
 * Extractor input: machine reports declared by `.report()` when written, otherwise
 * stdout. The fallback covers crashes before writing (missing command or killed
 * step), where stdout is the only usable trace.
 *
 * `reportPresent` reports which of the two happened: `true` when a declared report
 * carried text, `false` when every declared report was missing or empty, and
 * `undefined` when the step declares none, so there was nothing to find.
 */
async function extractorInput(
  step: RunStep,
  output: string,
): Promise<{ input: string; reportPresent: boolean | undefined }> {
  const paths = step.def.report_paths;
  if (!paths?.length) return { input: output, reportPresent: undefined };

  const reports: string[] = [];
  for (const path of paths) {
    const content = await readFile(path, "utf-8").catch(() => "");
    if (content.trim()) reports.push(content);
  }
  return reports.length > 0
    ? { input: reports.join("\n"), reportPresent: true }
    : { input: output, reportPresent: false };
}

export async function extractErrors(step: RunStep, output: string): Promise<ExtractionResult> {
  if (step.def.error_extractor) {
    const extractor = await loadExtractor(step.def.error_extractor);
    const { input, reportPresent } = await extractorInput(step, output);
    const result = extractor(input);
    // A declared report that was never written outranks whatever the extractor made
    // of the stdout fallback: the file is the evidence, and its absence is the fact
    // `fixOnlyWhenExtracted` acts on.
    const reportFound = reportPresent === false ? false : result.reportFound;
    // A green report with a failed step (crash after writing or make stopping on an
    // upstream target) would leave the fix prompt without an error, sending the
    // agent searching blindly.
    if (!result.errors) return { ...result, errors: truncate(output, MAX_ERROR_CHARS), reportFound };
    return { ...result, reportFound };
  }
  return { hasErrors: true, errors: truncate(output, MAX_ERROR_CHARS) };
}
