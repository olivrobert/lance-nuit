// runner/project/dsl-types/declarations.ts
//
// Generation and specialization of the declaration files installed in a kit.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type * as TypeScript from "typescript";
import type { ProfileOverrides, StepProfileName } from "../../model/profiles.js";
import { contractsSourceHash } from "./contracts-package.js";
import { RUNNER_DIR } from "./layout.js";
import { loadTypeScript } from "./typescript-runtime.js";

// The hash contains only relative names and content: no plugin-cache, version,
// or machine-path information leaks into the project. The `contracts/` directory
// is covered as a whole by `contractsSourceHash`, so the same fingerprint drives
// both the declarations and the vendored contracts package.
const PUBLIC_DSL_SOURCES = [
  "project/dsl.ts",
  "dsl.ts",
  "dsl/artifact.ts",
  "dsl/input.ts",
  "dsl/profiles.ts",
  "model/profiles.ts",
  "model/config.ts",
  "model/artifact-ports.ts",
  "model/context.ts",
  "model/artifact.ts",
  "model/persisted.ts",
  "model/input.ts",
  "model/definition.ts",
  "pipeline/context.ts",
  "builtin-steps/lib/public-work-item.ts",
  "builtin-steps/lib/work-item-steps.ts",
  "builtin-steps/lib/human-review.ts",
  "builtin-steps/lib/project-prompt.ts",
  "builtin-steps/lib/skill-preflight.ts",
] as const;

export function publicDslSourceHash(runnerDir = RUNNER_DIR): string {
  const hash = createHash("sha256");
  hash.update(contractsSourceHash(runnerDir));
  hash.update("\0");
  for (const relativePath of PUBLIC_DSL_SOURCES) {
    const sourcePath = join(runnerDir, relativePath);
    // A published install has declarations under dist/ but no TypeScript
    // sources. Hash the emitted declaration surface there; source checkouts
    // continue to hash the authoring sources themselves.
    const filePath = existsSync(sourcePath) ? sourcePath : sourcePath.replace(/\.ts$/, ".d.ts");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
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
    rootDir: RUNNER_DIR,
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
    typeRoots: [join(RUNNER_DIR, "..", "node_modules", "@types")],
  };
}

function throwOnDiagnostics(phase: string, diagnostics: readonly TypeScript.Diagnostic[], root: string): void {
  if (diagnostics.length === 0) return;
  throw new Error(`${phase}:\n${diagnostics.map((d) => diagnosticText(d, root)).join("\n")}`);
}

export function diagnosticText(diagnostic: TypeScript.Diagnostic, root: string): string {
  const ts = loadTypeScript();
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  const file = relative(root, diagnostic.file.fileName) || diagnostic.file.fileName;
  const category = ts.DiagnosticCategory[diagnostic.category]?.toLowerCase() ?? "error";
  return `${file}:${position.line + 1}:${position.character + 1} - ${category} TS${diagnostic.code}: ${message}`;
}

/** Generate declarations into a temporary output directory. */
export function generateDslDeclarations(outDir: string): void {
  if (!existsSync(join(RUNNER_DIR, "project", "dsl.ts"))) {
    if (!existsSync(join(RUNNER_DIR, "project", "dsl.d.ts"))) {
      throw new Error("DSL sources and emitted declarations are missing from this runner installation.");
    }
    copyDeclarations(RUNNER_DIR, outDir);
    return;
  }
  const ts = loadTypeScript();
  const program = ts.createProgram([join(RUNNER_DIR, "project", "dsl.ts")], compilerOptions(outDir));
  throwOnDiagnostics("Unable to generate DSL declarations", ts.getPreEmitDiagnostics(program), RUNNER_DIR);
  const emitted = program.emit();
  throwOnDiagnostics("Unable to emit DSL declarations", emitted.diagnostics, RUNNER_DIR);
}

function copyDeclarations(sourceDir: string, destinationDir: string): void {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      copyDeclarations(source, destination);
    } else if (entry.name.endsWith(".d.ts")) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source));
    }
  }
}

/** Declaration entry point installed as `@lance-nuit/dsl`. */
export const DECLARATIONS_ENTRY = join("project", "dsl.d.ts");

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
 * Covers public sources AND project profile backends: since `dsl/profiles.d.ts` is
 * specialized by configuration, a source-only hash would leave stale types after
 * a simple `pipeline.config.json` change.
 */
export function declarationsHash(overrides: ProfileOverrides = {}, runnerDir = RUNNER_DIR): string {
  return createHash("sha256")
    .update(publicDslSourceHash(runnerDir))
    .update("\0")
    .update(renderProjectProfileBackends(overrides))
    .digest("hex");
}

/** Inject configured backends into the intentionally empty interface emitted by
 * TypeScript. All other declarations remain strictly derived from public sources. */
export function specializeProjectProfileBackends(destinationDir: string, overrides: ProfileOverrides): void {
  const path = join(destinationDir, "dsl", "profiles.d.ts");
  if (!existsSync(path)) {
    throw new Error("Incomplete DSL generation: dsl/profiles.d.ts is missing");
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

// Keep the imported type in this module's declaration surface without making it
// part of the runtime module. Installers use the same metadata shape as the
// `project/dsl-types.ts` entry point.
export type { ProjectTypesMetadata } from "./layout.js";
