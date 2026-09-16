import type { WorkItemRef } from "../../../../contracts/index.js";
import { adfToMarkdown } from "./adf.js";

const REF_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export function findFields(root: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findFields(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!root || typeof root !== "object") return undefined;
  const node = root as Record<string, unknown>;
  const fields = node.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
  for (const value of Object.values(node)) {
    const found = findFields(value);
    if (found) return found;
  }
  return undefined;
}
export function parseAcliTicketKeys(acliJson: string): WorkItemRef[] {
  let root: unknown;
  try {
    root = parseJson(acliJson);
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const key = (node as Record<string, unknown>).key;
      if (typeof key === "string" && REF_KEY.test(key) && !seen.has(key)) {
        seen.add(key);
        found.push(key);
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(root);
  return found;
}
export function commentBodies(fields: Record<string, unknown>): string[] {
  const raw = fields.comment;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).comments)
      ? ((raw as Record<string, unknown>).comments as unknown[])
      : [];
  const bodies: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      bodies.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const comment = entry as Record<string, unknown>;
    const body = comment.body ?? comment.renderedBody ?? comment.text;
    if (typeof body === "string") bodies.push(body);
    else if (body && typeof body === "object") bodies.push(adfToMarkdown(body));
  }
  return bodies;
}
export function labelsOf(fields: Record<string, unknown>): string[] {
  const raw = fields.labels;
  return Array.isArray(raw) ? raw.filter((label): label is string => typeof label === "string") : [];
}
export function statusNameOf(fields: Record<string, unknown>): string {
  const raw = fields.status;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === "string") return name.trim();
  }
  return "";
}
export function sameStatus(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
const DONE_CATEGORY_KEY = "done";
const DONE_STATUS_NAMES: readonly string[] = ["done", "closed", "cancelled"];

function statusCategoryKeyOf(fields: Record<string, unknown>): string {
  const status = fields.status;
  const raw =
    status && typeof status === "object" && (status as Record<string, unknown>).statusCategory !== undefined
      ? (status as Record<string, unknown>).statusCategory
      : fields.statusCategory;
  if (typeof raw === "string") return raw.trim().toLowerCase();
  if (raw && typeof raw === "object") {
    const category = raw as Record<string, unknown>;
    const value = typeof category.key === "string" ? category.key : category.name;
    if (typeof value === "string") return value.trim().toLowerCase();
  }
  return "";
}

export function isDoneStatus(fields: Record<string, unknown>): boolean {
  const category = statusCategoryKeyOf(fields);
  if (category) return category === DONE_CATEGORY_KEY;
  const name = statusNameOf(fields).toLowerCase();
  return name !== "" && DONE_STATUS_NAMES.includes(name);
}
