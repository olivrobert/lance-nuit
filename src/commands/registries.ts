// runner/commands/registries.ts
//
// Composition root for the commands that run OUTSIDE a run (`--approve-only`,
// `--lint-config`, `--lint-pipeline`, the diagnostics). They build their own
// context instead of going through boot, so they compose the built-in providers
// themselves rather than relying on a default hidden inside the layers below.
//
// `entry/registries.ts` is the equivalent for a run; the two are separate because
// `commands/` sits below `entry/` and cannot import it.

import type { AgentBackendRegistry } from "../contracts/backends.js";
import type { WorkItemGatewayRegistry } from "../contracts/registry.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.js";
import { createDefaultWorkItemGatewayRegistry } from "../modules/work-item/registry.js";

export interface CommandRegistries {
  readonly workItemRegistry: WorkItemGatewayRegistry;
  readonly agentBackendRegistry: AgentBackendRegistry;
}

/** Built-in providers, ready to be spread into `buildPipelineContext`. */
export function commandRegistries(): CommandRegistries {
  return {
    workItemRegistry: createDefaultWorkItemGatewayRegistry(),
    agentBackendRegistry: createDefaultAgentBackendRegistry(),
  };
}
