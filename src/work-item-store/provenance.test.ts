import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, source, textArtifact } from "../dsl/artifact.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineContext } from "../model/context.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { sha256Text } from "./hash.ts";
import {
  type ArtifactProvenance,
  adoptOutputs,
  fingerprintInputs,
  freshness,
  type InFlightAttempt,
  type InputFingerprint,
  inputsUnchanged,
  markInFlight,
  mergeProvenance,
  outputFreshness,
  PROVENANCE_PREFIX,
  pureInputsOf,
  readInputs,
  readSource,
  SOURCE_TIMEOUT_MS,
  readProvenance,
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

const ATTEMPT: InFlightAttempt = {
  runId: "20260101T090000.000Z-route-a1b2c3",
  stepId: "spec",
  attempt: 2,
  startedAt: "2026-01-01T09:00:00.000Z",
};

test("markInFlight: every declared output gets a mark and no inputs, even one produced fresh before", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "complete");
  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  await markInFlight(ctx, { sources: [ticket], outputs: [spec, plan] }, ATTEMPT);

  for (const output of [spec, plan]) {
    const record = await readProvenance(ctx, output);
    expect(record?.inFlight).toEqual(ATTEMPT);
    expect(record?.inputs).toEqual({});
  }
});

test("markInFlight: a step without input marks its outputs too", async () => {
  const { ctx } = fixture();

  await markInFlight(ctx, { outputs: [spec] }, ATTEMPT);

  expect((await readProvenance(ctx, spec))?.inFlight).toEqual(ATTEMPT);
});

test("outputFreshness: a marked output is unfinished, whatever its inputs say", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  await markInFlight(ctx, { sources: [ticket], outputs: [spec] }, ATTEMPT);

  // Absent stays absent: there is nothing to keep either way.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("missing");

  store.values.set("spec.md", "partial");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("unfinished");
  // Neither an unreadable input nor the absence of any input turns it into something else.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [plan]), "spec")).toBe("unfinished");
  expect(await outputFreshness(ctx, spec, {}, "spec")).toBe("unfinished");
});

test("outputFreshness: a mark damaged by hand still reads unfinished", async () => {
  const { ctx, store } = fixture();
  store.values.set("spec.md", "partial");
  store.values.set(
    `${PROVENANCE_PREFIX}spec.md.json`,
    JSON.stringify({
      schemaVersion: 1,
      artifact: "artifacts/spec.md",
      producedBy: "spec",
      producedAt: "x",
      inputs: {},
      inFlight: null,
    }),
  );

  expect(await outputFreshness(ctx, spec, {}, "spec")).toBe("unfinished");
});

test("outputFreshness: a mark on a record that no longer validates still reads unfinished", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "partial");
  await markInFlight(ctx, { sources: [ticket], outputs: [spec] }, ATTEMPT);
  const key = `${PROVENANCE_PREFIX}spec.md.json`;
  const { producedBy: _dropped, ...withoutProducer } = JSON.parse(store.values.get(key) ?? "{}");
  store.values.set(key, JSON.stringify(withoutProducer));

  expect(await readProvenance(ctx, spec)).toBeUndefined();
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("unfinished");
  expect((await stepFreshness(ctx, { id: "spec", sources: [ticket], outputs: [spec] })).adoptable).toEqual([]);
  expect(await freshness(ctx, spec)).toBe("stale");
  // A successful attempt settles it like any other mark.
  await writeProvenance(ctx, spec, "spec", {});
  expect(await readProvenance(ctx, spec)).not.toHaveProperty("inFlight");

  // JSON that no longer parses is no record at all: nothing can be read from it.
  store.values.set(key, '{ "inFlight": ');
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("adoptable");
});

