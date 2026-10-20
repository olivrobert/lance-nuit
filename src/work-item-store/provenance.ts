// runner/work-item-store/provenance.ts
//
// Input provenance of a produced artifact. A step that declares `input` binds
// each of its outputs to the exact bytes of the inputs that produced it, so the
// next admission can tell a still-valid deliverable from a stale one.
//
// Records are stored through `WorkItemArtifactStore` under the reserved
// `.provenance/` prefix rather than next to `decisions/`: the store needs no new
// port, and it works for every ticket, including layouts where no decisions
// directory exists.
//
// An external source (`dsl.source`) is fingerprinted here too, from the stdout
// of its command, so that every input of a step answers to the same comparison.
//
// A record also says whether its artifact may be the leftover of an attempt that
// never succeeded (`inFlight`), and which revisions rewrote bytes no finished
// attempt vouched for (`unguaranteed`). Those facts belong to the work item, not
// to the run: a new run, `--fresh`, `--start-at` or a selector all forget the
// status of the failed pass, and the partial output it wrote must still never be
// adopted. They are written down rather than read from what a record lacks, nor
// from `producedBy`: a later merge can bring back what was left out, and an
// adoption names whichever step adopted.

import { exitCodeFailReason } from "../exec/bash-runner.js";
import { runSupervisedCommand } from "../exec/process-runner.js";
import { withoutRunnerInternalEnv } from "../exec/self-spawn.js";
import { errorMessage } from "../lib/errors.js";
import type { Artifact } from "../model/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import { resolveTemplateAsync } from "../model/definition.js";
import type { StepDefinition } from "../model/run.js";
import { isSource, type Source, type StepInput } from "../model/source.js";
import { sha256Bytes, sha256Text } from "./hash.js";
import { artifactKey, PROVENANCE_DIRNAME } from "./layout.js";

/** Reserved artifact-name prefix owned by the runner. */
export const PROVENANCE_PREFIX = `${PROVENANCE_DIRNAME}/`;

/** Fingerprint of one declared input: its SHA-256, or `null` when the input was
 *  absent at the time the record was written — for a source, when its command
 *  failed. `null` is a fact, not a gap: an input that reappears must invalidate
 *  the record instead of being adopted. */
export type InputFingerprint = string | null;

/** Same bound as an admission command (`checkInputs`): a source is read before
 *  any spawn, and one that hangs (git prompting for credentials) must not freeze
 *  the run. */
export const SOURCE_TIMEOUT_MS = 30_000;

/** A declared source whose command failed: its fingerprint is `null`, which
 *  means unknown, never absent. */
export interface UnavailableSource {
  source: string;
  reason: string;
}

/** Fingerprints of a step's pure inputs, and the sources that could not be read. */
export interface InputReading {
  fingerprints: Record<string, InputFingerprint>;
  unavailable: UnavailableSource[];
}

/** Revisions that succeeded over bytes no finished attempt vouched for. */
export interface Unguaranteed {
  /** Steps whose revision succeeded over those bytes. Each is judged by the
   *  inputs it recorded: running it again would vouch for nothing more. */
  revisedBy: string[];
}

/** The record fields that vouch for an artifact's bytes, kept inside a mark. */
export interface VouchingRecord {
  producedBy: string;
  producedAt: string;
  inputs: Record<string, InputFingerprint>;
  unguaranteed?: Unguaranteed;
}

/** The attempt that may be writing an artifact. Its presence on a record means
 *  that attempt has not succeeded: it is running, failed, was absorbed by
 *  `blocking: false`, or the runner died in it. */
export interface InFlightAttempt {
  runId: string;
  stepId: string;
  attempt: number;
  startedAt: string;
  /** Revision in place of bytes a finished attempt wrote: their SHA-256 when the
   *  attempt started, and the record that stood for them, if any. While the
   *  artifact still holds these bytes, the attempt changed nothing and that record
   *  stands; without it, the step that produced the artifact would pay again for a
   *  revision that never wrote. */
  revision?: { outputSha256: string; previous?: VouchingRecord };
}

