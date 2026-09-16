// runner/state/run-snapshot.ts
//
// Defensive run snapshot reader. Consumers add their own business rules afterward
// (resume, completion, escalation, diagnostics, and so on).
//
// The shape itself lives in `schema.ts`. This module keeps the reader contract:
// a missing, corrupt, or differently formatted file yields null, never an error.

import { lstatSync, readFileSync } from "node:fs";
import { errnoCode, isErrno } from "../lib/errors.js";
import { parseRunSnapshot, type RunSnapshot, type RunSnapshotInput } from "./schema.js";

export { diagnoseRunSnapshot, type RunSnapshot, type RunSnapshotInput } from "./schema.js";

/** Validate the durable structure every reader relies on. Optional fields stay
 * optional: a snapshot may omit them. The
 * value is judged, not normalized: use `readRunSnapshot` for the shape readers
 * consume. */
export function isRunSnapshot(value: unknown): value is RunSnapshotInput {
  return parseRunSnapshot(value) !== null;
}

/** Filesystem boundary kept injectable so permission failures do not depend on
 * the user running tests as a non-root account. */
export interface RunSnapshotReader {
  readFile(path: string): string;
}

const filesystemReader: RunSnapshotReader = { readFile: (path) => readFileSync(path, "utf-8") };

/** Check for a snapshot entry without following a symlink. A dangling symlink
 * is damaged persisted state, not a vacant directory safe to initialize. */
export function hasRunSnapshotEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Treat an inspection failure conservatively: the diagnostic read below
    // will report it instead of permitting an overwrite.
    return !isErrno(error, "ENOENT");
  }
}

export type RunSnapshotDiagnostic =
  | { kind: "absent"; path: string }
  | { kind: "unreadable"; path: string; reason: "io" | "json" | "schema"; diagnostic: string }
  | { kind: "incompatible"; path: string; reason: "schema-version"; diagnostic: string }
  | { kind: "valid"; path: string; snapshot: RunSnapshot };

export type InvalidRunSnapshotDiagnostic = Exclude<RunSnapshotDiagnostic, { kind: "valid" }>;

/** Safe wording shared by execution selectors. It intentionally contains no
 * parsed snapshot values. */
export function describeRunSnapshotProblem(diagnostic: InvalidRunSnapshotDiagnostic): string {
  if (diagnostic.kind === "absent") return "is missing";
  if (diagnostic.kind === "incompatible") return "uses an unsupported schema version";
  return `is unreadable (${diagnostic.diagnostic})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a snapshot for execution selection. Unlike the tolerant reader below,
 * this preserves why a selected file cannot safely be resumed.
 */
export function readRunSnapshotDiagnostic(
  path: string,
  reader: RunSnapshotReader = filesystemReader,
): RunSnapshotDiagnostic {
  let raw: string;
  try {
    raw = reader.readFile(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "absent", path };
    const code = errnoCode(error);
    return { kind: "unreadable", path, reason: "io", diagnostic: `cannot read snapshot (${code ?? "I/O error"})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", path, reason: "json", diagnostic: "invalid JSON" };
  }
  if (isRecord(parsed) && "schemaVersion" in parsed && parsed.schemaVersion !== 1) {
    return { kind: "incompatible", path, reason: "schema-version", diagnostic: "unsupported schema version" };
  }
  const snapshot = parseRunSnapshot(parsed);
  return snapshot
    ? { kind: "valid", path, snapshot }
    : { kind: "unreadable", path, reason: "schema", diagnostic: "malformed run snapshot" };
}

/** Read a run snapshot, normalized (`retries` defaults to 0); a missing, corrupt,
 * or differently formatted file yields null. */
export function readRunSnapshot(path: string): RunSnapshot | null {
  const result = readRunSnapshotDiagnostic(path);
  return result.kind === "valid" ? result.snapshot : null;
}
