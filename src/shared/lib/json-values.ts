/** Small, defensive readers for untrusted JSON event payloads. */
export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Iterate only object-valued JSONL records; malformed and blank lines vanish. */
export function* jsonRecords(raw: string): Iterable<JsonRecord> {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = asRecord(JSON.parse(line));
      if (value) yield value;
    } catch {
      // A live stream may contain a partial or non-JSON line.
    }
  }
}
