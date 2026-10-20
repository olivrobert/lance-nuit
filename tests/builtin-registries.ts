// The built-in providers, in the shape `buildPipelineContext` takes.
//
// For a test whose context needs providers but no project manifest. The runner
// itself composes them in `src/entry/registries.ts`, manifest included, and hands
// that composition down; nothing under `src/` builds a context from this helper.

import type { AgentBackendRegistry } from "../src/contracts/backends.ts";
import type { WorkItemGatewayRegistry } from "../src/contracts/registry.ts";
import { createDefaultRunnerRegistries } from "../src/entry/registries.ts";

export function builtinRegistries(): {
  workItemRegistry: WorkItemGatewayRegistry;
  agentBackendRegistry: AgentBackendRegistry;
} {
  const { workItems, backends } = createDefaultRunnerRegistries();
  return { workItemRegistry: workItems, agentBackendRegistry: backends };
}
