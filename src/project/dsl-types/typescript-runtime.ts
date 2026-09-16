// runner/project/dsl-types/typescript-runtime.ts
//
// On-demand access to the `typescript` package.
//
// `typescript` is the heaviest runtime dependency and only declaration
// generation and pipeline typechecking need it. The command registry imports
// those modules at startup, so a module-level `require` would tax every
// `lancenuit run` with the compiler's parse time. Keep the load behind a call.

import { createRequire } from "node:module";
import type * as TypeScript from "typescript";

const require = createRequire(import.meta.url);

let compiler: typeof TypeScript | undefined;

/** The `typescript` module, loaded on first use and cached for the process. */
export function loadTypeScript(): typeof TypeScript {
  if (compiler) return compiler;
  try {
    compiler = require("typescript") as typeof TypeScript;
  } catch (error) {
    throw new Error(
      "The typescript package is required to install DSL types and typecheck pipelines: npm install typescript",
      {
        cause: error,
      },
    );
  }
  return compiler;
}
