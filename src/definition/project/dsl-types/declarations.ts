//
// Generation and specialization of the declaration files installed in a kit.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type * as TypeScript from "typescript";
import type { ProfileOverrides, StepProfileName } from "../../../shared/language/profiles.js";
import { contractsSourceHash } from "./contracts-package.js";
import { RUNNER_ROOT_DIR } from "../../../shared/env/kit-layout.js";
import { DECLARATIONS_ENTRY } from "./layout.js";
import { diagnosticText, loadTypeScript } from "./typescript-runtime.js";

const DSL_SOURCE_ENTRY = DECLARATIONS_ENTRY.replace(/\.d\.ts$/, ".ts");

/**
 * Fingerprint of the runner's public DSL surface.
 *
 * The files are exactly those `reachableDeclarations` finds under
 * `declarationsDir`: the freshly emitted tree at install, the kit's installed
 * copy at typecheck, the same set until a source changes. Each is hashed by
 * relative name and the runner's current content, its TypeScript source in a
 * checkout and its declaration in a published install. Any change that alters
 * the set edits an import in a file already in it, so the fingerprint moves
 * without emitting again. No plugin-cache, version, or machine-path information
 * leaks into the project. The `contracts/` directory is covered as a whole by
 * `contractsSourceHash`, so the same fingerprint drives both the declarations
 * and the vendored contracts package.
 */