export interface ArtifactProvenance {
  schemaVersion: 1;
  /** Produced artifact, in the same `artifacts/<name>` form as a decision. */
  artifact: string;
  /** Step that produced the artifact; on a record carrying `unguaranteed`, the
   *  step that last wrote it. Attribution only: no admission rule reads it. */
  producedBy: string;
  producedAt: string;
  /** Pure inputs of the producing step, keyed like `artifact`. A marked record
   *  never lists those of the marking step, so a runner that predates `inFlight`
   *  reads it as `stale` for that step, and runs it. */
  inputs: Record<string, InputFingerprint>;
  /** Set before the spawn of every attempt that declares the artifact as output,
   *  cleared only when that attempt succeeds. Optional and additive: no schema bump. */
  inFlight?: InFlightAttempt;
  /** Set when a revision in place succeeded over bytes an unfinished attempt left.
   *  The artifact stays `unfinished` to every step declaring it except those in
   *  `revisedBy`, until an attempt producing it from scratch succeeds. Optional and
   *  additive: no schema bump. */
  unguaranteed?: Unguaranteed;
}

/** Freshness of a single output at admission time. */
export type OutputFreshness = "fresh" | "stale" | "missing" | "unknown" | "adoptable" | "unfinished";

/** Freshness reported by the public `freshness()` helper. `adoptable` and
 *  `unfinished` are internal admission states and never leave the runner: an
 *  unfinished artifact is reported `stale`. */
export type ArtifactFreshness = Exclude<OutputFreshness, "adoptable" | "unfinished">;

export interface StepFreshnessReport {
  /** Per-output state, keyed by artifact name. */
  states: Record<string, OutputFreshness>;
  /** Aggregate label, worst state first, for logs and journal events. */
  summary: OutputFreshness;
  /** True when at least one output is `missing`, `unfinished`, `unknown`, or `stale`. */
  mustRun: boolean;
  /** True when at least one output is `stale`. */
  stale: boolean;
  /** Outputs that exist without a usable record and can adopt the current inputs. */
  adoptable: Artifact<unknown>[];
  /** Names of the outputs an attempt that never succeeded left behind. */
  unfinished: string[];
  /** Fingerprints of the pure inputs, read once for the whole step. */
  fingerprints: Record<string, InputFingerprint>;
  /** Sources whose command failed during this reading. */
  unavailable: UnavailableSource[];
}

const SOURCE_KEY_PREFIX = "source:";

/** Record key of a source. Its prefix differs from `artifacts/`, so a source
 *  named like an artifact never shares its fingerprint. */
export function sourceKey(name: string): string {
  return `${SOURCE_KEY_PREFIX}${name}`;
}

function inputKey(input: StepInput): string {
  return isSource(input) ? sourceKey(input.name) : artifactKey(input.name);
}

function provenanceName(artifactName: string): string {
  return `${PROVENANCE_PREFIX}${artifactName}.json`;
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`declared input requires a ticket (artifact "${name}")`);
  return createArtifactRef(ctx.ticket, name);
}

/**
 * Run a source's command and return its raw stdout. It runs in the context's
 * working directory, with the environment of a step (runner-internal `RUNNER_*`
 * variables removed), and is killed after `timeoutMs`. Rejects with the reason
 * when the command cannot be resolved, exits non-zero, or times out.
 */
async function sourceBytes(ctx: PipelineContext, source: Source, timeoutMs: number): Promise<Buffer> {
  const command = await resolveTemplateAsync(source.command, ctx);
  if (!command?.trim()) throw new Error(`source "${source.name}": command resolved to an empty string`);
  const result = await runSupervisedCommand("bash", ["-c", command], {
    cwd: ctx.cwd,
    env: withoutRunnerInternalEnv(process.env),
    timeoutMs,
  });
  if (result.timedOut) throw new Error(`source "${source.name}": command timed out after ${timeoutMs / 1000}s`);
  if (result.status !== 0) {
    throw new Error(`source "${source.name}": ${exitCodeFailReason(result.status, result.stderr)}`);
  }
  return result.stdoutBytes;
}

