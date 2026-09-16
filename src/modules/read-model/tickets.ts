// modules/read-model/tickets.ts
//
// Is this string a ticket of that project? The answer belongs to the project's
// work-item provider — a Jira key and a GitHub issue number look nothing alike —
// so the check goes through the same gateway the runner would build, from the
// same `config.json`. The dashboard never guesses a ticket's shape itself.
//
// The registry is a parameter: composing the built-in providers is the entry
// point's job, not the read model's.

import type { RefValidation } from "../../contracts/types.js";
import type { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import { loadPipelineConfig } from "../../env/config.js";
import { errorMessage } from "../../lib/errors.js";
import type { ProjectEntry } from "./projects.js";

/** Shape every ticket must have before it reaches a path or an argument list,
 *  whatever the provider says: one path segment, no separator, no `..`. */
const TICKET_TOKEN = /^[\w.-]+$/;

export function isTicketToken(value: unknown): value is string {
  return typeof value === "string" && TICKET_TOKEN.test(value) && value !== "." && value !== "..";
}

/**
 * Validate a ticket reference against the project's provider.
 *
 * A project whose configuration cannot be read, or whose provider is unknown,
 * refuses every ticket: the runner could not be launched there either, so the
 * refusal is the same one the reader would get a step later, only sooner.
 */
export function validateTicketRef(
  project: ProjectEntry,
  ticket: string,
  registry: WorkItemGatewayRegistry,
): RefValidation {
  if (!isTicketToken(ticket)) return { ok: false, reason: `ticket "${ticket}" is not a valid reference` };
  if (!project.found) return { ok: false, reason: `project "${project.name}" is not on disk` };
  try {
    const config = loadPipelineConfig(project.cwd);
    return registry.resolve({ workItem: config.workItem, labels: config.labels }).validateRef(ticket);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}