test("stepFreshness: an unfinished output must run, is never adoptable, and ranks with missing", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "written before any record existed");
  store.values.set("plan.md", "partial");
  await markInFlight(ctx, { sources: [ticket], outputs: [plan] }, ATTEMPT);
  const step = { id: "step", sources: [ticket], outputs: [spec, plan] };

  const report = await stepFreshness(ctx, step);

  expect(report.states).toEqual({ "spec.md": "adoptable", "plan.md": "unfinished" });
  expect(report.summary).toBe("unfinished");
  expect(report.mustRun).toBe(true);
  expect(report.unfinished).toEqual(["plan.md"]);
  expect(report.adoptable.map((output) => output.name)).toEqual(["spec.md"]);
  // Adopting what the report offers never settles the marked output.
  await adoptOutputs(ctx, "plan", report);
  expect((await readProvenance(ctx, plan))?.inFlight).toEqual(ATTEMPT);

  // Without input, an unfinished output is not "present".
  expect((await stepFreshness(ctx, { id: "plan", outputs: [plan] })).mustRun).toBe(true);

  // A missing output still names the summary: missing outranks unfinished.
  store.values.delete("spec.md");
  expect((await stepFreshness(ctx, step)).summary).toBe("missing");
});

test("stepFreshness: unfinished names the summary over unknown, stale and adoptable", async () => {
  const { ctx, store } = fixture();
  const notes = textArtifact("notes.md");
  store.values.set("ticket.md", "one");
  for (const name of ["spec.md", "plan.md", "notes.md"]) store.values.set(name, "written");
  await writeProvenance(ctx, spec, "other", {});
  await markInFlight(ctx, { sources: [ticket], outputs: [plan] }, ATTEMPT);
  const step = { id: "step", sources: [ticket], outputs: [spec, plan, notes] };

  const report = await stepFreshness(ctx, step);
  expect(report.states).toEqual({ "spec.md": "stale", "plan.md": "unfinished", "notes.md": "adoptable" });
  expect(report.summary).toBe("unfinished");

  // An unreadable input makes every unmarked output unknown; the marked one still leads.
  store.values.delete("ticket.md");
  const unreadable = await stepFreshness(ctx, step);
  expect(unreadable.states).toEqual({ "spec.md": "unknown", "plan.md": "unfinished", "notes.md": "unknown" });
  expect(unreadable.summary).toBe("unfinished");
});

test("writeProvenance: a successful attempt replaces the mark with a plain record", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  await markInFlight(ctx, { sources: [ticket], outputs: [spec] }, ATTEMPT);
  store.values.set("spec.md", "complete");

  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  const record = await readProvenance(ctx, spec);
  expect(record).not.toHaveProperty("inFlight");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("fresh");
});

// ── Outputs revised in place ─────────────────────────────────────────────────

const notes = textArtifact("notes.md");
/** Revises `plan.md` from `notes.md`, and produces `spec.md` from scratch. */
const reviser = { id: "plan-review", sources: [notes, plan], outputs: [plan, spec] };
const REVIEW_ATTEMPT: InFlightAttempt = { ...ATTEMPT, stepId: "plan-review" };

/** `plan.md` as `plan` produced it from `ticket.md`, and the record vouching for it. */
async function produced(ctx: PipelineContext, store: FakeArtifactStore): Promise<ArtifactProvenance> {
  store.values.set("ticket.md", "one");
  store.values.set("notes.md", "first");
  store.values.set("plan.md", "drafted");
  return writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));
}

/** `plan.md` left partial by a failed attempt of `plan`. */
async function leftPartialByPlan(ctx: PipelineContext, store: FakeArtifactStore): Promise<void> {
  store.values.set("ticket.md", "one");
  store.values.set("notes.md", "first");
  await markInFlight(ctx, { sources: [ticket], outputs: [plan] }, { ...ATTEMPT, stepId: "plan" });
  store.values.set("plan.md", "partial");
}

