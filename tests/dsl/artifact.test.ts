import { expect, test } from "bun:test";
import { artifact, textArtifact } from "../../src/dsl/artifact.js";
import { bashStep } from "../../src/dsl.js";
import type { WorkItemArtifactStore } from "../../src/model/artifact-ports.js";
import type { PipelineContext } from "../../src/model/context.js";

function fixture(initial?: unknown) {
  let value = initial === undefined ? undefined : JSON.stringify(initial);
  const store: WorkItemArtifactStore = {
    exists: async () => value !== undefined,
    readText: async () => value,
    readJson: async (_ref, parse) => (value === undefined ? undefined : parse(JSON.parse(value))),
    writeText: async (_ref, next) => {
      value = next;
    },
    remove: async () => {
      value = undefined;
    },
  };
  return {
    ctx: { ticket: "PROJ-1", artifacts: store } as PipelineContext,
  };
}

/** Same store as `fixture`, but backed by raw text (no JSON.stringify). */
function textFixture(initial?: string) {
  let value = initial;
  const store: WorkItemArtifactStore = {
    exists: async () => value !== undefined,
    readText: async () => value,
    readJson: async (_ref, parse) => (value === undefined ? undefined : parse(JSON.parse(value))),
    writeText: async (_ref, next) => {
      value = next;
    },
    remove: async () => {
      value = undefined;
    },
  };
  return { ctx: { ticket: "PROJ-1", artifacts: store } as PipelineContext };
}

const triage = artifact("triage.json", (value) => {
  if (!value || typeof value !== "object") throw new Error("triage.json is invalid");
  return value as { verdict?: string };
});

test("artifact links its name and parser to reusable typed reads", async () => {
  const { ctx } = fixture({ verdict: "proceed" });
  expect(triage.name).toBe("triage.json");
  expect(await triage.read(ctx)).toEqual({ verdict: "proceed" });
  expect((await triage.require(ctx)).verdict).toBe("proceed");
});

test("artifact.read tolerates absence and require reports it explicitly", async () => {
  const { ctx } = fixture();
  expect(await triage.read(ctx)).toBeUndefined();
  expect(triage.require(ctx)).rejects.toThrow("triage.json not found");
});

test("artifact preserves parser errors and can remove through the store", async () => {
  const invalid = fixture("not an object");
  expect(triage.read(invalid.ctx)).rejects.toThrow("triage.json is invalid");

  const present = fixture({ verdict: "proceed" });
  await triage.remove(present.ctx);
  expect(await triage.read(present.ctx)).toBeUndefined();
});

test("artifact.write republishes a value read identically by the same descriptor", async () => {
  const { ctx } = fixture({ verdict: "proceed" });
  await triage.write(ctx, { verdict: "escalate" });
  expect(await triage.read(ctx)).toEqual({ verdict: "escalate" });
});

test("artifact.write creates a missing artifact without a file path", async () => {
  const { ctx } = fixture();
  await triage.write(ctx, { verdict: "proceed" });
  expect((await triage.require(ctx)).verdict).toBe("proceed");
});

test("artifact.write rejects a value that its own read would reject", async () => {
  const { ctx } = fixture({ verdict: "proceed" });
  expect(triage.write(ctx, "not an object" as never)).rejects.toThrow("triage.json is invalid");
  // The previous artifact remains intact: validation precedes writing.
  expect(await triage.read(ctx)).toEqual({ verdict: "proceed" });
});

test("StepBuilder.output composes multiple output proofs in order", () => {
  const second = artifact("second.json", (value) => value);
  const step = bashStep({ id: "producer", name: "Producer", command: "produce", output: [triage, second] }).build();
  expect(step.outputs?.map((output) => output.name)).toEqual(["triage.json", "second.json"]);
});

test("artifact.validate judges raw bytes, not an already parsed value", () => {
  expect(triage.validate(JSON.stringify({ verdict: "proceed" }))).toEqual({ verdict: "proceed" });
  expect(() => triage.validate("{}}")).toThrow();
  expect(() => triage.validate(JSON.stringify("not an object"))).toThrow("triage.json is invalid");
});

const proposal = textArtifact("refactoring-proposal.md");

test("textArtifact returns bytes as-is and requires only presence", async () => {
  const { ctx } = textFixture("# Refactoring\n");
  expect(proposal.name).toBe("refactoring-proposal.md");
  expect(await proposal.read(ctx)).toBe("# Refactoring\n");
  expect(await proposal.require(ctx)).toBe("# Refactoring\n");
  expect(proposal.validate("# Refactoring\n")).toBe("# Refactoring\n");
});

test("textArtifact writes without re-encoding and reports absence like a JSON artifact", async () => {
  const { ctx } = textFixture();
  expect(await proposal.read(ctx)).toBeUndefined();
  expect(proposal.require(ctx)).rejects.toThrow("refactoring-proposal.md not found");

  await proposal.write(ctx, "## Step 1\n");
  // No JSON.stringify or added newline: read bytes are exactly the bytes written.
  expect(await proposal.read(ctx)).toBe("## Step 1\n");

  await proposal.remove(ctx);
  expect(await proposal.read(ctx)).toBeUndefined();
});

test("textArtifact applies its parser, including on writes", async () => {
  const nonEmpty = textArtifact("notes.md", (raw) => {
    if (raw.trim().length === 0) throw new Error("notes.md vide");
    return raw;
  });
  const { ctx } = textFixture("   \n");
  expect(nonEmpty.read(ctx)).rejects.toThrow("notes.md vide");
  expect(nonEmpty.write(ctx, "")).rejects.toThrow("notes.md vide");
});
