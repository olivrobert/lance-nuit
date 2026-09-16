// runner/env/builtin-pipeline.ts
//
// Resolve a pipeline by name through the kit chain: project > user > runner
// builtin. Used by boot (pipeline `default` when --pipeline is absent) AND by
// multi-US dispatch (`commit` / `finalize` pipelines), hence env/ rather than either.
//
// HARD CONSTRAINT: resolution is FLAT (`pipelines/<name>.ts`). The `pipelines/`
// root is a reserved namespace; see docs §7.4.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../runtime/logging.js";
import { kitFileLayers, kitRoots, listKitFiles, resolveKitFile, userKitDir } from "./kit-paths.js";

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

/** Installed package base, next to the bin. */
function builtinDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function projectPipelineRelativePath(name: string): string {
  return join("pipelines", `${name}.ts`);
}

function builtinPipelinePath(name: string, base = builtinDir()): string {
  return join(base, "builtins", `${name}.ts`);
}

/** Paths consulted for a name, in order. Used in error messages: a "pipeline not
 *  found" message that does not say WHERE it searched helps nobody. */
export function pipelineSearchPaths(name: string, cwd = process.cwd()): string[] {
  const relativePath = projectPipelineRelativePath(name);
  return [...kitRoots({ cwd }).map((root) => join(root.dir, relativePath)), builtinPipelinePath(name)];
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
  const builtin = builtinPipelinePath(name);
  return existsSync(builtin) ? builtin : null;
}

/**
 * All pipelines REACHABLE by name, each resolved through the complete chain.
 *
 * Collective counterpart of `resolveBuiltinPipeline`: a tool judging "config against
 * pipelines" (see `commands/lint-config-check.ts`) must see exactly what a run would see,
 * including project homonyms; otherwise it judges a set nobody executes.
 *
 * `builtinBase` is explicit only for callers not running from the bin (lint, tests):
 * there `process.argv[1]` points to the tool, not the runner.
 */
export function listPipelineFiles(cwd = process.cwd(), builtinBase = builtinDir()): string[] {
  const names = listKitFiles("pipelines", ".ts", { cwd })
    .filter((file) => !file.includes(".test."))
    .map((file) => file.slice(0, -".ts".length))
    .filter(isPipelineName);
  try {
    for (const file of readdirSync(join(builtinBase, "builtins"))) {
      if (file.endsWith(".ts") && !file.includes(".test.")) names.push(file.slice(0, -3));
    }
  } catch {}
  const resolved: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    const relativePath = projectPipelineRelativePath(name);
    const path =
      resolveKitFile(relativePath, { cwd }) ??
      (existsSync(builtinPipelinePath(name, builtinBase)) ? builtinPipelinePath(name, builtinBase) : null);
    if (path) resolved.push(path);
  }
  return resolved;
}
