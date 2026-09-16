import { expect, test } from "bun:test";
import { artifact } from "../../src/dsl/artifact.js";
import {
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  requireArtifact,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
} from "../../src/dsl/input.js";
import { bashStep } from "../../src/dsl.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../src/model/artifact-ports.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";

const ctx = buildPipelineContext();

test("skipIf/failIf/stopIf each carry their decision and reason", async () => {
  expect(await skipIf(() => false).evaluate(ctx)).toEqual({ action: "pass" });
  expect(await skipIf(() => true, "already done").evaluate(ctx)).toEqual({ action: "skip", reason: "already done" });
  expect(await failIf(() => ({ ok: true, reason: "invalid contract" })).evaluate(ctx)).toEqual({
    action: "fail",
    reason: "invalid contract",
  });
  expect(await stopIf(async () => ({ ok: true, reason: "arbitrage requis" })).evaluate(ctx)).toEqual({
    action: "stop",
    reason: "arbitrage requis",
  });
});

test("skipUnless/failUnless/stopUnless each carry their decision", async () => {
  expect(await skipUnless(() => true).evaluate(ctx)).toEqual({ action: "pass" });
  expect(await skipUnless(() => ({ ok: false, reason: "missing material" }), "fallback").evaluate(ctx)).toEqual({
    action: "skip",
    reason: "missing material",
  });
  expect(await failUnless(() => false, "contrat absent").evaluate(ctx)).toEqual({
    action: "fail",
    reason: "contrat absent",
  });
  expect(await stopUnless(async () => false, "arbitrage requis").evaluate(ctx)).toEqual({
    action: "stop",
    reason: "arbitrage requis",
  });
});

test("a boolean refusal names the guard that refused", async () => {
  const amendApplies = () => false;
  // A named predicate gives its name...
  expect(await skipUnless(amendApplies).evaluate(ctx)).toEqual({
    action: "skip",
    reason: "entry condition not satisfied: amendApplies",
  });
  // ...an inline lambda gives its source, flattened onto one line.
  const inline = await skipUnless((_ctx) => false).evaluate(ctx);
  expect(inline.action).toBe("skip");
  expect((inline as { reason: string }).reason).toStartWith("entry condition not satisfied: ");
  // An author-supplied reason already names its guard: it is left alone.
  expect(await skipUnless(amendApplies, "contrat absent").evaluate(ctx)).toEqual({
    action: "skip",
    reason: "contrat absent",
  });
});

test("a predicate exception follows the helper's local policy", async () => {
  const decision = await skipIf(() => {
    throw new Error("JSON corrompu");
  }).evaluate(ctx);
  expect(decision).toEqual({ action: "skip", reason: "JSON corrompu" });

  for (const [condition, action] of [
    [skipUnless, "skip"],
    [failUnless, "fail"],
    [stopUnless, "stop"],
  ] as const) {
    const result = await condition(() => {
      throw new Error("lecture impossible");
    }).evaluate(ctx);
    expect(result).toEqual({ action, reason: "lecture impossible" });
  }
});

test("the three positive command forms carry their policy", () => {
  expect(skipUnlessCommand("test -f plan.md")).toEqual({
    kind: "command",
    command: "test -f plan.md",
    onFailure: "skip",
  });
  expect(failUnlessCommand("test -f plan.md")).toEqual({
    kind: "command",
    command: "test -f plan.md",
    onFailure: "fail",
  });
  expect(stopUnlessCommand("test -f plan.md")).toEqual({
    kind: "command",
    command: "test -f plan.md",
    onFailure: "stop",
  });
});

function artifactContext(initial?: unknown) {
  let value = initial === undefined ? undefined : JSON.stringify(initial);
  const store: WorkItemArtifactStore = {
    exists: async () => value !== undefined,
    readText: async () => value,
    readJson: async <T>(_ref: ArtifactRef, parse: (raw: unknown) => T) =>
      value === undefined ? undefined : parse(JSON.parse(value)),
    writeText: async (_ref, next) => {
      value = next;
    },
    remove: async () => {
      value = undefined;
    },
  };
  return buildPipelineContext({ ticket: "PROJ-1", artifacts: store });
}

const triage = artifact("triage.json", (value) => {
  if (!value || typeof value !== "object") throw new Error("triage.json is invalid");
  return value;
});

test("requireArtifact applies a local policy to absence or shape", async () => {
  // The default reason reuses the `require()` message, including the expected location.
  expect(await requireArtifact(triage, fail()).evaluate(artifactContext())).toMatchObject({
    action: "fail",
    reason: expect.stringContaining("triage.json not found (expected at: "),
  });
  expect(await requireArtifact(triage, stop("triage required to resume")).evaluate(artifactContext())).toEqual({
    action: "stop",
    reason: "triage required to resume",
  });
  expect(await requireArtifact(triage).evaluate(artifactContext({ ready: true }))).toEqual({ action: "pass" });
});

test("the when factory composes multiple admissions in order", () => {
  const step = bashStep({
    id: "consumer",
    name: "Consumer",
    command: "consume",
    when: [
      { if: () => false, else: "skip" },
      { if: () => false, else: "stop" },
      { if: () => false, else: "fail" },
    ],
  }).build();
  expect(step.inputs).toHaveLength(3);
  expect(step.inputs?.map((input) => input.kind)).toEqual(["function", "function", "function"]);
});
