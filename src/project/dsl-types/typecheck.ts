// runner/project/dsl-types/typecheck.ts
//
// Typechecking of project and shared-kit pipelines against their installed
// declarations.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadPipelineConfig } from "../../env/config.js";
import { userKitDir } from "../../env/kit-paths.js";
import { errorMessage } from "../../lib/errors.js";
import type { ProfileOverrides } from "../../model/profiles.js";
import { declarationsHash, diagnosticText } from "./declarations.js";
import { hasPipelines, kitTsconfigPath, kitTypesDirectory, projectKitDirs } from "./layout.js";
import { loadTypeScript } from "./typescript-runtime.js";

interface ProjectTypesPackage {
  readonly types?: string;
  readonly lanceNuitTypes?: {
    readonly sourceHash: string;
  };
}

function readMetadata(kitDir: string): ProjectTypesPackage | undefined {
  const packagePath = join(kitTypesDirectory(kitDir), "package.json");
  try {
    return JSON.parse(readFileSync(packagePath, "utf8")) as ProjectTypesPackage;
  } catch {
    return undefined;
  }
}

function staleTypesReason(kitDir: string, overrides: ProfileOverrides = {}): string | undefined {
  const typesDir = kitTypesDirectory(kitDir);
  const metadata = readMetadata(kitDir);
  if (!existsSync(join(typesDir, "project", "dsl.d.ts")) || !metadata?.lanceNuitTypes?.sourceHash) {
    return "DSL declarations are missing";
  }
  if (metadata.types !== "./project/dsl.d.ts") return "invalid DSL declarations manifest";
  if (metadata.lanceNuitTypes.sourceHash !== declarationsHash(overrides)) {
    return "stale DSL declarations";
  }
  return undefined;
}

export interface ProjectTypecheckResult {
  readonly ok: boolean;
  readonly output: string;
}

/** Typecheck pipelines in ONE kit directory using its generated tsconfig. */
export function typecheckKitPipelines(
  kitDir: string,
  displayRoot = kitDir,
  profileOverrides: ProfileOverrides = {},
): ProjectTypecheckResult {
  const root = resolve(kitDir);
  const typesReason = staleTypesReason(root, profileOverrides);
  if (typesReason) {
    return { ok: false, output: `${typesReason} (${root}). Run lancenuit types install.` };
  }

  const configPath = kitTsconfigPath(root);
  if (!existsSync(configPath)) {
    return {
      ok: false,
      output: `tsconfig missing (${relative(displayRoot, configPath) || configPath}). Run lancenuit types install.`,
    };
  }
  const ts = loadTypeScript();
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return { ok: false, output: diagnosticText(config.error, displayRoot) };
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) {
    return { ok: false, output: parsed.errors.map((d) => diagnosticText(d, displayRoot)).join("\n") };
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) {
    const count = parsed.fileNames.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")).length;
    return { ok: true, output: `Pipeline typecheck: ${count} file(s) checked.` };
  }
  return { ok: false, output: diagnostics.map((d) => diagnosticText(d, displayRoot)).join("\n") };
}

/**
 * Typecheck project pipelines across all kit directories.
 *
 * A directory without `pipelines/` is SKIPPED rather than reported green: a
 * project's empty `.lance-nuit/` is normal, and a silent “0 files checked” looks
 * too much like success.
 */
export function typecheckProjectPipelines(projectRoot = process.cwd()): ProjectTypecheckResult {
  const root = resolve(projectRoot);
  const targets = projectKitDirs(root).filter(hasPipelines);
  if (targets.length === 0) {
    return { ok: true, output: "Pipeline typecheck: no project pipelines." };
  }

  // Here invalid config FAILS — as a verdict, not as a trace.
  // Redirecting this case to an unavailable installer would be misleading: installation
  // cannot repair a hand-written file.
  let profileOverrides: ProfileOverrides;
  try {
    profileOverrides = loadPipelineConfig(root).profiles;
  } catch (e) {
    return { ok: false, output: `Invalid project config: ${errorMessage(e)}` };
  }
  const results = targets.map((target) => ({
    target,
    result: typecheckKitPipelines(target, root, profileOverrides),
  }));
  const failed = results.filter((entry) => !entry.result.ok);
  if (failed.length > 0) {
    return { ok: false, output: failed.map((entry) => entry.result.output).join("\n") };
  }
  return {
    ok: true,
    output: results
      .map((entry) => `${relative(root, entry.target) || entry.target} : ${entry.result.output}`)
      .join("\n"),
  };
}

/** Typecheck pipelines in the shared kit directory. */
export function typecheckUserPipelines(): ProjectTypecheckResult {
  const dir = userKitDir();
  if (!dir) return { ok: false, output: "User kit directory not found: neither $PIPELINE_HOME nor HOME is set." };
  if (!hasPipelines(dir)) {
    return { ok: true, output: `Pipeline typecheck: no shared pipelines in ${dir}.` };
  }
  return typecheckKitPipelines(dir);
}
