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
//
// An external source (`dsl.source`) is fingerprinted here too, from the stdout
// of its command, so that every input of a step answers to the same comparison.
//
// A record also says whether its artifact may be the leftover of an attempt that
// never succeeded (`inFlight`). That fact belongs to the work item, not to the run:
// a new run, `--fresh`, `--start-at` or a selector all forget the status of the
// failed pass, and the partial output it wrote must still never be adopted.

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

/** Reserved artifact-name prefix owned by the runner. */
export const PROVENANCE_PREFIX = ".provenance/";

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

/** The attempt that may be writing an artifact. Its presence on a record means
 *  that attempt has not succeeded: it is running, failed, was absorbed by
 *  `blocking: false`, or the runner died in it. */
export interface InFlightAttempt {
  runId: string;
  stepId: string;
  attempt: number;
  startedAt: string;
}

export interface ArtifactProvenance {
  schemaVersion: 1;
  /** Produced artifact, in the same `artifacts/<name>` form as a decision. */
  artifact: string;
  /** Step that first produced the artifact. */
  producedBy: string;
  producedAt: string;
  /** Pure inputs of the producing step, keyed like `artifact`. A marked record
   *  lists none, so a runner that predates `inFlight` reads it as `stale` for a
   *  step declaring input, and runs that step. */
  inputs: Record<string, InputFingerprint>;
  /** Set before the spawn of every attempt that produces the artifact from
   *  scratch, cleared only when such an attempt succeeds: a revision in place
   *  merges into the record and keeps it. Optional and additive: no schema bump. */
  inFlight?: InFlightAttempt;
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

/** Record key of an artifact, aligned with the `artifacts/<name>` form used by
 *  human decisions so both files can be read side by side. */
function recordKey(name: string): string {
  return `artifacts/${name}`;
}

const SOURCE_KEY_PREFIX = "source:";

/** Record key of a source. Its prefix differs from `artifacts/`, so a source
 *  named like an artifact never shares its fingerprint. */
export function sourceKey(name: string): string {
  return `${SOURCE_KEY_PREFIX}${name}`;
}

function inputKey(input: StepInput): string {
  return isSource(input) ? sourceKey(input.name) : recordKey(input.name);
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

/** Whether a record carries an in-flight mark: the attempt that wrote its artifact
 *  has not succeeded. Its presence alone decides, not its shape nor the validity
 *  of the rest of the record: a record damaged by hand must not turn a partial
 *  output adoptable. Exported for readers of the raw
 *  record, such as the dashboard, so the rule lives here only. */
export function isInFlight(record: { inFlight?: unknown } | undefined): boolean {
  return record?.inFlight !== undefined;
}

/** A stored record as admission reads it: the valid record, if any, and whether
 *  the stored object carries a mark. The two are apart because a mark must hold
 *  even when the rest of the record no longer validates. */
interface RecordReading {
  record: ArtifactProvenance | undefined;
  inFlight: boolean;
}

const NO_RECORD: RecordReading = { record: undefined, inFlight: false };

async function readRecord(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<RecordReading> {
  let value: unknown;
  try {
    const raw = await ctx.artifacts.readText(ref(ctx, provenanceName(artifact.name)));
    if (raw === undefined) return NO_RECORD;
    value = JSON.parse(raw);
  } catch {
    // An absent or unparsable record is no record: the artifact then adopts the
    // current inputs instead of failing an otherwise valid run. Guessing a mark
    // inside broken JSON would be a heuristic, not a reading.
    return NO_RECORD;
  }
  const inFlight = typeof value === "object" && value !== null && isInFlight(value);
  try {
    return { record: parseProvenance(value, artifact.name), inFlight };
  } catch {
    // An invalid record vouches for nothing, but a mark on it still says the
    // attempt that wrote the artifact never succeeded.
    return { record: undefined, inFlight };
  }
}

export async function readProvenance(
  ctx: PipelineContext,
  artifact: Artifact<unknown>,
): Promise<ArtifactProvenance | undefined> {
  return (await readRecord(ctx, artifact)).record;
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

/**
 * Mark the outputs `step` produces from scratch as written by `attempt`, before it
 * spawns: until the attempt succeeds, whatever it leaves on disk is `unfinished`.
 * The mark keeps no input: the previous record described bytes the attempt is
 * about to replace.
 *
 * An output revised in place keeps its record untouched, as before the mark
 * existed: a mark there would make the step that produced it run again even after
 * a revision that wrote nothing. The price is the opposite case, a revision that
 * wrote then failed, whose bytes the record still vouches for (guide/dsl.md,
 * Input freshness).
 */
export async function markInFlight(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "sources" | "outputs">,
  attempt: InFlightAttempt,
): Promise<void> {
  const revised = revisedInPlace(step);
  for (const output of step.outputs ?? []) {
    if (revised.has(output.name)) continue;
    await persist(ctx, output, {
      schemaVersion: 1,
      artifact: recordKey(output.name),
      producedBy: attempt.stepId,
      producedAt: attempt.startedAt,
      inputs: {},
      inFlight: { ...attempt },
    });
  }
}

/** Settle the marks of a successful step that declares no input: it records no
 *  fingerprint, so its outputs keep no record at all, as before the mark existed. */
export async function clearInFlight(
  ctx: PipelineContext,
  step: Pick<StepDefinition, "sources" | "outputs">,
): Promise<void> {
  for (const output of step.outputs ?? []) {
    if ((await readRecord(ctx, output)).inFlight) {
      await ctx.artifacts.remove(ref(ctx, provenanceName(output.name)));
    }
  }
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

/** Freshness of one output against the fingerprints of the pure inputs read now. */
export async function outputFreshness(
  ctx: PipelineContext,
  output: Artifact<unknown>,
  fingerprints: Record<string, InputFingerprint>,
): Promise<OutputFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, output.name));
  if (!exists) return "missing";
  const { record, inFlight } = await readRecord(ctx, output);
  // Checked before anything else that exists on disk: no comparison can vouch
  // for bytes an attempt left behind without succeeding.
  if (inFlight) return "unfinished";
  // An unreadable input is a safe bias: rerun rather than trust a comparison
  // against something that is not there.
  if (Object.values(fingerprints).some((value) => value === null)) return "unknown";
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
  step: Pick<StepDefinition, "sources" | "outputs">,
): Promise<StepFreshnessReport> {
  const { fingerprints, unavailable } = await readInputs(ctx, pureInputsOf(step));
  const states: Record<string, OutputFreshness> = {};
  const adoptable: Artifact<unknown>[] = [];
  const unfinished: string[] = [];
  for (const output of step.outputs ?? []) {
    const state = await outputFreshness(ctx, output, fingerprints);
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

/** Bind existing outputs that carry no record at all to the inputs present now.
 *  Without adoption, the first run after this feature landed would regenerate the
 *  deliverables of every ticket already waiting for a human decision. */
export async function adoptOutputs(ctx: PipelineContext, stepId: string, report: StepFreshnessReport): Promise<void> {
  for (const output of report.adoptable) {
    await mergeProvenance(ctx, output, stepId, report.fingerprints);
  }
}

/** Public freshness of one artifact, read from its own record. A pipeline uses it
 *  to branch on "the source moved" without owning fingerprints itself. A record
 *  bound to an external source reads `unknown` unless an artifact input already
 *  made it `stale`: the record keeps the source's fingerprint, not its command. */
export async function freshness(ctx: PipelineContext, artifact: Artifact<unknown>): Promise<ArtifactFreshness> {
  const exists = await ctx.artifacts.exists(ref(ctx, artifact.name));
  if (!exists) return "missing";
  const { record, inFlight } = await readRecord(ctx, artifact);
  // The public vocabulary has no `unfinished`; `stale` is what a pipeline acts on
  // the same way: the artifact must be produced again.
  if (inFlight) return "stale";
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
