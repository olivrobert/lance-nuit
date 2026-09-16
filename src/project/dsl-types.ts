// src/project/dsl-types.ts
//
// Public facade for project type installation and pipeline typechecking.
//
// The implementation is split by responsibility under `src/project/dsl-types/`.
// This file is its public facade and CLI entry point.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userKitDir } from "../env/kit-paths.js";
import { errorMessage } from "../lib/errors.js";
import { installProjectTypes, installUserTypes } from "./dsl-types/install.js";
import { projectKitDirs } from "./dsl-types/layout.js";
import { typecheckProjectPipelines, typecheckUserPipelines } from "./dsl-types/typecheck.js";

export {
  contractsSourceHash,
  ensureContractsForExtension,
  ensureKitContracts,
  installKitContracts,
  staleKitContractsReason,
} from "./dsl-types/contracts-package.js";
export {
  declarationsHash,
  publicDslSourceHash,
} from "./dsl-types/declarations.js";
export {
  installKitTypes,
  installProjectTypes,
  installUserTypes,
} from "./dsl-types/install.js";
export type { ProjectTypesMetadata } from "./dsl-types/layout.js";
export {
  kitContractsPackageDir,
  kitTsconfigPath,
  kitTypesDirectory,
  projectKitDirs,
  projectTsconfigPath,
  projectTypesDirectory,
} from "./dsl-types/layout.js";
export type { ProjectTypecheckResult } from "./dsl-types/typecheck.js";
export {
  typecheckKitPipelines,
  typecheckProjectPipelines,
  typecheckUserPipelines,
} from "./dsl-types/typecheck.js";

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const user = argv.includes("--user");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const mode = positional[0] ?? "install";
  const root = positional[1] ?? process.cwd();
  try {
    if (mode === "install") {
      if (user) {
        installUserTypes();
        process.stdout.write(`DSL types installed in ${userKitDir()}.\n`);
      } else {
        installProjectTypes(root);
        process.stdout.write(`DSL types installed in ${projectKitDirs(root).join(", ")}.\n`);
      }
    } else if (mode === "typecheck") {
      const result = user ? typecheckUserPipelines() : typecheckProjectPipelines(root);
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
