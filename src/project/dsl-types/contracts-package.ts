// src/project/dsl-types/contracts-package.ts
//
// The `lance-nuit/contracts` package vendored into a kit directory.
//
// An extension is an ESM module inside a kit (`<project>/.lance-nuit/` or
// `~/.lance-nuit/`) that imports `lance-nuit/contracts`. Node and Bun resolve
// that specifier by walking up `node_modules/` from the extension file, so a
// shared kit — and a project without a local `lance-nuit` dependency — has no
// way to reach the contracts of the CLI that loads it. This module writes a
// self-contained copy of the contracts at `<kit>/node_modules/lance-nuit/`: the
// CLI that imports the extension is the one that wrote its contracts.
//
// The contracts are the only part of the runner emitted here. They have no
// runtime dependency and import nothing outside their own directory (`bun run
// lint` enforces both), so the copy needs no `node_modules` of its own.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type * as TypeScript from "typescript";
import { kitRoots } from "../../env/kit-paths.js";
import { CONTRACTS_PACKAGE_NAME, kitContractsPackageDir, kitNodeModulesDir, RUNNER_DIR } from "./layout.js";
import { loadTypeScript } from "./typescript-runtime.js";

const CONTRACTS_SUBDIR = "contracts";
const STAGING_PREFIX = ".lance-nuit-staging-";
/** Key of the vendored manifest that marks a package written by this module. */
const MARKER_KEY = "lanceNuitContracts";

interface VendoredManifest {
  readonly name?: string;
  readonly exports?: unknown;
  readonly [MARKER_KEY]?: { readonly sourceHash?: string };
}

export interface KitContractsMetadata {
  readonly sourceHash: string;
}

function walk(dir: string, accept: (name: string) => boolean, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, accept, base));
    else if (accept(entry.name)) files.push(relative(base, path));
  }
  return files.sort();
}

/** A source checkout carries the authoring sources; a published install only `dist/`. */
function hasContractsSources(runnerDir: string): boolean {
  return existsSync(join(runnerDir, CONTRACTS_SUBDIR, "index.ts"));
}

/**
 * Files the vendored package is derived from, relative to `<runner>/contracts`.
 *
 * Sources in a checkout (tests excluded), emitted `.js` and `.d.ts` in a
 * published install: whichever set the copy is actually produced from.
 */
export function contractsSourceFiles(runnerDir = RUNNER_DIR): string[] {
  const dir = join(runnerDir, CONTRACTS_SUBDIR);
  if (!existsSync(dir)) {
    throw new Error("Contracts sources and emitted files are missing from this runner installation.");
  }
  return hasContractsSources(runnerDir)
    ? walk(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    : walk(dir, (name) => name.endsWith(".js") || name.endsWith(".d.ts"));
}

/**
 * Fingerprint of the contracts the runner would vendor.
 *
 * Only relative names and content: no machine path or version leaks into the
 * kit. Any change to a contracts source (or, in a published install, to the
 * emitted JS or declarations) changes the hash and marks installed copies stale.
 */
export function contractsSourceHash(runnerDir = RUNNER_DIR): string {
  const hash = createHash("sha256");
  const dir = join(runnerDir, CONTRACTS_SUBDIR);
  for (const file of contractsSourceFiles(runnerDir)) {
    hash.update(file.split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function emitOptions(outDir: string, rootDir: string): TypeScript.CompilerOptions {
  const ts = loadTypeScript();
  return {
    declaration: true,
    emitDeclarationOnly: false,
    declarationMap: false,
    sourceMap: false,
    noEmitOnError: true,
    outDir,
    rootDir,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ["node", "bun"],
    typeRoots: [join(RUNNER_DIR, "..", "node_modules", "@types")],
  };
}

function diagnosticSummary(diagnostics: readonly TypeScript.Diagnostic[]): string {
  const ts = loadTypeScript();
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const file = diagnostic.file ? `${relative(RUNNER_DIR, diagnostic.file.fileName)}: ` : "";
      return `${file}TS${diagnostic.code}: ${message}`;
    })
    .join("\n");
}

/**
 * Materialize `contracts/` (JS and declarations) under `outDir`.
 *
 * A checkout compiles `src/contracts/**` with the TypeScript compiler the
 * runner already ships for declaration generation; `rootDir` pinned to the
 * contracts directory turns any import escaping it into an emit error. A
 * published install copies the files tsc emitted at build time.
 */
function emitContracts(outDir: string, runnerDir: string): void {
  const sourceDir = join(runnerDir, CONTRACTS_SUBDIR);
  const files = contractsSourceFiles(runnerDir);
  mkdirSync(outDir, { recursive: true });
  if (!hasContractsSources(runnerDir)) {
    for (const file of files) {
      const destination = join(outDir, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(sourceDir, file)));
    }
    return;
  }
  const ts = loadTypeScript();
  const program = ts.createProgram(
    files.map((file) => join(sourceDir, file)),
    emitOptions(outDir, sourceDir),
  );
  const preEmit = ts.getPreEmitDiagnostics(program);
  if (preEmit.length > 0) throw new Error(`Unable to compile contracts:\n${diagnosticSummary(preEmit)}`);
  const emitted = program.emit();
  if (emitted.diagnostics.length > 0) {
    throw new Error(`Unable to emit contracts:\n${diagnosticSummary(emitted.diagnostics)}`);
  }
}

function runnerVersion(runnerDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(runnerDir, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Manifest of the vendored package: the same subpath exports as the real one. */
function vendoredManifest(sourceHash: string, runnerDir: string): string {
  const manifest = {
    name: CONTRACTS_PACKAGE_NAME,
    version: runnerVersion(runnerDir),
    private: true,
    type: "module",
    description: "lance-nuit/contracts vendored by `lancenuit types install`. Generated: do not edit.",
    exports: {
      "./package.json": "./package.json",
      "./contracts": { types: "./contracts/index.d.ts", import: "./contracts/index.js" },
      "./contracts/*": { types: "./contracts/*.d.ts", import: "./contracts/*.js" },
    },
    [MARKER_KEY]: { sourceHash },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readVendoredManifest(packageDir: string): VendoredManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as VendoredManifest;
  } catch {
    return undefined;
  }
}

/**
 * Refuse to replace anything this module did not write.
 *
 * `node_modules/lance-nuit` may be a symlink to a checkout (`file:` dependency)
 * or a package installed by a package manager. Both belong to the user;
 * overwriting them would silently destroy their setup.
 */
function assertReplaceable(packageDir: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(packageDir);
  } catch {
    return;
  }
  const refusal = `Refusing to replace ${packageDir}: it was not written by lancenuit types install.`;
  if (stat.isSymbolicLink())
    throw new Error(`${refusal} It is a symbolic link; remove it to let the runner vendor its contracts.`);
  if (!stat.isDirectory()) throw new Error(`${refusal} It is not a directory.`);
  if (!readVendoredManifest(packageDir)?.[MARKER_KEY]) {
    throw new Error(
      `${refusal} Its package.json carries no "${MARKER_KEY}" marker; remove it to let the runner vendor its contracts.`,
    );
  }
}

/** Leftovers of an interrupted installation: never a destination, always safe to drop. */
function dropStaleStaging(nodeModules: string): void {
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith(STAGING_PREFIX)) rmSync(join(nodeModules, entry), { recursive: true, force: true });
  }
}

