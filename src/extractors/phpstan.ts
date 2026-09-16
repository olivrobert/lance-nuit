import type { ErrorExtractor } from "../contracts/extraction.js";
import { truncate } from "../lib/truncate.js";
import { object, parseJsonReport } from "./lib/json-report.js";

/** Reads the stable `phpstan --error-format=json` shape, never the human table. */
export const extract: ErrorExtractor = (output) => {
  const report = parseJsonReport(output, (candidate) => "totals" in candidate || "files" in candidate);
  if (!report) {
    // The process may have crashed before writing the JSON. The runner keeps the
    // failed exit code either way; this raw output still helps the fix prompt.
    return { hasErrors: false, errors: truncate(output), reportFound: false };
  }

  const totals = object(report.totals);
  const files = object(report.files);
  const lines: string[] = [];

  for (const [file, value] of Object.entries(files ?? {})) {
    const messages = object(value)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const entry = object(message);
      const line = typeof entry?.line === "number" ? `:${entry.line}` : "";
      const text = typeof entry?.message === "string" ? entry.message : JSON.stringify(message);
      lines.push(`${file}${line} ${text}`);
    }
  }

  // Errors outside any file (unreadable config, broken autoload) live in
  // `errors` and count towards `totals.errors`, but never appear in `files`.
  for (const generic of Array.isArray(report.errors) ? report.errors : []) {
    lines.push(typeof generic === "string" ? generic : JSON.stringify(generic));
  }

  const totalErrors = typeof totals?.errors === "number" ? totals.errors : 0;
  const fileErrors = typeof totals?.file_errors === "number" ? totals.file_errors : 0;
  const hasErrors = totalErrors > 0 || fileErrors > 0 || lines.length > 0;
  return {
    hasErrors,
    errors: hasErrors ? truncate(lines.join("\n") || JSON.stringify(report, null, 2)) : "",
    reportFound: true,
  };
};