/** A source's stdout, decoded as UTF-8; rejects like the fingerprint reading does. */
export async function readSource(
  ctx: PipelineContext,
  source: Source,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<string> {
  return (await sourceBytes(ctx, source, timeoutMs)).toString("utf8");
}

/** Hash every pure input: an artifact's raw bytes (`null` when absent), a
 *  source's raw stdout (`null` when its command failed, listed in
 *  `unavailable`). The bytes, not the decoded text: a diff of a Latin-1 file
 *  decodes two different edits to the same replacement characters. */
export async function readInputs(ctx: PipelineContext, inputs: readonly StepInput[]): Promise<InputReading> {
  const fingerprints: Record<string, InputFingerprint> = {};
  const unavailable: UnavailableSource[] = [];
  for (const input of inputs) {
    if (isSource(input)) {
      try {
        fingerprints[inputKey(input)] = sha256Bytes(await sourceBytes(ctx, input, SOURCE_TIMEOUT_MS));
      } catch (error) {
        fingerprints[inputKey(input)] = null;
        unavailable.push({ source: input.name, reason: errorMessage(error) });
      }
      continue;
    }
    const raw = await ctx.artifacts.readText(ref(ctx, input.name));
    fingerprints[inputKey(input)] = raw === undefined ? null : sha256Text(raw);
  }
  return { fingerprints, unavailable };
}

/** Fingerprints of the pure inputs alone, as `readInputs` reads them. */
export async function fingerprintInputs(
  ctx: PipelineContext,
  inputs: readonly StepInput[],
): Promise<Record<string, InputFingerprint>> {
  return (await readInputs(ctx, inputs)).fingerprints;
}

function parseProvenance(value: unknown, artifactName: string): ArtifactProvenance {
  if (!value || typeof value !== "object") throw new Error(`provenance of ${artifactName}: not an object`);
  const record = value as Partial<ArtifactProvenance>;
  if (record.schemaVersion !== 1) throw new Error(`provenance of ${artifactName}: unsupported schemaVersion`);
  if (record.artifact !== artifactKey(artifactName))
    throw new Error(`provenance of ${artifactName}: artifact mismatch`);
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

/** Whether a record carries an in-flight mark: the attempt that wrote its artifact
 *  has not succeeded. Its presence alone decides, not its shape nor the validity
 *  of the rest of the record: a record damaged by hand must not turn a partial
 *  output adoptable. */
export function isInFlight(record: unknown): boolean {
  return typeof record === "object" && record !== null && (record as { inFlight?: unknown }).inFlight !== undefined;
}

/** The revisers a doubt exempts, or `undefined` when the record carries none. Its
 *  presence alone decides, as for a mark: a doubt damaged by hand exempts nobody. */
function doubtOf(record: unknown): string[] | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const doubt = (record as { unguaranteed?: unknown }).unguaranteed;
  if (doubt === undefined) return undefined;
  const revisedBy = (doubt as { revisedBy?: unknown } | null)?.revisedBy;
  return Array.isArray(revisedBy) ? revisedBy.filter((id): id is string => typeof id === "string") : [];
}

/** What a stored record says of an artifact's current bytes.
 *  - `unfinished`: an attempt that wrote them never succeeded.
 *  - `unguaranteed`: revisions succeeded over unfinished bytes; `unfinished` to
 *    every step declaring the artifact except `revisedBy`, which `record` judges.
 *  - `vouched`: `record` vouches for them, or nothing does (`undefined`). */
export type RecordStanding =
  | { kind: "unfinished" }
  | { kind: "unguaranteed"; record: ArtifactProvenance; revisedBy: string[] }
  | { kind: "vouched"; record: ArtifactProvenance | undefined };

const UNFINISHED: RecordStanding = { kind: "unfinished" };

function tryParse(value: unknown, artifactName: string): ArtifactProvenance | undefined {
  try {
    return parseProvenance(value, artifactName);
  } catch {
    // An invalid record vouches for nothing; the marks it may carry are read apart.
    return undefined;
  }
}

function revisionOf(stored: unknown): Partial<NonNullable<InFlightAttempt["revision"]>> | undefined {
  const revision = (stored as { inFlight?: { revision?: unknown } | null }).inFlight?.revision;
  return typeof revision === "object" && revision !== null ? revision : undefined;
}

/** The record kept inside a revision mark, restored as a full record. */
function previousRecord(previous: unknown, artifactName: string): ArtifactProvenance | undefined {
  if (typeof previous !== "object" || previous === null) return undefined;
  return tryParse({ ...previous, schemaVersion: 1, artifact: artifactKey(artifactName) }, artifactName);
}

/** A record's standing apart from any mark: a doubt it carries, or what it vouches for. */
function recordStanding(stored: unknown, artifactName: string): RecordStanding {
  const record = tryParse(stored, artifactName);
  const revisedBy = doubtOf(stored);
  if (revisedBy === undefined) return { kind: "vouched", record };
  // A doubt on a record that no longer validates says nothing about who may be exempt.
  return record ? { kind: "unguaranteed", record, revisedBy } : UNFINISHED;
}

/**
 * The standing of a stored record (raw JSON, `undefined` when absent) against the
 * artifact's current text. The one place that rule lives: admission, the public
 * `freshness()`, the next mark and the dashboard all read it here. The text is
 * consulted for a mark only.
 */
export function standingOf(stored: unknown, artifactName: string, artifactText: string | undefined): RecordStanding {
  if (typeof stored !== "object" || stored === null) return { kind: "vouched", record: undefined };
  if (!isInFlight(stored)) return recordStanding(stored, artifactName);
  const revision = revisionOf(stored);
  if (typeof revision?.outputSha256 !== "string") return UNFINISHED;
  if (artifactText === undefined || sha256Text(artifactText) !== revision.outputSha256) return UNFINISHED;
  if (revision.previous === undefined) return { kind: "vouched", record: undefined };
  const previous = previousRecord(revision.previous, artifactName);
  return previous ? recordStanding(previous, artifactName) : UNFINISHED;
}

async function readStored(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<unknown> {
  try {
    const raw = await ctx.artifacts.readText(ref(ctx, provenanceName(artifact.name)));
    return raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    // An absent or unparsable record is no record: the artifact then adopts the
    // current inputs instead of failing an otherwise valid run. Guessing a mark
    // inside broken JSON would be a heuristic, not a reading.
    return undefined;
  }
}

async function readStanding(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<RecordStanding> {
  const stored = await readStored(ctx, artifact);
  const text = isInFlight(stored) ? await ctx.artifacts.readText(ref(ctx, artifact.name)) : undefined;
  return standingOf(stored, artifact.name, text);
}

export async function readProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
): Promise<ArtifactProvenance | undefined> {
  return tryParse(await readStored(ctx, artifact), artifact.name);
}

async function persist(ctx: PipelineContext, artifact: Artifact<unknown>, record: ArtifactProvenance): Promise<void> {
  await ctx.artifacts.writeText(ref(ctx, provenanceName(artifact.name)), `${JSON.stringify(record, null, 2)}\n`);
}

/** Replace the record of an artifact this step produced from scratch. A step
 *  without input records no fingerprint, and still records that it produced the
 *  artifact: a revision of it later keeps that record as the one it found. */
export async function writeProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
  producedBy: string,
  fingerprints: Record<string, InputFingerprint>,
): Promise<ArtifactProvenance> {
  const record: ArtifactProvenance = {
    schemaVersion: 1,
    artifact: artifactKey(artifact.name),
    producedBy,
    producedAt: new Date().toISOString(),
    inputs: { ...fingerprints },
  };
  await persist(ctx, artifact, record);
  return record;
}

/**
 * Record the success of a step that revised the artifact in place. It merges into
 * the record its mark kept: a step that amends `spec.md` must not erase the
 * provenance the step that wrote it established. A revision that started over
 * unfinished bytes, or over bytes already in doubt, vouches only for itself: the
 * record keeps `unguaranteed` and adds the revising step to `revisedBy`, so the
 * steps that produce the artifact still owe it and this one does not loop.
 */
export async function mergeProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
  stepId: string,
  fingerprints: Record<string, InputFingerprint>,
): Promise<ArtifactProvenance> {
  const start = revisionStart(await readStored(ctx, artifact), artifact.name, stepId);
  const doubt = start.revisedBy && { revisedBy: [...new Set([...start.revisedBy, stepId])] };
  const record: ArtifactProvenance = {
    schemaVersion: 1,
    artifact: artifactKey(artifact.name),
    // Bytes nobody vouched for are adopted by the step that revised them.
    producedBy: doubt ? stepId : (start.base?.producedBy ?? stepId),
    producedAt: new Date().toISOString(),
    inputs: { ...start.base?.inputs, ...fingerprints },
    ...(doubt ? { unguaranteed: doubt } : {}),
  };
  await persist(ctx, artifact, record);
  return record;
}