/**
 * `node_modules/` inside a kit ignores itself, so a kit whose `.gitignore`
 * predates the vendored package still shows a clean tree.
 */
function ensureSelfIgnored(nodeModules: string): void {
  const path = join(nodeModules, ".gitignore");
  if (existsSync(path) && readFileSync(path, "utf8") === "*\n") return;
  writeFileSync(path, "*\n");
}

/**
 * Write (or rewrite) the vendored contracts package of ONE kit directory.
 *
 * The package is built in a staging directory beside its destination — same
 * filesystem — then swapped in with `rename`, so an interrupted install leaves
 * either the previous package or the new one, never a half-written tree that
 * would break every `lance-nuit/contracts` import.
 */
export function installKitContracts(kitDir: string, runnerDir = RUNNER_DIR): KitContractsMetadata {
  const root = resolve(kitDir);
  const nodeModules = kitNodeModulesDir(root);
  const destination = kitContractsPackageDir(root);
  mkdirSync(nodeModules, { recursive: true });
  ensureSelfIgnored(nodeModules);
  dropStaleStaging(nodeModules);
  const sourceHash = contractsSourceHash(runnerDir);
  const staging = mkdtempSync(join(nodeModules, STAGING_PREFIX));
  try {
    emitContracts(join(staging, CONTRACTS_SUBDIR), runnerDir);
    if (!existsSync(join(staging, CONTRACTS_SUBDIR, "index.js"))) {
      throw new Error("Incomplete contracts generation: contracts/index.js is missing");
    }
    writeFileSync(join(staging, "package.json"), vendoredManifest(sourceHash, runnerDir));

    assertReplaceable(destination);
    const previous = `${staging}.previous`;
    const hadPrevious = existsSync(destination);
    if (hadPrevious) renameSync(destination, previous);
    renameSync(staging, destination);
    if (hadPrevious) rmSync(previous, { recursive: true, force: true });
    return { sourceHash };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Why the vendored package of `kitDir` cannot serve the current runner, or
 * `undefined` when it is installed and current.
 *
 * Only inspects the manifest: this runs at boot, before an extension import,
 * and must cost a file read, not a compilation.
 */
export function staleKitContractsReason(kitDir: string, runnerDir = RUNNER_DIR): string | undefined {
  const packageDir = kitContractsPackageDir(kitDir);
  const manifest = readVendoredManifest(packageDir);
  if (!manifest) return "contracts package is missing";
  const marker = manifest[MARKER_KEY];
  if (!marker || manifest.name !== CONTRACTS_PACKAGE_NAME) return undefined; // not ours: never touched
  if (!existsSync(join(packageDir, CONTRACTS_SUBDIR, "index.js"))) return "contracts package is incomplete";
  if (marker.sourceHash !== contractsSourceHash(runnerDir)) return "contracts package is stale";
  return undefined;
}

/**
 * Make the vendored package of `kitDir` match the running CLI.
 *
 * Reinstalls when the package is missing, incomplete, or written from other
 * contracts; leaves a user-owned `node_modules/lance-nuit` alone. Returns
 * `true` when something was (re)written.
 */
export function ensureKitContracts(kitDir: string, runnerDir = RUNNER_DIR): boolean {
  if (!staleKitContractsReason(kitDir, runnerDir)) return false;
  installKitContracts(kitDir, runnerDir);
  return true;
}

/**
 * The kit directory an extension module lives in, or `undefined` when the
 * module sits outside every kit (a project-level file or an npm package: its
 * imports resolve through the project's own `node_modules`, as before).
 */
export function enclosingKitDir(
  modulePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const file = resolve(modulePath);
  for (const root of kitRoots({ cwd, env })) {
    const inside = relative(root.dir, file);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return root.dir;
  }
  return undefined;
}

/**
 * Before an extension is imported: its kit's contracts must be the running
 * CLI's. Nothing happens for a module outside every kit.
 */
export function ensureContractsForExtension(
  modulePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const kitDir = enclosingKitDir(modulePath, cwd, env);
  if (!kitDir) return undefined;
  ensureKitContracts(kitDir);
  return kitDir;
}
