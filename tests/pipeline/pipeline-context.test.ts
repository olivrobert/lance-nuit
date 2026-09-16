// Inject the work-item gateway into the pipeline context.
//
// These tests are not about "the field exists" but "it costs nothing until used":
// `buildPipelineContext` runs on every path, including paths that never contact the tracker.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadPipelineConfig, type PipelineConfig } from "../../src/env/config.js";
import type { WorkItemArtifactStore } from "../../src/model/artifact-ports.js";
import type { PipelineLot } from "../../src/model/context.js";
import { createFakeWorkItemGateway } from "../../src/modules/work-item/fake.js";
import {
  createDefaultWorkItemGatewayRegistry,
  createWorkItemGateway,
  KNOWN_WORK_ITEM_PROVIDERS,
  WorkItemGatewayRegistry,
} from "../../src/modules/work-item/registry.js";
import { buildPipelineContext, deriveContext } from "../../src/pipeline/context.js";

/** Real repository config with only the relevant field overridden. The cast is
 *  intentional: `WorkItemConfig.provider` is typed to implemented providers, while
 *  a config file may contain any string. */
/** The context carries the registry a run would receive from boot: without it,
 *  resolving a provider fails on the missing registry instead of the provider. */
function builtInRegistry() {
  return { workItemRegistry: createDefaultWorkItemGatewayRegistry() };
}

function configWithProvider(provider: string): PipelineConfig {
  const config = loadPipelineConfig();
  return {
    ...config,
    workItem: { ...config.workItem, provider: provider as PipelineConfig["workItem"]["provider"], project: "PROJ" },
  };
}

test("workItem: default gateway resolved from config.workItem.provider", () => {
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("jira") });
  expect(ctx.workItem.provider).toBe("jira");
});

test("workItem: resolved gateway is memoized (created once)", () => {
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("jira") });
  expect(ctx.workItem).toBe(ctx.workItem);
});

test("workItem: injected gateway takes precedence over provider resolution", () => {
  const fake = createFakeWorkItemGateway({ items: [{ ref: "PROJ-24" }] });
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("jira"), workItem: fake });
  expect(ctx.workItem).toBe(fake);
  expect(ctx.workItem.provider).toBe("fake");
});

test("workItem: an injected registry resolves a custom provider lazily", () => {
  let created = 0;
  const registry = new WorkItemGatewayRegistry().register({
    id: "redmine",
    create: () => {
      created += 1;
      return createFakeWorkItemGateway({ provider: "redmine" });
    },
  });
  const ctx = buildPipelineContext({ config: configWithProvider("redmine"), workItemRegistry: registry });

  expect(created).toBe(0);
  expect(ctx.workItem.provider).toBe("redmine");
  expect(created).toBe(1);
  expect(ctx.workItem).toBe(ctx.workItem);
});

test("workItem reports an unknown provider and lists known providers", () => {
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("redmine") });
  expect(() => ctx.workItem).toThrow(/redmine/);
  for (const known of KNOWN_WORK_ITEM_PROVIDERS) {
    expect(() => ctx.workItem).toThrow(new RegExp(known));
  }
});

test("workItem: lazy construction — no gateway created without access", () => {
  // An unregistered provider makes gateway creation THROW. Building the context
  // without throwing proves no gateway was created; access does throw. This is a
  // mechanical proof of laziness without a spy.
  const config = configWithProvider("provider-qui-nexiste-pas");
  const ctx = buildPipelineContext({ ...builtInRegistry(), config, ticket: "PROJ-24" });
  expect(ctx.ticket).toBe("PROJ-24");
  expect(String(ctx.config.workItem.provider)).toBe("provider-qui-nexiste-pas");
  expect(() => createWorkItemGateway({ workItem: config.workItem, labels: config.labels })).toThrow();
  expect(() => ctx.workItem).toThrow();
});

