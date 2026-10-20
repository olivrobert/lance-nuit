// runner/entry/registries.ts
//
// Composition root: the only place the standalone runner names the built-in
// providers. A run and the commands outside one receive `composeRunnerRegistries`
// from here and never reach for a singleton, which is what makes a custom
// composition a single source of truth for the whole process.

import { type ComposeRegistries, loadRunnerRegistries, type RunnerRegistries } from "../boot/extensions.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.js";
import { createDefaultWorkItemGatewayRegistry } from "../modules/work-item/registry.js";

/** Built-in providers, as a fresh pair of registries the extension manifest extends. */
export function createDefaultRunnerRegistries(): RunnerRegistries {
  return { workItems: createDefaultWorkItemGatewayRegistry(), backends: createDefaultAgentBackendRegistry() };
}

/** Built-in providers extended with the manifest `config` names, resolved from `cwd`. */
export const composeRunnerRegistries: ComposeRegistries = (config, cwd) =>
  loadRunnerRegistries(config.extensions?.module, createDefaultRunnerRegistries(), cwd);
