import { expect, test } from "bun:test";
import { artifact, textArtifact } from "../dsl/artifact.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineContext } from "../model/context.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { sha256Text } from "./hash.ts";
import {
  adoptOutputs,
  fingerprintInputs,
  freshness,
  mergeProvenance,
  outputFreshness,
  PROVENANCE_PREFIX,
  pureInputsOf,
  readProvenance,
  removeProvenance,
  revisedInPlace,
  stepFreshness,
  writeProvenance,
} from "./provenance.ts";

/** Map-keyed fake: provenance touches several artifacts at once, so a store that
 *  holds one value cannot express the situations under test. */
class FakeArtifactStore implements WorkItemArtifactStore {
  readonly values = new Map<string, string>();

  async exists(ref: ArtifactRef): Promise<boolean> {
    return this.values.has(ref.name);
  }

  async readText(ref: ArtifactRef): Promise<string | undefined> {
    return this.values.get(ref.name);
  }

  async readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined> {
    const raw = this.values.get(ref.name);
    return raw === undefined ? undefined : parse(JSON.parse(raw));
  }

  async writeText(ref: ArtifactRef, value: string): Promise<void> {
    this.values.set(ref.name, value);
  }

  async remove(ref: ArtifactRef): Promise<void> {
    this.values.delete(ref.name);
  }
}

const ticket = textArtifact("ticket.md");
const spec = textArtifact("spec.md");
const plan = textArtifact("plan.md");

function fixture(): { ctx: PipelineContext; store: FakeArtifactStore } {
  const store = new FakeArtifactStore();
  const ctx = buildPipelineContext({ cwd: ".", ticket: "PROJ-1", artifacts: store });
  return { ctx, store };
}

test("fingerprintInputs: hashes present inputs and reports absent ones", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  expect(await fingerprintInputs(ctx, [ticket, spec])).toEqual({
    "artifacts/ticket.md": sha256Text("one"),
    "artifacts/spec.md": null,
  });
});

test("fingerprintInputs: a declared input without a ticket is an authoring error", async () => {
  const ctx = buildPipelineContext({ cwd: ".", artifacts: new FakeArtifactStore() });
  expect(fingerprintInputs(ctx, [ticket])).rejects.toThrow(/requires a ticket/);
});

test("writeProvenance: the record is stored under the reserved prefix", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  const record = await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  expect(record.artifact).toBe("artifacts/spec.md");
  expect(record.producedBy).toBe("spec");
  expect(store.values.has(`${PROVENANCE_PREFIX}spec.md.json`)).toBe(true);
  expect(await readProvenance(ctx, spec)).toEqual(record);
});

test("mergeProvenance: a revising step adds its inputs and keeps the first producer", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  await mergeProvenance(ctx, plan, "plan-audit", await fingerprintInputs(ctx, [spec]));

  const record = await readProvenance(ctx, plan);
  expect(record?.producedBy).toBe("plan");
  expect(Object.keys(record?.inputs ?? {}).sort()).toEqual(["artifacts/spec.md", "artifacts/ticket.md"]);
});

test("removeProvenance: the record disappears with the artifact", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  await removeProvenance(ctx, spec);

  expect(await readProvenance(ctx, spec)).toBeUndefined();
});

test("outputFreshness: reports the five admission states", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  // Absent output.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("missing");

  // Present output, absent input: rerun rather than trust a missing comparison.
  store.values.set("spec.md", "written");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [plan]))).toBe("unknown");

  // Present output, no record yet.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("adoptable");

  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("fresh");

  store.values.set("ticket.md", "answered");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("stale");
});

test("outputFreshness: an input declared after the record was written is adoptable", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  store.values.set("plan.md", "p");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, spec]))).toBe("adoptable");
});

test("stepFreshness: pure inputs exclude what the step revises in place", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  const step = { sources: [ticket, spec], outputs: [spec, plan] };

  expect(pureInputsOf(step).map((entry) => entry.name)).toEqual(["ticket.md"]);
  expect([...revisedInPlace(step)]).toEqual(["spec.md"]);

  const report = await stepFreshness(ctx, step);
  expect(Object.keys(report.fingerprints)).toEqual(["artifacts/ticket.md"]);
  expect(report.states).toEqual({ "spec.md": "adoptable", "plan.md": "missing" });
  expect(report.summary).toBe("missing");
  expect(report.mustRun).toBe(true);
});

test("adoptOutputs: an output without a record keeps its content and gains fingerprints", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "written before this feature existed");
  const step = { sources: [ticket], outputs: [spec] };

  const report = await stepFreshness(ctx, step);
  expect(report.mustRun).toBe(false);
  expect(report.adoptable.map((entry) => entry.name)).toEqual(["spec.md"]);

  await adoptOutputs(ctx, "spec", report);

  expect(store.values.get("spec.md")).toBe("written before this feature existed");
  expect((await stepFreshness(ctx, step)).states["spec.md"]).toBe("fresh");
});

test("freshness: the public helper reads the artifact's own record", async () => {
  const { ctx, store } = fixture();

  expect(await freshness(ctx, spec)).toBe("missing");

  store.values.set("spec.md", "s");
  expect(await freshness(ctx, spec)).toBe("unknown");

  store.values.set("ticket.md", "one");
  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));
  expect(await freshness(ctx, spec)).toBe("fresh");

  store.values.set("ticket.md", "answered");
  expect(await freshness(ctx, spec)).toBe("stale");

  store.values.delete("ticket.md");
  expect(await freshness(ctx, spec)).toBe("unknown");
});

test("readProvenance: a record that does not name its artifact is ignored", async () => {
  const { ctx, store } = fixture();
  store.values.set(
    `${PROVENANCE_PREFIX}spec.md.json`,
    JSON.stringify({ schemaVersion: 1, artifact: "artifacts/plan.md", producedBy: "x", producedAt: "x", inputs: {} }),
  );

  expect(await readProvenance(ctx, spec)).toBeUndefined();
});

test("artifact descriptors: the provenance prefix is reserved by the runner", () => {
  expect(() => textArtifact(`${PROVENANCE_PREFIX}spec.md.json`)).toThrow(/reserved/);
  expect(() => artifact(`${PROVENANCE_PREFIX}spec.json`, (value) => value)).toThrow(/reserved/);
});
