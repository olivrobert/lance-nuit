// Conformance of the three boot registries — following the model of
// pipelines.test.ts, which already discovers pipelines. These tests catch a flag
// collision between registries, a strategy or command `flag` missing from FLAGS
// (and therefore never parsed), and a key matching nothing in RunnerArgs.

import { expect, test } from "bun:test";
import { BOOT } from "../../src/boot/step.ts";
import { COMMANDS } from "../../src/commands/command.ts";
import { DISPATCH } from "../../src/dispatch/strategy.ts";
import { AgentBackendRegistry } from "../../src/engine/registry.ts";
import { requireAgentBackendRegistry } from "../../src/model/context.ts";
import { buildPipelineContext } from "../../src/pipeline/context.ts";
import { FLAGS, flagSpec } from "../../src/model/cli-options.ts";
import { parseRunnerArgs } from "../../src/cli/parse.ts";

test("FLAGS contains no long-flag or short-alias collisions", () => {
  const names = FLAGS.flatMap((f) => (f.short ? [f.long, f.short] : [f.long]));
  expect(new Set(names).size).toBe(names.length);
});

test("BOOT, DISPATCH, and COMMANDS contain no ID collisions", () => {
  for (const registry of [BOOT, DISPATCH, COMMANDS]) {
    const ids = registry.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("every flag declared by a command or strategy exists in FLAGS", () => {
  const declared = [
    ...COMMANDS.map((c) => c.flag),
    ...DISPATCH.map((s) => s.flag).filter((f): f is string => f != null),
  ];
  expect(new Set(declared).size).toBe(declared.length);
  for (const flag of declared) expect(flagSpec(flag)).toBeDefined();
});

test("a command key is a boolean field of RunnerArgs", () => {
  const args = parseRunnerArgs([]);
  for (const command of COMMANDS) {
    expect(args[command.key]).toBe(false);
    expect(flagSpec(command.flag)!.kind).toBe("boolean");
    expect(flagSpec(command.flag)!.key).toBe(command.key as never);
  }
});

test("every registry entry has a non-empty description", () => {
  for (const entry of [...BOOT, ...COMMANDS, ...DISPATCH, ...FLAGS]) {
    expect(entry.desc.length).toBeGreaterThan(0);
  }
});

test("a strategy that forbids a positional ticket has its usage message", () => {
  for (const strategy of DISPATCH) {
    if (strategy.ticket === "forbidden") expect(strategy.ticketError).toBeTruthy();
  }
});

test("an option claimed by a command names that command's own flag", () => {
  // `commands: ["create"]` is what makes --create accept an option; a typo there
  // would silently make the option foreign to every command instead.
  const claimed = FLAGS.filter((f) => f.commands?.length);
  const commandFlags = new Set(COMMANDS.map((c) => c.flag));
  for (const spec of claimed) {
    expect(spec.commands!.length).toBeGreaterThan(0);
    for (const scope of spec.commands!) expect(commandFlags.has(`--${scope}`)).toBe(true);
  }
});

test("the backend registry is read from the context, and its absence is loud", () => {
  const custom = new AgentBackendRegistry();
  const withRegistry = buildPipelineContext({ cwd: process.cwd(), agentBackendRegistry: custom });
  const withoutRegistry = buildPipelineContext({ cwd: process.cwd() });

  // A context built by boot carries the registry boot composed: it is the single
  // source of truth for the whole run.
  expect(requireAgentBackendRegistry(withRegistry)).toBe(custom);
  // A context nobody attached a registry to has no built-in composition to fall
  // back on: the caller forgot to compose one, and must hear about it.
  expect(() => requireAgentBackendRegistry(withoutRegistry)).toThrow(
    /no agent backend registry attached to the pipeline context/,
  );
});