test("markInFlight: a revised output keeps its bytes, and its mark keeps them with the record that vouched for them", async () => {
  const { ctx, store } = fixture();
  const record = await produced(ctx, store);

  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);

  expect(store.values.get("plan.md")).toBe("drafted");
  const mark = await readProvenance(ctx, plan);
  expect(mark?.inFlight).toEqual({
    ...REVIEW_ATTEMPT,
    revision: {
      outputSha256: sha256Text("drafted"),
      previous: { producedBy: "plan", producedAt: record.producedAt, inputs: record.inputs },
    },
  });
  expect(mark?.producedBy).toBe("plan");
  expect(mark).not.toHaveProperty("unguaranteed");
  // The output the same step produces from scratch gets a plain mark.
  expect((await readProvenance(ctx, spec))?.inFlight).toEqual(REVIEW_ATTEMPT);
});

test("outputFreshness: a revision that wrote nothing leaves the record it found standing; one that wrote leaves the output unfinished", async () => {
  const { ctx, store } = fixture();
  await produced(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  const fromTicket = await fingerprintInputs(ctx, [ticket]);

  expect(await outputFreshness(ctx, plan, fromTicket, "plan")).toBe("fresh");
  expect(await freshness(ctx, plan)).toBe("fresh");

  store.values.set("plan.md", "half revised");
  expect(await outputFreshness(ctx, plan, fromTicket, "plan")).toBe("unfinished");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [notes]), "plan-review")).toBe("unfinished");
  expect(await freshness(ctx, plan)).toBe("stale");
});

test("outputFreshness: a revision mark whose fields were damaged by hand reads unfinished", async () => {
  const { ctx, store } = fixture();
  await produced(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  const key = `${PROVENANCE_PREFIX}plan.md.json`;
  const mark = JSON.parse(store.values.get(key) ?? "{}");
  store.values.set(key, JSON.stringify({ ...mark, inFlight: { ...mark.inFlight, revision: { outputSha256: 7 } } }));

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unfinished");
});

test("mergeProvenance: a revision that succeeds over vouched bytes merges into the record its mark kept", async () => {
  const { ctx, store } = fixture();
  await produced(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  store.values.set("plan.md", "revised");

  const record = await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));

  expect(record).not.toHaveProperty("inFlight");
  expect(record).not.toHaveProperty("unguaranteed");
  expect(record.producedBy).toBe("plan");
  expect(Object.keys(record.inputs).sort()).toEqual(["artifacts/notes.md", "artifacts/ticket.md"]);
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("fresh");
});

test("mergeProvenance: a revision that succeeds over unfinished bytes writes down that it vouches only for itself", async () => {
  const { ctx, store } = fixture();
  await leftPartialByPlan(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  // The mark already says it: the bytes it found were unfinished, nobody is exempt.
  expect(await readProvenance(ctx, plan)).toMatchObject({ unguaranteed: { revisedBy: [] }, inputs: {} });
  store.values.set("plan.md", "revised");

  // The revision reads every input of the producer too: none of them makes it vouch.
  const record = await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [ticket, notes]));

  expect(record).toMatchObject({ producedBy: "plan-review", unguaranteed: { revisedBy: ["plan-review"] } });
  expect(record).not.toHaveProperty("inFlight");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unfinished");
  // Whatever the step producing it is named now.
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan-renamed")).toBe("unfinished");
  // The reviser is judged by what it recorded: running it again would vouch for nothing more.
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, notes]), "plan-review")).toBe("fresh");
  expect(await freshness(ctx, plan)).toBe("stale");

  // A revision that then writes nothing leaves the doubt as it found it.
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unfinished");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, notes]), "plan-review")).toBe("fresh");

  // A second reviser joins the doubt, and keeps what the first one recorded.
  const audit = { id: "plan-audit", sources: [spec, plan], outputs: [plan] };
  store.values.set("spec.md", "s");
  await markInFlight(ctx, audit, { ...ATTEMPT, stepId: "plan-audit" });
  const audited = await mergeProvenance(ctx, plan, "plan-audit", await fingerprintInputs(ctx, [spec]));
  expect(audited.unguaranteed).toEqual({ revisedBy: ["plan-review", "plan-audit"] });
  expect(Object.keys(audited.inputs).sort()).toEqual([
    "artifacts/notes.md",
    "artifacts/spec.md",
    "artifacts/ticket.md",
  ]);
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, notes]), "plan-review")).toBe("fresh");

  // Only an attempt producing it from scratch that succeeds lifts it.
  await markInFlight(ctx, { sources: [ticket], outputs: [plan] }, { ...ATTEMPT, stepId: "plan" });
  store.values.set("plan.md", "produced again");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));
  expect(await readProvenance(ctx, plan)).not.toHaveProperty("unguaranteed");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("fresh");
});