/** What a successful revision by `stepId` builds on: the record that stood for
 *  the bytes it found (`base`), and, when those bytes were not vouched for, the
 *  revisers a doubt already exempted (`revisedBy`). */
function revisionStart(
  stored: unknown,
  artifactName: string,
  stepId: string,
): { base?: VouchingRecord; revisedBy?: string[] } {
  if (!isInFlight(stored)) {
    // No mark: the attempt was not marked by this runner. Merge as before the mark
    // existed, keeping a doubt the record already carries.
    return startFrom(recordStanding(stored, artifactName));
  }
  const revision = revisionOf(stored);
  if (revision) {
    if (revision.previous === undefined) return {};
    const previous = previousRecord(revision.previous, artifactName);
    return previous ? startFrom(recordStanding(previous, artifactName)) : { revisedBy: [] };
  }
  const revisedBy = doubtOf(stored);
  if (revisedBy !== undefined) return { revisedBy };
  // A mark from scratch this step left found nothing to revise: it wrote the
  // artifact itself. Another step's mark is one this attempt never replaced, over
  // bytes that step did not finish.
  const markedBy = (stored as { inFlight?: { stepId?: unknown } | null }).inFlight?.stepId;
  return markedBy === stepId ? {} : { revisedBy: [] };
}

function startFrom(standing: RecordStanding): { base?: VouchingRecord; revisedBy?: string[] } {
  if (standing.kind === "unfinished") return { revisedBy: [] };
  if (standing.kind === "unguaranteed") return { base: vouching(standing.record), revisedBy: standing.revisedBy };
  return standing.record ? { base: vouching(standing.record) } : {};
}

