import { pipelineSearchPaths } from "../env/builtin-pipeline.js";

/** Keep name-resolution failures identical across pipeline-only commands. */
export function pipelineNotFoundError(name: string, cwd: string): Error {
  return new Error(
    `Pipeline \`${name}\` not found. Searched paths:\n` +
      pipelineSearchPaths(name, cwd)
        .map((path) => `  - ${path}`)
        .join("\n"),
  );
}
