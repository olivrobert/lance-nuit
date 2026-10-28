// runner/boot/config.ts
//
// The worktree is already the cwd here, so configuration and context are frozen
// once for the whole run, including pipeline loading. Later steps read this state
// instead of re-reading the filesystem.

import { loadPipelineConfig } from "../env/config.js";
import { buildPipelineContext } from "../pipeline/context.js";
import type { BootState, BootStep } from "./boot-state.js";

export const configStep: BootStep = {
  id: "config",
  desc: "Load .lance-nuit/config.json and freeze the run PipelineContext.",
  applies: () => true,
  async run(s: BootState): Promise<Partial<BootState>> {
    const config = loadPipelineConfig(s.cwd);
    const registries = await s.composeRegistries(config, s.cwd);
    const context = buildPipelineContext({
      ticket: s.args.ticket,
      baseBranch: s.args.baseBranch,
      worktree: s.worktreeMode,
      config,
      workItemRegistry: registries.workItems,
      agentBackendRegistry: registries.backends,
    });
    return { config, registries, context };
  },
};
