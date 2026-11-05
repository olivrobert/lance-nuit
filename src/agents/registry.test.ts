import { describe, expect, test } from "bun:test";
import { AgentBackendRegistry } from "./registry.js";

describe("AgentBackendRegistry", () => {
  test("resolves a registered backend without a provider union in the core", async () => {
    const registry = new AgentBackendRegistry().register({
      id: "fake",
      capabilities: {
        structuredOutput: true,
        streaming: false,
        resume: false,
        usageTokens: false,
        cost: "none",
      },
      create(options) {
        return {
          id: "fake",
          capabilities: this.capabilities,
          async run(request) {
            return {
              provider: "fake",
              output: `${String(options ?? "")}:${request.prompt}`,
              ok: true,
              stats: { duration_ms: 1 },
            };
          },
        };
      },
    });

    const result = await registry.resolve({ id: "fake", options: "option" }).run({ prompt: "hello" });
    expect(result.output).toBe("option:hello");
    expect(registry.known()).toEqual(["fake"]);
  });

  test("refuses duplicate and unknown providers", () => {
    const registry = new AgentBackendRegistry();
    const factory = {
      id: "fake",
      capabilities: {
        structuredOutput: false,
        streaming: false,
        resume: false,
        usageTokens: false,
        cost: "none" as const,
      },
      create: () => ({
        id: "fake",
        capabilities: factory.capabilities,
        run: async () => ({ provider: "fake", output: "", ok: true, stats: { duration_ms: 0 } }),
      }),
    };
    registry.register(factory);
    expect(() => registry.register(factory)).toThrow(/already registered/);
    expect(() => registry.resolve({ id: "missing" })).toThrow(/missing/);
  });
});
