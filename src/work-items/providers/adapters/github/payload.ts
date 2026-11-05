import type { WorkItemRef } from "../../../../contracts/work-items.js";

export interface GithubIssuePayload {
  title?: unknown;
  body?: unknown;
  state?: unknown;
  labels?: unknown;
  comments?: unknown;
  number?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseGithubPayload(raw: string, operation: string): GithubIssuePayload | GithubIssuePayload[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as GithubIssuePayload[];
    const object = asRecord(parsed);
    if (object) return object as GithubIssuePayload;
  } catch {
    // The caller adds the reference and provider operation to the error.
  }
  throw new Error(`github: invalid JSON response while ${operation}.`);
}

export function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((label) => {
      if (typeof label === "string") return label;
      return asRecord(label)?.name;
    })
    .filter((name): name is string => typeof name === "string");
}

export function commentBodies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((comment) => {
      if (typeof comment === "string") return comment;
      const body = asRecord(comment)?.body;
      return typeof body === "string" ? body : undefined;
    })
    .filter((body): body is string => body !== undefined);
}

export function parseGithubIssueRefs(raw: string): WorkItemRef[] {
  const parsed = parseGithubPayload(raw, "listing issues");
  const entries = Array.isArray(parsed) ? parsed : [];
  const refs: WorkItemRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const number = entry.number;
    const ref = typeof number === "number" && Number.isInteger(number) ? String(number) : number;
    if (typeof ref !== "string" || !/^\d+$/.test(ref) || Number(ref) < 1 || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function stateIsClosed(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "closed";
}
