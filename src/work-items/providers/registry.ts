// Runner composition facade. The registry implementation and its contracts are
// provider-neutral core API; only this file composes the built-in adapters.

import { type WorkItemGatewayDeps, WorkItemGatewayRegistry } from "../../contracts/registry.js";
import type { WorkItemGateway } from "../../contracts/work-items.js";
import { createGithubWorkItemGateway } from "./adapters/github/index.js";
import { createJiraWorkItemGateway } from "./adapters/jira/index.js";

export type {
  WorkItemGatewayDeps,
  WorkItemGatewayFactory,
  WorkItemGatewayRegistration,
} from "../../contracts/registry.js";
export { WorkItemGatewayRegistry } from "../../contracts/registry.js";

export function createDefaultWorkItemGatewayRegistry(): WorkItemGatewayRegistry {
  return new WorkItemGatewayRegistry()
    .register({ id: "jira", create: createJiraWorkItemGateway })
    .register({ id: "github", create: createGithubWorkItemGateway });
}

export const defaultWorkItemGatewayRegistry = createDefaultWorkItemGatewayRegistry();
export const KNOWN_WORK_ITEM_PROVIDERS: readonly string[] = Object.freeze(defaultWorkItemGatewayRegistry.known());

export function createWorkItemGateway(
  deps: WorkItemGatewayDeps,
  registry: WorkItemGatewayRegistry = defaultWorkItemGatewayRegistry,
): WorkItemGateway {
  return registry.resolve(deps);
}
