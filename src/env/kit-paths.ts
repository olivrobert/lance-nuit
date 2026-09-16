// runner/env/kit-paths.ts
//
// SINGLE resolution chain for kit files: project > user > builtin.
//
// Before this module, each family reimplemented its own two-level chain
// (`env/builtin-pipeline.ts` for pipelines and `env/config.ts` for config). The
// USER level (`~/.lance-nuit`) is added here once,
// not three times.
//
// `.lance-nuit/` contains the project kit and runner-owned state. Claude Code
// assets remain in `.claude/` and are resolved by the Claude integration only.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Project kit directory: the committed source. */
export const KIT_DIR = ".lance-nuit";
export const CONFIG_FILE = "config.json";

export type KitRootKind = "project" | "user";

export interface KitRoot {
  readonly kind: KitRootKind;
  readonly dir: string;
}

export interface KitLookupOptions {
  readonly cwd?: string;
  /**
   * Base directory for files shipped with the kit, OUTSIDE the kit-directory chain:
   * builtins do not follow the `.lance-nuit/` layout (pipelines live in
   * `runner/builtins`), so each caller supplies
   * the base to which the same subpath is joined. `null`/absent = no builtin.
   */
  readonly builtinDir?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Kit directory shared across projects.
 *
 * `$PIPELINE_HOME` names the directory ITSELF (not a home directory to which
 * `.lance-nuit` should be appended). This lets tests point to a disposable root
 * instead of the machine's real `~/.lance-nuit`, whose contents would change discovery
 * assertions.
 */
export function userKitDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.PIPELINE_HOME?.trim();
  if (override) return resolve(override);
  const home = homedir();
  return home ? join(home, KIT_DIR) : null;
}

/** Canonical kit directory for a project. */
export function projectKitDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), KIT_DIR);
}

/**
 * Project root enclosing `cwd` when `cwd` has drifted INSIDE a kit directory.
 *
 * Every runner-owned path — the kit, `work-items/`, `pipeline-history/`,
 * `runner.lock` — is `cwd` joined to `.lance-nuit`. A shell whose directory sits in
 * an existing kit (a `cd` into `work-items/PROJ-1/artifacts` left in place by an
 * earlier command) therefore builds a SECOND, nested kit instead of failing: the run
 * writes its own history, its lock is invisible to the real one, and it dies later on
 * an artifact whose path contains `.lance-nuit` twice.
 *
 * `null` when `cwd` is legitimate. A worktree lives under `~/.lance-nuit/worktrees/`
 * and so carries the marker in its own path, but it is a checkout owning a kit —
 * hence the `existsSync` exemption, which a path test alone could not express.
 */
export function enclosingKitProjectRoot(cwd: string = process.cwd()): string | null {
  const absolute = resolve(cwd);
  if (existsSync(join(absolute, KIT_DIR))) return null;
  const segments = absolute.split(sep);
  // The NEAREST marker: a worktree kit nested under the user kit must report the
  // worktree as the root, not the home directory that happens to contain both.
  const marker = segments.lastIndexOf(KIT_DIR);
  if (marker < 0) return null;
  return segments.slice(0, marker).join(sep) || sep;
}

/**
 * Kit roots in priority order.
 *
 * INVARIANT — the project always wins over the shared user kit.
 */
export function kitRoots(options: KitLookupOptions = {}): KitRoot[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const user = userKitDir(options.env);
  const roots: KitRoot[] = [{ kind: "project", dir: join(cwd, KIT_DIR) }];
  if (user) roots.push({ kind: "user", dir: user });
  return roots;
}

/**
 * First existing file in the chain, including builtins. `null` if none exists.
 *
 * `relativePath` is the SAME across all roots (`pipelines/deploy.ts`,
 * `pipelines/deploy.ts`): only the base changes, never the subpath.
 */
export function resolveKitFile(relativePath: string, options: KitLookupOptions = {}): string | null {
  for (const root of kitRoots(options)) {
    const candidate = join(root.dir, relativePath);
    if (!existsSync(candidate)) continue;
    return candidate;
  }
  const { builtinDir } = options;
  if (builtinDir) {
    const builtin = join(builtinDir, relativePath);
    if (existsSync(builtin)) return builtin;
  }
  return null;
}

/**
 * Existing paths in the chain, from lowest to HIGHEST priority.
 *
 * The order is intentionally reversed: it is the order in which overrides are
 * layered (the user config supplies defaults, the project decides).
 */
export function kitFileLayers(relativePath: string, options: KitLookupOptions = {}): string[] {
  const layers: string[] = [];
  const { builtinDir } = options;
  if (builtinDir) {
    const builtin = join(builtinDir, relativePath);
    if (existsSync(builtin)) layers.push(builtin);
  }
  for (const root of kitRoots(options).reverse()) {
    const candidate = join(root.dir, relativePath);
    if (!existsSync(candidate)) continue;
    layers.push(candidate);
  }
  return layers;
}

/** Discovery is opportunistic: a missing root contributes zero files. */
function namesIn(dir: string, suffix: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((name) => name.endsWith(suffix));
  } catch {
    // Kit discovery is best effort: missing or unreadable roots contribute no files.
    return [];
  }
}

/**
 * Union of file names in a subdirectory across the entire chain, including builtins.
 * Callers define the subdirectory and suffix; names are deduplicated, then each is
 * RESOLVED again through `resolveKitFile`.
 */
export function listKitFiles(subdir: string, suffix: string, options: KitLookupOptions = {}): string[] {
  const names = new Set<string>();
  const { builtinDir } = options;
  if (builtinDir) for (const name of namesIn(join(builtinDir, subdir), suffix)) names.add(name);
  for (const root of kitRoots(options)) {
    for (const name of namesIn(join(root.dir, subdir), suffix)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Relative path of the config file to NAME in an error message.
 *
 * Errors always point to the project's canonical location.
 */
export function configFileLabel(cwd: string = process.cwd()): string {
  for (const root of kitRoots({ cwd })) {
    if (root.kind !== "project") continue;
    if (existsSync(join(root.dir, CONFIG_FILE))) return `${KIT_DIR}/${CONFIG_FILE}`;
  }
  return `${KIT_DIR}/${CONFIG_FILE}`;
}