function vouching(record: ArtifactProvenance): VouchingRecord {
  const revisedBy = doubtOf(record);
  return {
    producedBy: record.producedBy,
    producedAt: record.producedAt,
    inputs: { ...record.inputs },
    ...(revisedBy !== undefined ? { unguaranteed: { revisedBy } } : {}),
  };
}

/**
 * Mark every output `step` declares as written by `attempt`, before it spawns:
 * until the attempt succeeds, whatever it leaves on disk is `unfinished` — except
 * an output revised in place that it leaves byte for byte as it found it.
 *
 * An output produced from scratch keeps no input: its previous record described
 * bytes the attempt is about to replace. An output revised in place keeps the
 * record that stood for the bytes it found inside the mark, doubt included, to
 * merge into on success; outside it, the same inputs minus the revising step's own
 * pure inputs, so a runner that predates the mark reads the record as `stale` for
 * that step instead of `fresh`. Bytes an unfinished attempt left get a mark that
 * says so (`unguaranteed`, nobody exempt), whichever run left them: a revision of
 * partial bytes does not vouch for the steps that produce them.
 */
export async function markInFlight(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "sources" | "outputs">,
  attempt: Omit<InFlightAttempt, "revision">,
): Promise<void> {
  const revised = revisedInPlace(step);
  const ownInputs = new Set(pureInputsOf(step).map(inputKey));
  for (const output of step.outputs ?? []) {
    const text = revised.has(output.name) ? await ctx.artifacts.readText(ref(ctx, output.name)) : undefined;
    // A revised output that is absent is one this attempt writes from scratch.
    const mark =
      text === undefined
        ? fromScratchMark(output, attempt)
        : revisionMark(output, attempt, standingOf(await readStored(ctx, output), output.name, text), text, ownInputs);
    await persist(ctx, output, mark);
  }
}

