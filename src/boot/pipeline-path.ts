// runner/boot/pipeline-path.ts
//
// Boot step that resolves the pipeline. `--pipeline` accepts either a name
// (`deploy`), resolved through the kit chain like `--create`, or a path
// (`./local.ts`, `/abs/p.ts`) used as-is. Without the flag, `default` is resolved
// through the same chain.
//
// It runs after worktree setup, because chdir changes which
// `.lance-nuit/pipelines/` is visible, and before config freezes the run context.

import { isPipelineName, pipelineSearchPaths, resolveBuiltinPipeline } from "../env/builtin-pipeline.js";
import { log } from "../runtime/logging.js";
import type { BootState, BootStep } from "./boot-state.js";

export const pipelinePathStep: BootStep = {
  id: "pipeline-path",
  desc: "Resolve the pipeline to run (--pipeline name or path, otherwise the `default` pipeline).",
  // Paths need no resolution; names do. Hence this check covers both an absent
  // option and a name-based option.
  applies: (s: BootState) => !s.pipelinePath || isPipelineName(s.pipelinePath),
  run(s: BootState): Partial<BootState> {
    const name = s.pipelinePath ?? "default";
    // Use the boot state's cwd: after worktree setup it identifies the project
    // whose `.lance-nuit/pipelines/` directory must be searched.
    const resolved = resolveBuiltinPipeline(name, s.cwd);
    if (!resolved) {
      log(`Pipeline \`${name}\` not found. Searched paths, in order:`);
      for (const candidate of pipelineSearchPaths(name, s.cwd)) log(`  - ${candidate}`);
      process.exit(1);
    }
    return { pipelinePath: resolved };
  },
};
