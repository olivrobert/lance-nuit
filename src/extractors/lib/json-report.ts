export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/**
 * Isolates the top-level JSON objects of a noisy text stream.
 *
 * The runner merges stdout and stderr into a single buffer and appends its own
 * kill trace: a `JSON.parse` on the whole output fails on the first PHP
 * deprecation or the first progress line the tool prints.
 */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

/**
 * Returns the last JSON object of the stream that looks like the expected
 * report. The predicate avoids mistaking a `{...}` printed on the console (a
 * code excerpt in a diff, a structured error message) for the report itself.
 */
export function parseJsonReport(
  output: string,
  looksLikeReport: (candidate: JsonObject) => boolean,
): JsonObject | undefined {
  const candidates = topLevelObjects(output);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]);
    } catch {
      continue;
    }
    const report = object(parsed);
    if (report && looksLikeReport(report)) return report;
  }
  return undefined;
}