function fromScratchMark(output: Artifact<unknown>, attempt: Omit<InFlightAttempt, "revision">): ArtifactProvenance {
  return {
    schemaVersion: 1,
    artifact: artifactKey(output.name),
    producedBy: attempt.stepId,
    producedAt: attempt.startedAt,
    inputs: {},
    inFlight: { ...attempt },
  };
}

function revisionMark(
  output: Artifact<unknown>,
  attempt: Omit<InFlightAttempt, "revision">,
  standing: RecordStanding,
  text: string,
  ownInputs: ReadonlySet<string>,
): ArtifactProvenance {
  if (standing.kind === "unfinished") {
    return { ...fromScratchMark(output, attempt), unguaranteed: { revisedBy: [] } };
  }
  const previous = standing.record && vouching(standing.record);
  const kept = Object.entries(previous?.inputs ?? {}).filter(([key]) => !ownInputs.has(key));
  return {
    schemaVersion: 1,
    artifact: artifactKey(output.name),
    producedBy: previous?.producedBy ?? attempt.stepId,
    producedAt: previous?.producedAt ?? attempt.startedAt,
    inputs: Object.fromEntries(kept),
    inFlight: { ...attempt, revision: { outputSha256: sha256Text(text), ...(previous ? { previous } : {}) } },
  };
}

/** Inputs a step actually depends on: what it reads minus what it revises. A
 *  source is never revised: it cannot be an output. */
export function pureInputsOf(step: Pick<StepDefinition, "sources" | "outputs">): StepInput[] {
  const revised = new Set((step.outputs ?? []).map((output) => output.name));
  return (step.sources ?? []).filter((input) => isSource(input) || !revised.has(input.name));
}

/** Pure inputs an attempt records as it was given them, read before it starts:
 *  the artifacts. */
export function inputsReadBeforeAttempt(step: Pick<StepDefinition, "sources" | "outputs">): StepInput[] {
  return pureInputsOf(step).filter((input) => !isSource(input));
}

/** Pure inputs an attempt records once it succeeded: the sources. A step that
 *  changes its own source — an implementation step editing the tree it reads —
 *  would otherwise record the state before its change, and be stale on every
 *  later admission because of it. The price is a change made by someone else
 *  during the attempt, which the record then absorbs. */
export function inputsReadAfterAttempt(step: Pick<StepDefinition, "sources" | "outputs">): StepInput[] {
  return pureInputsOf(step).filter(isSource);
}

/** Outputs the step revises in place: declared as both input and output. */
export function revisedInPlace(step: Pick<StepDefinition, "sources" | "outputs">): Set<string> {
  const declaredInputs = new Set(
    (step.sources ?? []).filter((input) => !isSource(input)).map((artifact) => artifact.name),
  );
  return new Set((step.outputs ?? []).filter((output) => declaredInputs.has(output.name)).map((o) => o.name));
}

/** Freshness of one output, to the admission of step `stepId`, against the
 *  fingerprints of the pure inputs read now. */
export async function outputFreshness(
  ctx: PipelineContext,
  output: Artifact<unknown>,
  fingerprints: Record<string, InputFingerprint>,
  stepId: string,
): Promise<OutputFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, output.name));
  if (!exists) return "missing";
  const standing = await readStanding(ctx, output);
  // Checked before anything else that exists on disk: no comparison can vouch
  // for bytes an attempt left behind without succeeding.
  if (standing.kind === "unfinished") return "unfinished";
  // A step whose revision already succeeded over these bytes would vouch for
  // nothing more by running again; every other step declaring them owes them.
  if (standing.kind === "unguaranteed" && !standing.revisedBy.includes(stepId)) return "unfinished";
  // An unreadable input is a safe bias: rerun rather than trust a comparison
  // against something that is not there.
  if (Object.values(fingerprints).some((value) => value === null)) return "unknown";
  const record = standing.record;
  if (!record) return "adoptable";
  // A record that does not list a declared input was written from other inputs —
  // typically by another step producing the same artifact. The output was never
  // derived from this input, so it cannot be trusted against it: rerun.
  for (const [key, current] of Object.entries(fingerprints)) {
    if (!(key in record.inputs)) return "stale";
    if (record.inputs[key] !== current) return "stale";
  }
  return "fresh";
}

