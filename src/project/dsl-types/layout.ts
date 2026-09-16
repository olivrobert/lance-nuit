// src/project/dsl-types/layout.ts
//
// Paths and discovery for the generated TypeScript surface installed in a kit
// directory. A kit can be the canonical project `.lance-nuit/` directory or the
// shared user directory (`~/.lance-nuit`).

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectKitDir } from "../../env/kit-paths.js";

// This module lives one directory below `project/`, hence the extra dirname
// compared with the `project/dsl-types.ts` entry point.
export const RUNNER_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const TYPES_SUBDIR = ".lance-nuit-types";
export const TSCONFIG_NAME = "tsconfig.json";
export const PIPELINES_SUBDIR = "pipelines";
/** Package name under which the vendored contracts are resolvable from a kit. */
export const CONTRACTS_PACKAGE_NAME = "lance-nuit";
export const NODE_MODULES_SUBDIR = "node_modules";
// Generated surface plus every runtime state directory the runner writes under
// the kit: without them the second fresh run finds a dirty tree and refuses.
export const GITIGNORE_ENTRIES = [
  `/${TYPES_SUBDIR}/`,
  `/${TSCONFIG_NAME}`,
  `/${NODE_MODULES_SUBDIR}/`,
  "/state/",
  "/runs/",
  "/run/",
  "/history/",
  "/pipeline-history/",
  "/work-items/",
  "/logs/",
  "/tmp/",
];

export interface ProjectTypesMetadata {
  readonly sourceHash: string;
}

export function kitTypesDirectory(kitDir: string): string {
  return join(resolve(kitDir), TYPES_SUBDIR);
}

export function kitTsconfigPath(kitDir: string): string {
  return join(resolve(kitDir), TSCONFIG_NAME);
}

/** `node_modules/` a kit owns: it holds only the vendored contracts package. */
export function kitNodeModulesDir(kitDir: string): string {
  return join(resolve(kitDir), NODE_MODULES_SUBDIR);
}

/** The vendored `lance-nuit` package an extension in the kit resolves. */
export function kitContractsPackageDir(kitDir: string): string {
  return join(kitNodeModulesDir(kitDir), CONTRACTS_PACKAGE_NAME);
}

/** Project kit directory that carries canonical declarations. */
export function projectTypesDirectory(projectRoot: string): string {
  return kitTypesDirectory(projectKitDir(projectRoot));
}

export function projectTsconfigPath(projectRoot: string): string {
  return kitTsconfigPath(projectKitDir(projectRoot));
}

/**
 * A kit directory participates in typechecking when it contains at least one
 * `.ts` file under `pipelines/`.
 *
 * The directory alone is not enough: `pipelines/` is CREATED by installation
 * (and may contain only `prompts/*.md`). tsc would then fail with “No inputs were
 * found”, a red result that says nothing about a project with no pipeline.
 */
export function hasPipelines(kitDir: string): boolean {
  const dir = join(kitDir, PIPELINES_SUBDIR);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { recursive: true }).some(
      (entry) => typeof entry === "string" && entry.endsWith(".ts") && !entry.endsWith(".d.ts"),
    );
  } catch {
    return false;
  }
}

/**
 * Project kit directories to equip.
 *
 * The canonical `.lance-nuit/` is always included: this is where project
 * pipelines are created and typechecked.
 */
export function projectKitDirs(projectRoot: string): string[] {
  return [projectKitDir(projectRoot)];
}