export function publicDeclarationsHash(declarationsDir: string, runnerDir = RUNNER_ROOT_DIR): string {
  const root = resolve(declarationsDir);
  const hash = createHash("sha256");
  hash.update(contractsSourceHash(runnerDir));
  hash.update("\0");
  const files = [...reachableDeclarations(root)].map((file) => relative(root, file)).sort();
  for (const file of files) {
    const declaration = join(runnerDir, file);
    const source = declaration.replace(/\.d\.ts$/, ".ts");
    const current = [source, declaration].find((path) => existsSync(path));
    hash.update(file);
    hash.update("\0");
    hash.update(current ? readFileSync(current) : "missing");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compilerOptions(outDir: string): TypeScript.CompilerOptions {
  const ts = loadTypeScript();
  return {
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    noEmitOnError: true,
    outDir,
    rootDir: RUNNER_ROOT_DIR,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    types: ["node", "bun"],
    // Application sources live under `src/`, while dependencies remain at the
    // repository root. Keep generated project declarations independent of the
    // source relocation.
    typeRoots: [join(RUNNER_ROOT_DIR, "..", "node_modules", "@types")],
  };
}

function throwOnDiagnostics(phase: string, diagnostics: readonly TypeScript.Diagnostic[], root: string): void {
  if (diagnostics.length === 0) return;
  throw new Error(`${phase}:\n${diagnostics.map((d) => diagnosticText(d, root)).join("\n")}`);
}

/**
 * Run `use` on a tree holding the runner's emitted declarations.
 *
 * A published install already ships them next to its JavaScript; a source
 * checkout emits them into a temporary directory, removed once `use` returns.
 */
export function withDslDeclarations<T>(use: (declarationsDir: string) => T): T {
  if (!existsSync(join(RUNNER_ROOT_DIR, DSL_SOURCE_ENTRY))) {
    if (!existsSync(join(RUNNER_ROOT_DIR, DECLARATIONS_ENTRY))) {
      throw new Error("DSL sources and emitted declarations are missing from this runner installation.");
    }
    return use(RUNNER_ROOT_DIR);
  }
  const temporary = mkdtempSync(join(tmpdir(), "lance-nuit-dsl-types-"));
  try {
    emitDslDeclarations(temporary);
    return use(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

interface SourceStamp {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface DeclarationsCache {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly sources: readonly SourceStamp[];
}

/** Memo cache of the last successful checkout emission, invalidated on any source stat change. */
let emittedDeclarationsCache: DeclarationsCache | undefined;

function isDeclarationsCacheFresh(cache: DeclarationsCache): boolean {
  for (const stamp of cache.sources) {
    try {
      const stat = statSync(stamp.path);
      if (stat.mtimeMs !== stamp.mtimeMs || stat.size !== stamp.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function collectEmittedFiles(rootDir: string, dir = rootDir, out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectEmittedFiles(rootDir, full, out);
    else if (entry.isFile()) out.set(relative(rootDir, full), readFileSync(full));
  }
  return out;
}

function writeCachedFiles(files: ReadonlyMap<string, Buffer>, outDir: string): void {
  for (const [relPath, content] of files) {
    const destination = join(outDir, relPath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

function emitDslDeclarations(outDir: string): void {
  if (emittedDeclarationsCache && isDeclarationsCacheFresh(emittedDeclarationsCache)) {
    writeCachedFiles(emittedDeclarationsCache.files, outDir);
    return;
  }
  const ts = loadTypeScript();
  const program = ts.createProgram([join(RUNNER_ROOT_DIR, DSL_SOURCE_ENTRY)], compilerOptions(outDir));
  throwOnDiagnostics("Unable to generate DSL declarations", ts.getPreEmitDiagnostics(program), RUNNER_ROOT_DIR);
  const emitted = program.emit();
  throwOnDiagnostics("Unable to emit DSL declarations", emitted.diagnostics, RUNNER_ROOT_DIR);
  const sources: SourceStamp[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes("/node_modules/") || sourceFile.fileName.includes("\\node_modules\\")) continue;
    try {
      const stat = statSync(sourceFile.fileName);
      if (stat.isFile()) sources.push({ path: sourceFile.fileName, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Skip non-filesystem virtual entries if any.
    }
  }
  emittedDeclarationsCache = { files: collectEmittedFiles(outDir), sources };
}

/**
 * Candidate paths for one relative specifier found in a declaration file.
 *
 * Emitted declarations use the NodeNext `./x.js` form, but a hand-written or
 * copied declaration may use the extensionless or directory form. Resolution
 * stays local: a bare specifier is a package, never an installed file.
 */
function declarationCandidates(fromFile: string, specifier: string): string[] {
  const base = resolve(dirname(fromFile), specifier);
  const withoutExtension = base.replace(/\.(js|ts|d\.ts)$/, "");
  return [`${withoutExtension}.d.ts`, join(withoutExtension, "index.d.ts"), base];
}

/**
 * Declaration files referenced by `file`.
 *
 * `preProcessFile` is the compiler's own scanner: it sees `import`, `export … from`,
 * dynamic `import("…")` inside inferred types, and `/// <reference>` alike, so the
 * graph never depends on a regexp that a future emit shape could defeat.
 */
function declarationDependencies(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const info = loadTypeScript().preProcessFile(source, true, true);
  const specifiers = [...info.importedFiles, ...info.referencedFiles].map((reference) => reference.fileName);
  const resolved: string[] = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const target = declarationCandidates(file, specifier).find((candidate) => existsSync(candidate));
    if (target) resolved.push(target);
  }
  return resolved;
}

/**
 * Declaration files reachable from the public entry point, by absolute path.
 *
 * Declaration emit elides runtime-only imports, so this graph is much narrower
 * than the program tsc compiled: authoring types stay, boot/dispatch/output
 * internals drop out.
 */
export function reachableDeclarations(sourceDir: string, entry = DECLARATIONS_ENTRY): Set<string> {
  const start = resolve(sourceDir, entry);
  if (!existsSync(start)) {
    throw new Error(`Incomplete DSL generation: ${entry} is missing`);
  }
  const reached = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...declarationDependencies(file));
  }
  return reached;
}

/**
 * Copy only the declarations the public entry point can reach.
 *
 * Installing the whole emitted graph put the runner's internals — stores,
 * dispatch, output, boot — inside every consuming project. Authors never
 * import them: `tsconfig.json` maps `@lance-nuit/dsl` to the entry point
 * alone.
 */
export function copyPublicDeclarations(sourceDir: string, destinationDir: string): void {
  const root = resolve(sourceDir);
  for (const file of reachableDeclarations(root)) {
    const destination = join(destinationDir, relative(root, file));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(file));
  }
}

function renderProjectProfileBackends(overrides: ProfileOverrides): string {
  const profiles = Object.entries(overrides)
    .map(([profile, config]) => [profile as StepProfileName, Object.keys(config?.backends ?? {}).sort()] as const)
    .filter(([, backends]) => backends.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (profiles.length === 0) return "export interface ProjectProfileBackends {}";

  const fields = profiles
    .map(([profile, backends]) => {
      const backendFields = backends.map((backend) => `        readonly ${JSON.stringify(backend)}: true;`).join("\n");
      return `    readonly ${JSON.stringify(profile)}: {\n${backendFields}\n    };`;
    })
    .join("\n");
  return `export interface ProjectProfileBackends {\n${fields}\n}`;
}

/**
 * Fingerprint of installed declarations.
 *
 * Covers public declarations AND project profile backends: since `definition/dsl/profiles.d.ts` is
 * specialized by configuration, a declarations-only hash would leave stale types after
 * a simple `pipeline.config.json` change.
 */
export function declarationsHash(overrides: ProfileOverrides, declarationsDir: string): string {
  return createHash("sha256")
    .update(publicDeclarationsHash(declarationsDir))
    .update("\0")
    .update(renderProjectProfileBackends(overrides))
    .digest("hex");
}

/** Inject configured backends into the intentionally empty interface emitted by
 * TypeScript. All other declarations remain strictly derived from public sources. */
export function specializeProjectProfileBackends(destinationDir: string, overrides: ProfileOverrides): void {
  const path = join(destinationDir, "definition", "dsl", "profiles.d.ts");
  if (!existsSync(path)) {
    throw new Error("Incomplete DSL generation: definition/dsl/profiles.d.ts is missing");
  }
  const declaration = readFileSync(path, "utf8");
  const specialized = declaration.replace(
    /export interface ProjectProfileBackends \{\s*\}/,
    renderProjectProfileBackends(overrides),
  );
  if (specialized === declaration && !declaration.includes("export interface ProjectProfileBackends {}")) {
    throw new Error("Incomplete DSL generation: ProjectProfileBackends interface is missing");
  }
  writeFileSync(path, specialized);
}