test("workItem: explicit injection → even an unknown provider creates nothing", () => {
  const fake = createFakeWorkItemGateway();
  const ctx = buildPipelineContext({
    ...builtInRegistry(),
    config: configWithProvider("provider-qui-nexiste-pas"),
    workItem: fake,
  });
  expect(ctx.workItem).toBe(fake);
});

test("artifacts: an injected memory store is preserved", () => {
  const memory: WorkItemArtifactStore = {
    exists: async () => false,
    readText: async () => undefined,
    readJson: async () => undefined,
    writeText: async () => undefined,
    remove: async () => undefined,
  };
  const ctx = buildPipelineContext({ ...builtInRegistry(), ticket: "PROJ-24", artifacts: memory });
  expect(ctx.artifacts).toBe(memory);
  expect(deriveContext(ctx, { cwd: "/ailleurs" }).artifacts).toBe(memory);
});

//
// `{ ...context }` READS the getter and therefore creates the gateway. These tests
// lock down that trap: with the same unregistered provider, creation throws, so
// "derive without throwing" proves nothing was created.

test("deriveContext: deriving a context creates NO gateway", () => {
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("provider-qui-nexiste-pas") });
  expect(() => ({ ...ctx })).toThrow(/provider-qui-nexiste-pas/);
  expect(() => deriveContext(ctx, { cwd: "/ailleurs" })).not.toThrow();
  const derived = deriveContext(ctx, { cwd: "/ailleurs" });
  expect(derived.cwd).toBe("/ailleurs");
  // The getter remains a getter: ACCESS throws, not derivation.
  expect(() => derived.workItem).toThrow(/provider-qui-nexiste-pas/);
});

test("deriveContext: replaced fields, remaining fields and memoization shared", () => {
  const ctx = buildPipelineContext({ ...builtInRegistry(), config: configWithProvider("jira"), ticket: "PROJ-24" });
  const derived = deriveContext(ctx, { config: { ...ctx.config, specPath: "autre/racine" } });
  expect(derived.config.specPath).toBe("autre/racine");
  expect(ctx.config.specPath).not.toBe("autre/racine");
  expect(derived.ticket).toBe("PROJ-24");
  // One gateway for both: memoization lives in the original context closure, so
  // derivation does not create a second one.
  expect(derived.workItem).toBe(ctx.workItem);
});

test("deriveContext: an injected gateway survives derivation", () => {
  const fake = createFakeWorkItemGateway();
  const ctx = buildPipelineContext({
    ...builtInRegistry(),
    config: configWithProvider("provider-qui-nexiste-pas"),
    workItem: fake,
  });
  expect(deriveContext(ctx, { cwd: "/ailleurs" }).workItem).toBe(fake);
});

test("paths.reportsDir: flat outside a batch, under reports/<LOT-ID> in a batch context", () => {
  const config = configWithProvider("jira");
  const base = buildPipelineContext({ ...builtInRegistry(), cwd: "/repo", config, ticket: "PROJ-24" });
  expect(base.paths.reportsDir).toBe(join("/repo", config.specPath, "PROJ-24", "reports"));

  const lotCtx = buildPipelineContext({
    ...builtInRegistry(),
    cwd: "/repo",
    config,
    ticket: "PROJ-24",
    lot: { id: "LOT-02", title: "Analytics" } as PipelineLot,
  });
  expect(lotCtx.paths.reportsDir).toBe(join("/repo", config.specPath, "PROJ-24", "reports", "LOT-02"));
  // Artifacts remain shared by ticket; only the report is isolated.
  expect(lotCtx.paths.artifactsDir).toBe(base.paths.artifactsDir);
});

test("paths.reportsDir: an exotic lot id cannot escape the reports directory", () => {
  const config = configWithProvider("jira");
  const ctx = buildPipelineContext({
    ...builtInRegistry(),
    cwd: "/repo",
    config,
    ticket: "PROJ-24",
    lot: { id: "../../evil lot", title: "x" } as PipelineLot,
  });
  expect(ctx.paths.reportsDir).toBe(join("/repo", config.specPath, "PROJ-24", "reports", "evil-lot"));
});
