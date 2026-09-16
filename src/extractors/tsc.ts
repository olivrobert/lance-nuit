import type { ExtractionResult } from "../contracts/extraction.js";

/**
 * Extracts TypeScript compiler diagnostics from `tsc` output.
 *
 * Keeps the `file:line:col - error TSxxxx: message` lines and their indented
 * continuation lines (multi-line diagnostics), dropping progress noise and the
 * final "Found N errors" summary that carries no actionable content.
 */
export function extract(output: string): ExtractionResult {
  const lines = output.split("\n");
  const kept: string[] = [];
  let inDiagnostic = false;
  for (const line of lines) {
    if (/(^|\()\d+,\d+\)?[: ].*\b(error|warning) TS\d+:/.test(line) || /\berror TS\d+:/.test(line)) {
      kept.push(line);
      inDiagnostic = true;
      continue;
    }
    if (inDiagnostic && /^\s+\S/.test(line)) {
      kept.push(line);
      continue;
    }
    inDiagnostic = false;
  }
  const errors = kept.join("\n").trim();
  return { hasErrors: errors.length > 0, errors };
}
