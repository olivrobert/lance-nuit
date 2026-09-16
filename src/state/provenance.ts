// runner/state/provenance.ts
//
// Input provenance of a produced artifact. A step that declares `input` binds
// each of its outputs to the exact bytes of the inputs that produced it, so the
// next admission can tell a still-valid deliverable from a stale one.
//
// Records are stored through `WorkItemArtifactStore` under the reserved
// `.provenance/` prefix rather than next to `decisions/`: the store needs no new
// port, and it works for every ticket, including layouts where no decisions
// directory exists.

import type { Artifact } from "../model/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import type { StepDefinition } from "../model/run.js";
import { sha256Text } from "./hash.js";

/** Reserved artifact-name prefix owned by the runner. */
export const PROVENANCE_PREFIX = ".provenance/";

/** Fingerprint of one declared input: its SHA-256, or `null` when the input was
 *  absent at the time the record was written. `null` is a fact, not a gap: an
 *  input that reappears must invalidate the record instead of being adopted. */
export type InputFingerprint = string | null;

export interface ArtifactProvenance {
  schemaVersion: 1;
  /** Produced artifact, in the same `artifacts/<name>` form as a decision. */
  artifact: string;
  /** Step that first produced the artifact. */
  producedBy: string;
  producedAt: string;
  /** Pure inputs of the producing step, keyed like `artifact`. */
  inputs: Record<string, InputFingerprint>;
}

/** Freshness of a single output at admission time. */
export type OutputFreshness = "fresh" | "stale" | "missing" | "unknown" | "adoptable";

/** Freshness reported by the public `freshness()` helper. `adoptable` is an
 *  internal admission state and never leaves the runner. */
export type ArtifactFreshness = Exclude<OutputFreshness, "adoptable">;

export interface StepFreshnessReport {
  /** Per-output state, keyed by artifact name. */
  states: Record<string, OutputFreshness>;
  /** Aggregate label, worst state first, for logs and journal events. */
  summary: OutputFreshness;
  /** True when at least one output is `missing`, `unknown`, or `stale`. */
  mustRun: boolean;
  /** True when at least one output is `stale`. */
  stale: boolean;
  /** Outputs that exist without a usable record and can adopt the current inputs. */
  adoptable: Artifact<unknown>[];
  /** Fingerprints of the pure inputs, read once for the whole step. */
  fingerprints: Record<string, InputFingerprint>;
}

/** Record key of an artifact, aligned with the `artifacts/<name>` form used by
 *  human decisions so both files can be read side by side. */
function recordKey(name: string): string {
  return `artifacts/${name}`;
}

function provenanceName(artifactName: string): string {
  return `${PROVENANCE_PREFIX}${artifactName}.json`;
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`declared input requires a ticket (artifact "${name}")`);
  return createArtifactRef(ctx.ticket, name);
}

/** Read the raw bytes of each artifact and hash them. `null` means absent. */
export async function fingerprintInputs(
  ctx: PipelineContext,
  artifacts: readonly Artifact<unknown>[],
): Promise<Record<string, InputFingerprint>> {
  const fingerprints: Record<string, InputFingerprint> = {};
  for (const input of artifacts) {
    const raw = await ctx.artifacts.readText(ref(ctx, input.name));
    fingerprints[recordKey(input.name)] = raw === undefined ? null : sha256Text(raw);
  }
  return fingerprints;
}

function parseProvenance(value: unknown, artifactName: string): ArtifactProvenance {
  if (!value || typeof value !== "object") throw new Error(`provenance of ${artifactName}: not an object`);
  const record = value as Partial<ArtifactProvenance>;
  if (record.schemaVersion !== 1) throw new Error(`provenance of ${artifactName}: unsupported schemaVersion`);
  if (record.artifact !== recordKey(artifactName)) throw new Error(`provenance of ${artifactName}: artifact mismatch`);
  if (typeof record.producedBy !== "string" || typeof record.producedAt !== "string") {
    throw new Error(`provenance of ${artifactName}: missing producer`);
  }
  if (!record.inputs || typeof record.inputs !== "object") {
    throw new Error(`provenance of ${artifactName}: missing inputs`);
  }
  for (const value of Object.values(record.inputs)) {
    if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`provenance of ${artifactName}: invalid fingerprint`);
    }
  }
  return record as ArtifactProvenance;
}

export async function readProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
): Promise<ArtifactProvenance | undefined> {
  try {
    const raw = await ctx.artifacts.readText(ref(ctx, provenanceName(artifact.name)));
    if (raw === undefined) return undefined;
    return parseProvenance(JSON.parse(raw), artifact.name);
  } catch {
    // A missing or malformed record is treated as no record: the artifact then
    // adopts the current inputs instead of failing an otherwise valid run.
    return undefined;
  }
}

async function persist(ctx: PipelineContext, artifact: Artifact<unknown>, record: ArtifactProvenance): Promise<void> {
  await ctx.artifacts.writeText(ref(ctx, provenanceName(artifact.name)), `${JSON.stringify(record, null, 2)}\n`);
}