test("outputFreshness: a doubt on a record that no longer validates exempts nobody", async () => {
  const { ctx, store } = fixture();
  await leftPartialByPlan(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));
  const key = `${PROVENANCE_PREFIX}plan.md.json`;
  const { producedBy: _dropped, ...withoutProducer } = JSON.parse(store.values.get(key) ?? "{}");
  store.values.set(key, JSON.stringify(withoutProducer));

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [notes]), "plan-review")).toBe("unfinished");
  expect(await freshness(ctx, plan)).toBe("stale");

  // A doubt whose list was damaged exempts nobody either.
  await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));
  const record = JSON.parse(store.values.get(key) ?? "{}");
  store.values.set(key, JSON.stringify({ ...record, unguaranteed: true }));
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [notes]), "plan-review")).toBe("unfinished");
});

test("mergeProvenance: a revision over a mark another step left does not vouch for that step", async () => {
  const { ctx, store } = fixture();
  await leftPartialByPlan(ctx, store);

  // Its own mark was never written: the stored mark is the producer's.
  const revised = await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));

  expect(revised).toMatchObject({ unguaranteed: { revisedBy: ["plan-review"] } });
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unfinished");
});

test("mergeProvenance: a step revising its own unfinished output is not owed it again, or it would replay forever", async () => {
  const { ctx, store } = fixture();
  const own = { id: "plan", sources: [ticket, plan], outputs: [plan] };
  store.values.set("ticket.md", "one");
  await markInFlight(ctx, own, { ...ATTEMPT, stepId: "plan" });
  store.values.set("plan.md", "partial");
  await markInFlight(ctx, own, { ...ATTEMPT, stepId: "plan", attempt: 3 });
  expect(await readProvenance(ctx, plan)).toMatchObject({ unguaranteed: { revisedBy: [] } });
  store.values.set("plan.md", "complete");

  const record = await mergeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  expect(record.unguaranteed).toEqual({ revisedBy: ["plan"] });
  expect((await stepFreshness(ctx, own)).summary).toBe("fresh");
});

test("mergeProvenance: a revised output absent when the attempt started is the revising step's own", async () => {
  const { ctx, store } = fixture();
  store.values.set("notes.md", "first");
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  expect((await readProvenance(ctx, plan))?.inFlight).toEqual(REVIEW_ATTEMPT);
  store.values.set("plan.md", "written by the reviser");

  const record = await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));

  expect(record).toMatchObject({ producedBy: "plan-review", inputs: { "artifacts/notes.md": sha256Text("first") } });
  expect(record).not.toHaveProperty("unguaranteed");
});

test("outputFreshness: a revision of bytes no record vouched for, that wrote nothing, leaves them adoptable", async () => {
  const { ctx, store } = fixture();
  store.values.set("notes.md", "first");
  store.values.set("plan.md", "written before any record existed");
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  expect((await readProvenance(ctx, plan))?.inFlight?.revision).toEqual({
    outputSha256: sha256Text("written before any record existed"),
  });

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unknown");
  store.values.set("ticket.md", "one");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("adoptable");
  store.values.set("plan.md", "half revised");
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket]), "plan")).toBe("unfinished");
});

