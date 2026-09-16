import { describe, expect, test } from "bun:test";
import { createFakeWorkItemGateway } from "./fake.js";
import { createDefaultWorkItemGatewayRegistry, WorkItemGatewayRegistry } from "./registry.js";

const config = {
  workItem: {
    provider: "redmine",
    project: "APP",
    todoState: "New",
    reviewState: "Review",
  },
  labels: {
    bugTodo: "auto-fix",
    featureTodo: "auto-feature",
    done: "auto-fixed",
    escalate: "needs-human",
  },
};

describe("WorkItemGatewayRegistry", () => {
  test("standalone registry includes the built-in Jira and GitHub providers", () => {
    expect(createDefaultWorkItemGatewayRegistry().known()).toEqual(["jira", "github"]);
  });

  test("resolves an explicitly registered provider", () => {
    const gateway = createFakeWorkItemGateway({ provider: "redmine" });
    const registry = new WorkItemGatewayRegistry().register({
      id: "redmine",
      create: (deps) => {
        expect(deps.workItem.project).toBe("APP");
        return gateway;
      },
    });

    expect(registry.resolve(config)).toBe(gateway);
    expect(registry.known()).toEqual(["redmine"]);
  });

  test("rejects duplicate and empty registrations", () => {
    const factory = { id: "fake", create: () => createFakeWorkItemGateway() };
    const registry = new WorkItemGatewayRegistry().register(factory);

    expect(() => registry.register(factory)).toThrow(/already registered/);
    expect(() => registry.register({ id: "  ", create: factory.create })).toThrow(/non-empty/);
  });

  test("reports unknown providers without a Jira fallback", () => {
    const registry = new WorkItemGatewayRegistry();
    expect(() => registry.resolve(config)).toThrow(/redmine/);
    expect(() => registry.resolve(config)).toThrow(/none/);
  });
});
