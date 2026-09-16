// runner/entry/registries.ts
//
// Composition root for a run: the only place the standalone runner names the
// built-in providers. Everything below `entry/` receives the registries it needs
// and never reaches for a singleton, which is what makes a custom composition a
// single source of truth for the whole run.

import type { RunnerRegistries } from "../boot/extensions.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.js";
import { createDefaultWorkItemGatewayRegistry } from "../modules/work-item/registry.js";

/** Built-in providers, as a fresh pair of registries the extension manifest extends. */
export function createDefaultRunnerRegistries(): RunnerRegistries {
  return { workItems: createDefaultWorkItemGatewayRegistry(), backends: createDefaultAgentBackendRegistry() };
}
