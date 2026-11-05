//
// Public facade for project type installation and pipeline typechecking.
//
// The implementation is split by responsibility under `src/definition/project/dsl-types/`.
// This file is its public facade.

export { ensureContractsForExtension } from "./dsl-types/contracts-package.js";
export {
  installKitTypes,
  installProjectTypes,
  installUserTypes,
} from "./dsl-types/install.js";
export type { ProjectTypesMetadata } from "./dsl-types/layout.js";
export {
  kitTsconfigPath,
  projectKitDirs,
  projectTypesDirectory,
} from "./dsl-types/layout.js";
export type { ProjectTypecheckResult } from "./dsl-types/typecheck.js";
export {
  typecheckProjectPipelines,
  typecheckUserPipelines,
} from "./dsl-types/typecheck.js";
