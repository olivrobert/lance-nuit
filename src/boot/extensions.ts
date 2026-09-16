// Explicit extension composition for the standalone runner.
//
// Provider-neutral loading is intentionally internal to the CLI. Providers do
// not self-register and no node_modules discovery occurs without an explicit
// module name in project configuration.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentBackendRegistry } from "../contracts/backends.js";
import { EXTENSION_MANIFEST_KEYS, type ExtensionManifest } from "../contracts/extensions.js";
import type { WorkItemGatewayRegistry } from "../contracts/registry.js";
import { errorMessage } from "../lib/errors.js";

/** Registries a manifest extends. The public shape of the manifest itself is
 *  `ExtensionManifest` in `lance-nuit/contracts`; this module owns its loading. */
export interface RunnerRegistries {
  readonly workItems: WorkItemGatewayRegistry;
  readonly backends: AgentBackendRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function packageNameOf(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const length = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < length || parts.slice(0, length).some((part) => !part))
    throw new Error(`Extensions: invalid package specifier "${specifier}"`);
  return { name: parts.slice(0, length).join("/"), subpath: parts.slice(length).join("/") };
}

function importTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const condition of ["import", "default", "node", "require"]) {
    const target = importTarget(value[condition]);
    if (target) return target;
  }
  return undefined;
}

function packageImportTarget(packageRoot: string, packageJson: Record<string, unknown>, subpath: string): string {
  const exportsField = packageJson.exports;
  const exportKey = subpath ? `./${subpath}` : ".";
  const target =
    typeof exportsField === "string"
      ? subpath
        ? undefined
        : exportsField
      : isRecord(exportsField)
        ? (importTarget(exportsField[exportKey]) ?? (subpath ? undefined : importTarget(exportsField)))
        : undefined;
  const relativeTarget =
    target ?? (!subpath ? (importTarget(packageJson.module) ?? importTarget(packageJson.main)) : undefined);
  if (!relativeTarget) throw new Error(`package does not export "${exportKey}"`);
  const resolvedTarget = resolve(packageRoot, relativeTarget);
  if (relative(packageRoot, resolvedTarget).split(/[\\/]/)[0] === "..")
    throw new Error("package export resolves outside its package directory");
  return resolvedTarget;
}

function resolveImportOnlyPackage(specifier: string, cwd: string): string {
  const { name, subpath } = packageNameOf(specifier);
  let directory = resolve(cwd);
  while (true) {
    const packageRoot = join(directory, "node_modules", name);
    const packageJsonPath = join(packageRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      return pathToFileURL(packageImportTarget(packageRoot, packageJson, subpath)).href;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("package was not found in node_modules");
}

function extensionSpecifier(specifier: string, cwd: string): string {
  const value = specifier.trim();
  if (!value) throw new Error("Extensions: module must be a non-empty path or package specifier");
  if (value.startsWith("file:")) return value;
  if (isAbsolute(value) || value.startsWith(".") || value.startsWith(".."))
    return pathToFileURL(isAbsolute(value) ? value : resolve(cwd, value)).href;
  try {
    const projectRequire = createRequire(join(cwd, "package.json"));
    return pathToFileURL(projectRequire.resolve(value, { paths: [cwd] })).href;
  } catch (requireError) {
    try {
      return resolveImportOnlyPackage(value, cwd);
    } catch (importError) {
      const error = importError instanceof Error ? importError : requireError;
      throw new Error(`Extensions: unable to resolve module "${specifier}" from ${cwd}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

/**
 * Absolute path of the file an extension specifier resolves to, or `undefined`
 * for a module the loader cannot map to a local file. Same resolution as the
 * import itself, so a caller preparing that file's surroundings targets the
 * module that will actually load.
 */
export function resolveExtensionFile(specifier: string, cwd: string): string | undefined {
  const url = extensionSpecifier(specifier, cwd);
  return url.startsWith("file:") ? fileURLToPath(url) : undefined;
}

async function importManifest(specifier: string, cwd: string): Promise<unknown> {
  const resolved = extensionSpecifier(specifier, cwd);
  let module: Record<string, unknown>;
  try {
    module = (await import(resolved)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Extensions: unable to import module "${specifier}" (${resolved}): ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return module.default ?? module.extensions;
}

function validateManifest(value: unknown, source: string): ExtensionManifest {
  if (!isRecord(value)) throw new Error(`Extensions: module "${source}" must default-export an object manifest`);
  const knownKeys: readonly string[] = EXTENSION_MANIFEST_KEYS;
  const unknown = Object.keys(value).filter((key) => !knownKeys.includes(key));
  if (unknown.length > 0) throw new Error(`Extensions: module "${source}" has unknown key(s): ${unknown.join(", ")}`);
  const workItems = value.workItems;
  if (workItems !== undefined && !Array.isArray(workItems))
    throw new Error(`Extensions: module "${source}" workItems must be an array`);
  for (const [index, registration] of (workItems ?? []).entries())
    if (!isRecord(registration) || typeof registration.id !== "string" || typeof registration.create !== "function")
      throw new Error(`Extensions: module "${source}" workItems[${index}] must be { id, create }`);
  const backends = value.backends;
  if (backends !== undefined && !Array.isArray(backends))
    throw new Error(`Extensions: module "${source}" backends must be an array`);
  for (const [index, factory] of (backends ?? []).entries())
    if (!isRecord(factory) || typeof factory.id !== "string" || typeof factory.create !== "function")
      throw new Error(`Extensions: module "${source}" backends[${index}] must be an AgentBackendFactory`);
  return {
    ...(workItems ? { workItems: workItems as ExtensionManifest["workItems"] } : {}),
    ...(backends ? { backends: backends as ExtensionManifest["backends"] } : {}),
  };
}

/**
 * Extend an already-composed pair of registries with an explicit manifest.
 *
 * The base comes from the caller (`entry/registries.ts` for a run): boot prepares,
 * it does not compose, so it never names the built-in providers itself.
 */
export async function loadRunnerRegistries(
  moduleSpecifier: string | undefined,
  registries: RunnerRegistries,
  cwd: string = process.cwd(),
): Promise<RunnerRegistries> {
  if (!moduleSpecifier) return registries;
  const manifest = validateManifest(await importManifest(moduleSpecifier, cwd), moduleSpecifier);
  for (const registration of manifest.workItems ?? []) registries.workItems.register(registration);
  for (const factory of manifest.backends ?? []) registries.backends.register(factory);
  return registries;
}