test("mergeProvenance: a revision that succeeds over bytes no record vouched for adopts them as its own", async () => {
  const { ctx, store } = fixture();
  store.values.set("notes.md", "first");
  store.values.set("plan.md", "written before any record existed");
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  store.values.set("plan.md", "revised");

  const record = await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));

  expect(record).toEqual({
    schemaVersion: 1,
    artifact: "artifacts/plan.md",
    producedBy: "plan-review",
    producedAt: record.producedAt,
    inputs: { "artifacts/notes.md": sha256Text("first") },
  });
  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [notes]), "plan-review")).toBe("fresh");
});

test("writeProvenance: a step without input that succeeds names itself producer, with no fingerprint", async () => {
  const { ctx, store } = fixture();
  await markInFlight(ctx, { outputs: [spec] }, ATTEMPT);
  store.values.set("spec.md", "complete");

  await writeProvenance(ctx, spec, "spec", {});

  const record = await readProvenance(ctx, spec);
  expect(record).toMatchObject({ producedBy: "spec", inputs: {} });
  expect(record).not.toHaveProperty("inFlight");
  // Present work for itself, a stale one for a step revising it from an input of its own.
  expect((await stepFreshness(ctx, { id: "spec", outputs: [spec] })).mustRun).toBe(false);
  store.values.set("notes.md", "first");
  expect((await stepFreshness(ctx, { id: "spec-review", sources: [notes, spec], outputs: [spec] })).summary).toBe(
    "stale",
  );
  expect(await freshness(ctx, spec)).toBe("fresh");
});

test("freshness: the public helper reports a marked artifact as stale, never unfinished", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "partial");
  await markInFlight(ctx, { sources: [ticket], outputs: [spec] }, ATTEMPT);

  expect(await freshness(ctx, spec)).toBe("stale");
});

/**
 * Admission of an output as the runner read it before `inFlight` existed
 * (7b49932): the record parser and `outputFreshness`, copied verbatim minus the
 * I/O. A runner of that release reads the work items this one writes.
 */
function legacyOutputFreshness(
  raw: string | undefined,
  artifactName: string,
  fingerprints: Record<string, InputFingerprint>,
): "fresh" | "stale" | "unknown" | "adoptable" {
  if (Object.values(fingerprints).some((value) => value === null)) return "unknown";
  let record: ArtifactProvenance | undefined;
  try {
    if (raw === undefined) throw new Error("no record");
    const value = JSON.parse(raw) as Partial<ArtifactProvenance>;
    if (value.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
    if (value.artifact !== `artifacts/${artifactName}`) throw new Error("artifact mismatch");
    if (typeof value.producedBy !== "string" || typeof value.producedAt !== "string") throw new Error("producer");
    if (!value.inputs || typeof value.inputs !== "object") throw new Error("missing inputs");
    for (const fingerprint of Object.values(value.inputs)) {
      if (fingerprint !== null && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
        throw new Error("invalid fingerprint");
      }
    }
    record = value as ArtifactProvenance;
  } catch {
    record = undefined;
  }
  if (!record) return "adoptable";
  for (const [key, current] of Object.entries(fingerprints)) {
    if (!(key in record.inputs)) return "stale";
    if (record.inputs[key] !== current) return "stale";
  }
  return "fresh";
}

test("compatibility: a runner predating the mark reads it as a record missing its inputs, so stale", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "partial");
  await markInFlight(ctx, { sources: [ticket], outputs: [spec] }, ATTEMPT);

  const raw = store.values.get(`${PROVENANCE_PREFIX}spec.md.json`);
  expect(legacyOutputFreshness(raw, "spec.md", await fingerprintInputs(ctx, [ticket]))).toBe("stale");
  // No new schema version: the mark is an optional field of a version 1 record.
  expect(JSON.parse(raw ?? "{}").schemaVersion).toBe(1);
});