/** `unfinished` ranks with `missing`: either way, there is no deliverable to keep. */
const SEVERITY: readonly OutputFreshness[] = ["missing", "unfinished", "unknown", "stale", "adoptable", "fresh"];

const MUST_RUN: ReadonlySet<OutputFreshness> = new Set(["missing", "unfinished", "unknown", "stale"]);

/** Aggregate the freshness of every output a step declares. */
export async function stepFreshness(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "id" | "sources" | "outputs">,
): Promise<StepFreshnessReport> {
  const { fingerprints, unavailable } = await readInputs(ctx, pureInputsOf(step));
  const states: Record<string, OutputFreshness> = {};
  const adoptable: Artifact<unknown>[] = [];
  const unfinished: string[] = [];
  for (const output of step.outputs ?? []) {
    const state = await outputFreshness(ctx, output, fingerprints, step.id);
    states[output.name] = state;
    if (state === "adoptable") adoptable.push(output);
    if (state === "unfinished") unfinished.push(output.name);
  }
  const values = Object.values(states);
  const summary = SEVERITY.find((state) => values.includes(state)) ?? "fresh";
  return {
    states,
    summary,
    mustRun: values.some((state) => MUST_RUN.has(state)),
    stale: values.includes("stale"),
    adoptable,
    unfinished,
    fingerprints,
    unavailable,
  };
}

/** Whether the pure inputs read now are the ones `recorded`. The key sets must
 *  match too: a definition that gained or lost an input since the record was
 *  written does not answer to it. An artifact absent then and now is unchanged;
 *  a source unreadable now is not, since nobody knows what it holds. */
export async function inputsUnchanged(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "sources" | "outputs">,
  recorded: Record<string, InputFingerprint>,
): Promise<boolean> {
  const { fingerprints: current, unavailable } = await readInputs(ctx, pureInputsOf(step));
  if (unavailable.length > 0) return false;
  const keys = Object.keys(current);
  if (keys.length !== Object.keys(recorded).length) return false;
  return keys.every((key) => key in recorded && recorded[key] === current[key]);
}

/** Bind existing outputs that no record vouches for to the inputs present now.
 *  Without adoption, the first run after this feature landed would regenerate the
 *  deliverables of every ticket already waiting for a human decision. */
export async function adoptOutputs(ctx: PipelineContext, stepId: string, report: StepFreshnessReport): Promise<void> {
  for (const output of report.adoptable) {
    await writeProvenance(ctx, output, stepId, report.fingerprints);
  }
}

/** Public freshness of one artifact, read from its own record. A pipeline uses it
 *  to branch on "the source moved" without owning fingerprints itself. A record
 *  bound to an external source reads `unknown` unless an artifact input already
 *  made it `stale`: the record keeps the source's fingerprint, not its command. */
export async function freshness(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<ArtifactFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, artifact.name));
  if (!exists) return "missing";
  const standing = await readStanding(ctx, artifact);
  // The public vocabulary has no `unfinished`; `stale` is what a pipeline acts on
  // the same way: the artifact must be produced again.
  if (standing.kind !== "vouched") return "stale";
  const record = standing.record;
  if (!record) return "unknown";
  let boundToSource = false;
  for (const [key, recorded] of Object.entries(record.inputs)) {
    if (key.startsWith(SOURCE_KEY_PREFIX)) {
      boundToSource = true;
      continue;
    }
    const name = key.startsWith("artifacts/") ? key.slice("artifacts/".length) : key;
    const raw = await ctx.artifacts.readText(ref(ctx, name));
    const current = raw === undefined ? null : sha256Text(raw);
    if (current === null && recorded === null) continue;
    if (current === null) return "unknown";
    if (current !== recorded) return "stale";
  }
  return boundToSource ? "unknown" : "fresh";
}
