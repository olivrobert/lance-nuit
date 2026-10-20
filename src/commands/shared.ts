import type { ComposeRegistries } from "../boot/extensions.js";
import { loadPipelineConfig } from "../env/config.js";
import { FLAGS } from "../model/cli-options.js";
import type { PipelineContext } from "../model/context.js";
import { type BuildPipelineContextOptions, buildPipelineContext } from "../pipeline/context.js";

/**
 * Convert command failures to the same user-facing text everywhere.
 *
 * The implementation moved to `lib/errors.ts`, where every layer can reach it;
 * re-exported here so the commands that already import it are unchanged.
 */
export { errorMessage } from "../lib/errors.js";

/**
 * A context carrying the providers a run in the same project works with. The
 * registries are composed from the configuration the context freezes, so the
 * manifest a command loads is the one its context reports.
 */
export async function contextWithProjectProviders(
  composeRegistries: ComposeRegistries,
  options: BuildPipelineContextOptions & { cwd: string },
): Promise<PipelineContext> {
  const config = options.config ?? loadPipelineConfig(options.cwd);
  const registries = await composeRegistries(config, options.cwd);
  return buildPipelineContext({
    ...options,
    config,
    workItemRegistry: registries.workItems,
    agentBackendRegistry: registries.backends,
  });
}

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
