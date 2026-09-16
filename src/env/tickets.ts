import { existsSync } from "node:fs";
import { join } from "node:path";

/** Default work-item root — the single constant imported everywhere else. */
export const DEFAULT_SPEC_PATH = ".lance-nuit/work-items";

/**
 * Maps a ticket ID to its directory path under SPEC_PATH.
 * - "PROJ-59"                  → "PROJ-59"
 * - "PROJ-59-01"               → "PROJ-59/US-01"     (deterministic PROJ-NUM sub-US)
 * - "PROJ-59-foo"              → "PROJ-59-foo"       (non-numeric suffix = not a sub-US)
 * - "export-pdf-async-batch-01"→ "export-pdf-async-batch/US-01"
 *     (sub-US of a feature without a ticket — ONLY if <parent>/US-01 exists,
 *      otherwise flat: avoids creating an empty directory and preserves flat tickets
 *      such as "PROJ-58-ES-01" without a US breakdown).
 * - "exports/PROJ-1478"       → "exports/PROJ-1478"  (explicit work-item
 *      subdirectory path — unchanged if the directory exists; its sub-US
 *      "exports/PROJ-1478-01" use the slug branch below).
 */
export function resolveTicketDir(
  ticket: string,
  specPath: string = DEFAULT_SPEC_PATH,
  cwd: string = process.cwd(),
): string {
  const workItemsRoot = join(cwd, specPath);
  // Explicit path (ticket stored in subdirectories): takes priority over slug
  // resolution so an existing "a/b-01" directory is never misinterpreted.
  if (ticket.includes("/") && existsSync(join(workItemsRoot, ticket))) return ticket;

  // PROJ-NUM sub-US: deterministic mapping (the US directory may not exist yet).
  const m = ticket.match(/^([A-Z][A-Z0-9]*-\d+)-(\d{2,})$/);
  if (m) return `${m[1]}/US-${m[2]}`;

  // Slug sub-US: <parent>-NN → <parent>/US-NN, guarded by the filesystem to
  // distinguish a real sub-US from a flat ticket ending in -NN.
  const s = ticket.match(/^(.+)-(\d{2,})$/);
  if (s && existsSync(join(workItemsRoot, s[1], `US-${s[2]}`))) return `${s[1]}/US-${s[2]}`;

  return ticket;
}
