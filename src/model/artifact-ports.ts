// runner/model/artifact-ports.ts
//
// Artifact identity and its storage port. Identity is logical: an adapter may
// keep a local location, but location is never part of the reference.

export interface ArtifactRef {
  ticket: string;
  name: string;
}

export interface ArtifactRefInput {
  ticket: string;
  name: string;
}

export interface WorkItemArtifactStore {
  exists(ref: ArtifactRef): Promise<boolean>;
  readText(ref: ArtifactRef): Promise<string | undefined>;
  readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined>;
  writeText(ref: ArtifactRef, value: string): Promise<void>;
  remove(ref: ArtifactRef): Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

export function isLogicalSegment(value: unknown): value is string {
  return isNonEmptyText(value) && /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** Ticket IDs and artifact names share the same relative, traversal-free path
 * grammar. Keep one validator so the two reference constructors cannot drift. */
export function isSafeRelativeName(value: unknown): value is string {
  if (!isNonEmptyText(value) || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  return value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isLocalPath(value: unknown): value is string {
  return isNonEmptyText(value);
}

/** Shared by every reference constructor of `model/`: reject a value that does
 *  not satisfy the logical grammar, naming the field. */
export function required(value: unknown, field: string, predicate: (value: unknown) => value is string): string {
  if (!predicate(value)) throw new TypeError(`${field} must be a non-empty safe logical value`);
  return value;
}

export function optional(
  value: unknown,
  field: string,
  predicate: (value: unknown) => value is string,
): string | undefined {
  if (value === undefined) return undefined;
  return required(value, field, predicate);
}

/** Verify an artifact without interpreting `name` as a local path. */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value) && isSafeRelativeName(value.ticket) && isSafeRelativeName(value.name);
}

export function createArtifactRef(input: ArtifactRefInput): ArtifactRef;
export function createArtifactRef(ticket: string, name: string): ArtifactRef;
export function createArtifactRef(inputOrTicket: ArtifactRefInput | string, name?: string): ArtifactRef {
  const input = typeof inputOrTicket === "string" ? { ticket: inputOrTicket, name } : inputOrTicket;
  if (!isRecord(input)) throw new TypeError("Invalid ArtifactRef");
  return {
    ticket: required(input.ticket, "artifact.ticket", isSafeRelativeName),
    name: required(input.name, "artifact.name", isSafeRelativeName),
  };
}