test("compatibility: a runner predating the mark runs a reviser over its mark, and trusts the producer as it always did", async () => {
  const { ctx, store } = fixture();
  await produced(ctx, store);
  // A first revision succeeded: the record it found now lists its own input too.
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  store.values.set("plan.md", "half revised");

  const raw = store.values.get(`${PROVENANCE_PREFIX}plan.md.json`);
  expect(legacyOutputFreshness(raw, "plan.md", await fingerprintInputs(ctx, [notes]))).toBe("stale");
  // The limit of that runner: it never knew a revision could leave partial bytes.
  expect(legacyOutputFreshness(raw, "plan.md", await fingerprintInputs(ctx, [ticket]))).toBe("fresh");
});

test("compatibility: a runner predating the doubt runs the producer unless the reviser read every one of its inputs", async () => {
  const { ctx, store } = fixture();
  await leftPartialByPlan(ctx, store);
  await markInFlight(ctx, reviser, REVIEW_ATTEMPT);
  await mergeProvenance(ctx, plan, "plan-review", await fingerprintInputs(ctx, [notes]));

  const raw = store.values.get(`${PROVENANCE_PREFIX}plan.md.json`);
  expect(legacyOutputFreshness(raw, "plan.md", await fingerprintInputs(ctx, [ticket]))).toBe("stale");
  expect(JSON.parse(raw ?? "{}").schemaVersion).toBe(1);
});

test("outputFreshness: reports the five admission states of an unmarked output", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  // Absent output.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("missing");

  // Present output, absent input: rerun rather than trust a missing comparison.
  store.values.set("spec.md", "written");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [plan]), "spec")).toBe("unknown");

  // Present output, no record yet.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("adoptable");

  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("fresh");

  store.values.set("ticket.md", "answered");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]), "spec")).toBe("stale");
});

test("outputFreshness: an input the record does not list is stale", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  store.values.set("plan.md", "p");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, spec]), "plan")).toBe("stale");
});

test("stepFreshness: a step revising an output another step produced runs on its extra input", async () => {
  const { ctx, store } = fixture();
  const planAudit = textArtifact("plan-audit.json");
  store.values.set("spec.md", "s");
  store.values.set("plan.md", "p");
  store.values.set("plan-audit.json", "{}");
  // `plan` wrote plan.md from spec.md; `plan-audit.json` was never an input of it.
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [spec]));
  const planRevise = { id: "plan-revise", sources: [plan, planAudit], outputs: [plan] };

  expect(pureInputsOf(planRevise).map((entry) => entry.name)).toEqual(["plan-audit.json"]);
  const report = await stepFreshness(ctx, planRevise);
  expect(report.states).toEqual({ "plan.md": "stale" });
  expect(report.mustRun).toBe(true);
  expect(report.adoptable).toEqual([]);
});

test("stepFreshness: pure inputs exclude what the step revises in place", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  const step = { id: "step", sources: [ticket, spec], outputs: [spec, plan] };

  expect(pureInputsOf(step).map((entry) => entry.name)).toEqual(["ticket.md"]);
  expect([...revisedInPlace(step)]).toEqual(["spec.md"]);

  const report = await stepFreshness(ctx, step);
  expect(Object.keys(report.fingerprints)).toEqual(["artifacts/ticket.md"]);
  expect(report.states).toEqual({ "spec.md": "adoptable", "plan.md": "missing" });
  expect(report.summary).toBe("missing");
  expect(report.mustRun).toBe(true);
});

test("inputsUnchanged: equal maps match, a changed byte or a different key set does not", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  const step = { id: "step", sources: [ticket, spec], outputs: [plan] };
  const recorded = { "artifacts/ticket.md": sha256Text("one"), "artifacts/spec.md": null };

  // An input absent at absorption and still absent is unchanged.
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(true);

  store.values.set("ticket.md", "two");
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(false);

  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "now present");
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(false);

  store.values.delete("spec.md");
  // The definition gained or lost an input since the absorption.
  expect(await inputsUnchanged(ctx, { sources: [ticket], outputs: [plan] }, recorded)).toBe(false);
  expect(await inputsUnchanged(ctx, { sources: [ticket, spec, plan], outputs: [] }, recorded)).toBe(false);
  // Inputs the step revises in place are not compared.
  expect(await inputsUnchanged(ctx, { sources: [ticket, spec, plan], outputs: [plan] }, recorded)).toBe(true);
});

