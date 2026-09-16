import { FLAGS } from "../model/cli-options.js";

/**
 * Convert command failures to the same user-facing text everywhere.
 *
 * The implementation moved to `lib/errors.ts`, where every layer can reach it;
 * re-exported here so the commands that already import it are unchanged.
 */
export { errorMessage } from "../lib/errors.js";

/** CLI ticket/work-item identifiers accepted by commands that address a run. */
export function isValidTicket(ticket: string | undefined): ticket is string {
  return !!ticket && /^[\w-]+(\/[\w-]+)*$/.test(ticket);
}

/** Render a consistently aligned help section. */
export function helpSection(title: string, rows: Array<[string, string]>): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([left]) => left.length));
  return ["", `${title}:`, ...rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)];
}

/**
 * Format flags for a command's help output.
 *
 * Both runner and wrapper help expose the same flag metadata. Their only
 * difference is which flags are owned by the surrounding command registry, so
 * the filtering rule lives here instead of being copied in both renderers.
 */
export function flagRows(excluded: ReadonlySet<string>): Array<[string, string]> {
  return FLAGS.filter((flag) => !flag.hidden && !excluded.has(flag.long)).map((flag): [string, string] => {
    const names = flag.short ? `${flag.long}, ${flag.short}` : flag.long;
    const value = flag.kind === "boolean" ? "" : flag.kind === "list" ? " <a,b>" : " <value>";
    return [`${names}${value}`, flag.desc];
  });
}
