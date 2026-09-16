// runner/boot/config.ts
//
// The worktree is already the cwd here, so configuration and context are frozen
// once for the whole run, including pipeline loading. Later steps read this state
// instead of re-reading the filesystem.

import { loadPipelineConfig } from "../env/config.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { ensureContractsForExtension } from "../project/dsl-types/contracts-package.js";
import type { BootState, BootStep } from "./boot-state.js";
import { loadRunnerRegistries, resolveExtensionFile } from "./extensions.js";

/**
 * An extension inside a kit imports `lance-nuit/contracts` from the package
 * vendored in that kit. It has to be the running CLI's copy — missing after a
 * clone, stale after a CLI update — so it is checked here, before the import
 * that would otherwise load an older contract or fail to resolve.
 */
function prepareExtensionContracts(moduleSpecifier: string, cwd: string): void {
  const file = resolveExtensionFile(moduleSpecifier, cwd);
  if (!file) return;
  ensureContractsForExtension(file, cwd);
}

export const configStep: BootStep = {
  id: "config",
  desc: "Load .lance-nuit/config.json and freeze the run PipelineContext.",
  applies: () => true,
  async run(s: BootState): Promise<Partial<BootState>> {
    const config = loadPipelineConfig(s.cwd);
    if (config.extensions?.module) prepareExtensionContracts(config.extensions.module, s.cwd);
    const registries = await loadRunnerRegistries(config.extensions?.module, s.baseRegistries, s.cwd);
    const context = buildPipelineContext({
      ticket: s.args.ticket,
      baseBranch: s.args.baseBranch,
      config,
      workItemRegistry: registries.workItems,
      agentBackendRegistry: registries.backends,
    });
    return { config, registries, context };
  },
};