test("adoptOutputs: an output without a record keeps its content and gains fingerprints", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "written before this feature existed");
  const step = { id: "step", sources: [ticket], outputs: [spec] };

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

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureIn(cwd: string): { ctx: PipelineContext; store: FakeArtifactStore } {
  const store = new FakeArtifactStore();
  return { ctx: buildPipelineContext({ cwd, ticket: "PROJ-1", artifacts: store }), store };
}

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "provenance-source-")));
  scratchDirs.push(dir);
  return dir;
}

test("readInputs: a source is the SHA-256 of its stdout, keyed apart from an artifact of the same name", async () => {
  const { ctx, store } = fixture();
  store.values.set("tree", "artifact bytes");
  const tree = source("tree", { command: "printf 'HEAD\\n'; printf 'diff' >&2" });

  const reading = await readInputs(ctx, [textArtifact("tree"), tree]);

  // stderr is not content: only stdout is fingerprinted.
  expect(reading).toEqual({
    fingerprints: { "artifacts/tree": sha256Text("artifact bytes"), "source:tree": sha256Text("HEAD\n") },
    unavailable: [],
  });
});

test("readSource: runs in the context's working directory, without the runner's internal variables", async () => {
  const cwd = scratchDir();
  const previous = process.env.RUNNER_LOCK_HELD;
  process.env.RUNNER_LOCK_HELD = "1";
  const { ctx } = fixtureIn(cwd);

  try {
    const stdout = await readSource(ctx, source("where", { command: "pwd; printenv RUNNER_LOCK_HELD || echo unset" }));
    expect(stdout).toBe(`${cwd}\nunset\n`);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_LOCK_HELD;
    else process.env.RUNNER_LOCK_HELD = previous;
  }
});

test("readSource: a function command is resolved against the context", async () => {
  const { ctx } = fixture();
  expect(await readSource(ctx, source("ticket", { command: (c) => `echo ${c.ticket}` }))).toBe("PROJ-1\n");
});

test("readInputs: a failing source is null and unavailable, with the exit code and stderr as reason", async () => {
  const { ctx } = fixture();
  const tree = source("tree", { command: "echo partial; echo 'not a git repository' >&2; exit 128" });

  const reading = await readInputs(ctx, [tree]);

  expect(reading.fingerprints).toEqual({ "source:tree": null });
  expect(reading.unavailable).toHaveLength(1);
  expect(reading.unavailable[0]?.source).toBe("tree");
  expect(reading.unavailable[0]?.reason).toContain("exit code 128");
  expect(reading.unavailable[0]?.reason).toContain("not a git repository");
});

test("readInputs: a source is hashed on its raw bytes, not on their UTF-8 decoding", async () => {
  const { ctx } = fixture();
  // Latin-1 e-acute and e-grave: invalid UTF-8, both decoded to the replacement character.
  const acute = source("tree", { command: "printf '\\351'" });
  const grave = source("tree", { command: "printf '\\350'" });

  expect(await readSource(ctx, acute)).toBe(await readSource(ctx, grave));
  const [first, second] = [await readInputs(ctx, [acute]), await readInputs(ctx, [grave])];
  expect(first.fingerprints["source:tree"]).not.toBe(second.fingerprints["source:tree"]);
});

