//
// Resolve a pipeline by name through the kit chain: project > user > runner
// builtin. Used by boot (pipeline `default` when --pipeline is absent) AND by
// multi-US dispatch (`commit` / `finalize` pipelines).
//
// HARD CONSTRAINT: resolution is FLAT (`pipelines/<name>.ts`). The `pipelines/`
// root is a reserved namespace; see docs §7.4.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_ROOT_DIR } from "../../shared/env/kit-layout.js";
import { log } from "../../shared/runtime/logging.js";
import { kitFileLayers, kitRoots, listKitFiles, resolveKitFile, userKitDir } from "../../shared/env/kit-paths.js";

/**
 * Shape of a pipeline name resolvable through the chain.
 *
 * Same expression as required at creation: `lancenuit create deploy` and then
 * `lancenuit run -p deploy` must use the same identifier. It also separates a NAME
 * from a PATH on the command line: anything containing `/`, `.`, or an uppercase
 * letter is a path.
 */
export const PIPELINE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function isPipelineName(value: string): boolean {
  return PIPELINE_NAME_RE.test(value);
}

const BUILTIN_DIR = join(RUNNER_ROOT_DIR, "definition", "builtins");

/** The pipelines the runner ships, by name. Declared rather than read from
 *  `builtins/`: a published install also holds the compiled `.js` and `.d.ts`
 *  there, which are not pipelines. */
const BUILTIN_PIPELINES: ReadonlyMap<string, string> = new Map([["default", "default.ts"]]);

function projectPipelineRelativePath(name: string): string {
  return join("pipelines", `${name}.ts`);
}

function shippedBuiltinPath(name: string): string | null {
  const file = BUILTIN_PIPELINES.get(name);
  if (!file) return null;
  const path = join(BUILTIN_DIR, file);
  return existsSync(path) ? path : null;
}

/** Paths consulted for a name, in order. Used in error messages: a "pipeline not
 *  found" message that does not say WHERE it searched helps nobody. */
export function pipelineSearchPaths(name: string, cwd = process.cwd()): string[] {
  const relativePath = projectPipelineRelativePath(name);
  const builtin = BUILTIN_PIPELINES.get(name);
  const kitPaths = kitRoots({ cwd }).map((root) => join(root.dir, relativePath));
  return builtin ? [...kitPaths, join(BUILTIN_DIR, builtin)] : kitPaths;
}

const shadowed = new Set<string>();

/**
 * A shared pipeline shadowed by a project homonym is the main trap in the three-level
 * chain: the run uses a different definition from the one the author just edited in
 * `~/.lance-nuit`. Priority does not change (the project wins), but it is reported.
 */
function warnShadowing(relativePath: string, resolved: string, cwd: string): void {
  if (shadowed.has(resolved)) return;
  const user = userKitDir();
  if (!user || resolved.startsWith(user)) return;
  const layers = kitFileLayers(relativePath, { cwd });
  const masked = layers.find((layer) => layer.startsWith(user));
  if (!masked) return;
  shadowed.add(resolved);
  log(`ℹ ${resolved} shadows shared pipeline ${masked} (the project takes priority).`);
}

/** Resolve a pipeline by name: project > user > runner builtin. */
export function resolveBuiltinPipeline(name: string, cwd = process.cwd()): string | null {
  const relativePath = projectPipelineRelativePath(name);
  const projectOrUser = resolveKitFile(relativePath, { cwd });
  if (projectOrUser) {
    warnShadowing(relativePath, projectOrUser, cwd);
    return projectOrUser;
  }
  return shippedBuiltinPath(name);
}

/**
 * All pipelines REACHABLE by name, each resolved through the complete chain.
 *
 * Collective counterpart of `resolveBuiltinPipeline`: a tool judging "config against
 * pipelines" (see `entry/commands/lint-config-check.ts`) must see exactly what a run would see,
 * including project homonyms; otherwise it judges a set nobody executes.
 */
export function listPipelineFiles(cwd = process.cwd()): string[] {
  const names = listKitFiles("pipelines", ".ts", { cwd })
    .filter((file) => !file.includes(".test."))
    .map((file) => file.slice(0, -".ts".length))
    .filter(isPipelineName);
  const resolved: string[] = [];
  for (const name of [...new Set([...names, ...BUILTIN_PIPELINES.keys()])].sort()) {
    const path = resolveKitFile(projectPipelineRelativePath(name), { cwd }) ?? shippedBuiltinPath(name);
    if (path) resolved.push(path);
  }
  return resolved;
}
