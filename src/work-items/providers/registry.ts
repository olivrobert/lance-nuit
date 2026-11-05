// Runner composition facade. The registry implementation and its contracts are
// provider-neutral core API; only this file composes the built-in adapters.

import { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import { createGithubWorkItemGateway } from "./adapters/github/index.js";
import { createJiraWorkItemGateway } from "./adapters/jira/index.js";

export function createDefaultWorkItemGatewayRegistry(): WorkItemGatewayRegistry {
  return new WorkItemGatewayRegistry()
    .register({ id: "jira", create: createJiraWorkItemGateway })
    .register({ id: "github", create: createGithubWorkItemGateway });
}