test("readInputs: a command that resolves to blanks is unavailable, not an empty fingerprint", async () => {
  const { ctx } = fixture();

  const reading = await readInputs(ctx, [source("tree", { command: () => "  " })]);

  expect(reading.fingerprints).toEqual({ "source:tree": null });
  expect(reading.unavailable).toEqual([
    { source: "tree", reason: 'source "tree": command resolved to an empty string' },
  ]);
});

test("readSource: a source is bounded to 30 s, like an admission command", () => {
  expect(SOURCE_TIMEOUT_MS).toBe(30_000);
});

test("readSource: a command that outlives its bound is killed and reported as timed out", async () => {
  const { ctx } = fixture();
  const started = Date.now();

  const read = readSource(ctx, source("slow", { command: "sleep 5" }), 200);

  await expect(read).rejects.toThrow(/source "slow": command timed out after 0.2s/);
  expect(Date.now() - started).toBeLessThan(4_000);
});

test("stepFreshness: a source makes the output stale when its stdout moves, unknown when it fails", async () => {
  const cwd = scratchDir();
  const { ctx, store } = fixtureIn(cwd);
  const tree = source("tree", { command: "cat state.txt" });
  const step = { id: "step", sources: [plan, tree], outputs: [spec] };
  writeFileSync(join(cwd, "state.txt"), "v1");
  store.values.set("plan.md", "plan");
  store.values.set("spec.md", "spec");
  await writeProvenance(ctx, spec, "implement", await fingerprintInputs(ctx, pureInputsOf(step)));

  expect((await stepFreshness(ctx, step)).summary).toBe("fresh");
  writeFileSync(join(cwd, "state.txt"), "v2");
  expect((await stepFreshness(ctx, step)).summary).toBe("stale");
  rmSync(join(cwd, "state.txt"));
  const unreadable = await stepFreshness(ctx, step);
  expect(unreadable.summary).toBe("unknown");
  expect(unreadable.mustRun).toBe(true);
  expect(unreadable.unavailable.map((entry) => entry.source)).toEqual(["tree"]);
});

test("inputsUnchanged: a source unreadable then and now is not unchanged", async () => {
  const { ctx } = fixture();
  const step = { id: "step", sources: [source("tree", { command: "exit 1" })], outputs: [spec] };

  expect(await inputsUnchanged(ctx, step, { "source:tree": null })).toBe(false);
});

test("pureInputsOf: a source named like an output stays a pure input, never revised in place", () => {
  const tree = source("spec.md", { command: "true" });
  const step = { id: "step", sources: [spec, tree], outputs: [spec] };

  expect(pureInputsOf(step)).toEqual([tree]);
  expect([...revisedInPlace(step)]).toEqual(["spec.md"]);
});

test("freshness: a record bound to a source is unknown, unless an artifact input already made it stale", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "spec");
  const fingerprints = { ...(await fingerprintInputs(ctx, [ticket])), "source:tree": sha256Text("HEAD") };
  await writeProvenance(ctx, spec, "spec", fingerprints);

  expect(await freshness(ctx, spec)).toBe("unknown");
  store.values.set("ticket.md", "two");
  expect(await freshness(ctx, spec)).toBe("stale");
});

test("freshness: a record bound to a source that was unreadable is unknown, never fresh", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "spec");
  await writeProvenance(ctx, spec, "spec", { ...(await fingerprintInputs(ctx, [ticket])), "source:tree": null });

  expect(await freshness(ctx, spec)).toBe("unknown");
});

test("revisedInPlace: a source named like an output does not make that output revised in place", () => {
  const step = { id: "step", sources: [source("spec.md", { command: "true" })], outputs: [spec] };

  expect([...revisedInPlace(step)]).toEqual([]);
});

test("source descriptors: a name and a command are required", () => {
  expect(() => source(" ", { command: "true" })).toThrow(/name must be a non-empty string/);
  expect(() => source("tree", { command: " " })).toThrow(/command must be a non-empty string or a function/);
  expect(source("tree", { command: "true" })).toMatchObject({ kind: "source", name: "tree", command: "true" });
});