/** Replace the record of an artifact this step produced from scratch. */
export async function writeProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
  producedBy: string,
  fingerprints: Record<string, InputFingerprint>,
): Promise<ArtifactProvenance> {
  const record: ArtifactProvenance = {
    schemaVersion: 1,
    artifact: recordKey(artifact.name),
    producedBy,
    producedAt: new Date().toISOString(),
    inputs: { ...fingerprints },
  };
  await persist(ctx, artifact, record);
  return record;
}

/** Merge the fingerprints of a revising step into an existing record. The
 *  original producer is kept: a step that amends `spec.md` must not erase the
 *  provenance the step that wrote it established. */
export async function mergeProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
  producedBy: string,
  fingerprints: Record<string, InputFingerprint>,
): Promise<ArtifactProvenance> {
  const existing = await readProvenance(ctx, artifact);
  if (!existing) return writeProvenance(ctx, artifact, producedBy, fingerprints);
  const record: ArtifactProvenance = {
    ...existing,
    producedAt: new Date().toISOString(),
    inputs: { ...existing.inputs, ...fingerprints },
  };
  await persist(ctx, artifact, record);
  return record;
}

export async function removeProvenance(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<void> {
  await ctx.artifacts.remove(ref(ctx, provenanceName(artifact.name)));
}

/** Inputs a step actually depends on: what it reads minus what it revises. */
export function pureInputsOf(step: Pick<StepDefinition, "sources" | "outputs">): Artifact<unknown>[] {
  const revised = new Set((step.outputs ?? []).map((output) => output.name));
  return (step.sources ?? []).filter((source) => !revised.has(source.name));
}

/** Outputs the step revises in place: declared as both input and output. */
export function revisedInPlace(step: Pick<StepDefinition, "sources" | "outputs">): Set<string> {
  const declaredInputs = new Set((step.sources ?? []).map((source) => source.name));
  return new Set((step.outputs ?? []).filter((output) => declaredInputs.has(output.name)).map((o) => o.name));
}

/** Freshness of one output against the fingerprints of the pure inputs read now. */
export async function outputFreshness(
  ctx: PipelineContext,
  output: Artifact<unknown>,
  fingerprints: Record<string, InputFingerprint>,
): Promise<OutputFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, output.name));
  if (!exists) return "missing";
  // An unreadable input is a safe bias: rerun rather than trust a comparison
  // against something that is not there.
  if (Object.values(fingerprints).some((value) => value === null)) return "unknown";
  const record = await readProvenance(ctx, output);
  if (!record) return "adoptable";
  for (const [key, current] of Object.entries(fingerprints)) {
    if (!(key in record.inputs)) return "adoptable";
    if (record.inputs[key] !== current) return "stale";
  }
  return "fresh";
}

const SEVERITY: readonly OutputFreshness[] = ["missing", "unknown", "stale", "adoptable", "fresh"];

/** Aggregate the freshness of every output a step declares. */
export async function stepFreshness(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "sources" | "outputs">,
): Promise<StepFreshnessReport> {
  const fingerprints = await fingerprintInputs(ctx, pureInputsOf(step));
  const states: Record<string, OutputFreshness> = {};
  const adoptable: Artifact<unknown>[] = [];
  for (const output of step.outputs ?? []) {
    const state = await outputFreshness(ctx, output, fingerprints);
    states[output.name] = state;
    if (state === "adoptable") adoptable.push(output);
  }
  const values = Object.values(states);
  const summary = SEVERITY.find((state) => values.includes(state)) ?? "fresh";
  return {
    states,
    summary,
    mustRun: values.some((state) => state === "missing" || state === "unknown" || state === "stale"),
    stale: values.includes("stale"),
    adoptable,
    fingerprints,
  };
}

/** Bind existing outputs that carry no usable record to the inputs present now.
 *  Without adoption, the first run after this feature landed would regenerate the
 *  deliverables of every ticket already waiting for a human decision. */
export async function adoptOutputs(ctx: PipelineContext, stepId: string, report: StepFreshnessReport): Promise<void> {
  for (const output of report.adoptable) {
    await mergeProvenance(ctx, output, stepId, report.fingerprints);
  }
}

/** Public freshness of one artifact, read from its own record. A pipeline uses it
 *  to branch on "the source moved" without owning fingerprints itself. */
export async function freshness(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<ArtifactFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, artifact.name));
  if (!exists) return "missing";
  const record = await readProvenance(ctx, artifact);
  if (!record) return "unknown";
  for (const [key, recorded] of Object.entries(record.inputs)) {
    const name = key.startsWith("artifacts/") ? key.slice("artifacts/".length) : key;
    const raw = await ctx.artifacts.readText(ref(ctx, name));
    const current = raw === undefined ? null : sha256Text(raw);
    if (current === null && recorded === null) continue;
    if (current === null) return "unknown";
    if (current !== recorded) return "stale";
  }
  return "fresh";
}
