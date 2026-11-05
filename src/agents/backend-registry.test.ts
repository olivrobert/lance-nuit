import { expect, test } from "bun:test";
import { AgentBackendRegistry, backendForFix } from "../contracts/backends.js";

test("backend registry contract does not preload built-in providers", () => {
  const registry = new AgentBackendRegistry();
  expect(registry.known()).toEqual([]);
  expect(() => registry.defaultBackendId()).toThrow(/no provider registered/);

  registry.register({
    id: "local-test",
    capabilities: {
      structuredOutput: false,
      streaming: false,
      resume: false,
      usageTokens: false,
      cost: "none",
    },
    create: () => ({
      id: "local-test",
      capabilities: {
        structuredOutput: false,
        streaming: false,
        resume: false,
        usageTokens: false,
        cost: "none" as const,
      },
      run: async () => ({ provider: "local-test", output: "", ok: true, stats: { duration_ms: 0 } }),
    }),
  });

  expect(backendForFix({ backend: undefined }, registry)).toEqual({ id: "local-test" });
});
