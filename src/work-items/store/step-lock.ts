//
// The freshness lock of a work item, `artifacts/lock.json`: one stamp per step
// that last succeeded, binding the hashes of its declared inputs to the hashes of
// its declared outputs. Every run and every pipeline of the work item shares it.
// This module is its only reader and writer.
//
// I/O goes through `fs`, not the artifact store port, which has neither a lock nor
// a rename. Every write is one synchronous critical section under
// `lock.json.lock`: nothing awaits inside it, so two writers of one process
// cannot interleave, and a reader sees the old file or the new one.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../shared/lib/atomic-write.js";
import { errorMessage, isErrno } from "../../shared/lib/errors.js";
import { acquireLock, releaseLock } from "../../shared/env/lock.js";
import { exitCodeFailReason } from "../../shared/process/bash-runner.js";
import { killedByTimeout, runSupervisedCommand } from "../../shared/process/process-runner.js";
import type { Artifact } from "../artifact.js";
import { createArtifactRef } from "../../shared/language/artifact-ports.js";
import { type PipelineContext, type PipelineLot, resolveTemplateAsync } from "../../shared/language/context.js";
import { isSource, type Source, type StepInput } from "../source.js";
import { sha256Bytes, sha256Text } from "./hash.js";
import { artifactKey, workItemLayout } from "./layout.js";

/** Hash of one declared input, or `null`: an artifact absent, or a source whose
 *  command failed. */
export type Fingerprint = string | null;

export interface StepStamp {
  /** Attribution and diagnostics only: no admission rule reads them. */
  pipeline: string;
  runId: string;
  stampedAt: string;
  inputs: Record<string, Fingerprint>;
  outputs: Record<string, string>;
  /** The pass absorbed a failure (`blocking: false`); displayed, never decided on. */
  absorbed?: true;
}

export interface WorkItemLock {
  schemaVersion: 1;
  steps: Record<string, StepStamp>;
}

/** What the lock reads of a step: what it takes in and what it delivers. */
export interface StepIo {
  readonly id: string;
  readonly sources?: readonly StepInput[];
  readonly outputs?: readonly Artifact<unknown>[];
}

/** A declared source whose command failed. */
export interface UnavailableSource {
  source: string;
  reason: string;
}

export interface Freshness {
  value: "none" | "fresh" | "stale";
  /** The readings of the declared inputs this answer was made on, which the pass
   *  records instead of hashing its artifact inputs again. */
  inputs: Record<string, Fingerprint>;
  unavailable: UnavailableSource[];
}

/** A consumer's recorded source that moves with the step it ignores. */
export interface IgnoredAdvance {
  key: string;
  source: string;
  before: Fingerprint;
  after: Fingerprint;
}

/** Same bound as an admission command: a source is read before any spawn, and one
 *  that hangs (git prompting for credentials) must not freeze the run. */
export const SOURCE_TIMEOUT_MS = 30_000;

const SOURCE_KEY_PREFIX = "source:";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

/** Lock key of a source. Its prefix differs from `artifacts/`, so a source named
 *  like an artifact never shares its hash. */
export function sourceKey(name: string): string {
  return `${SOURCE_KEY_PREFIX}${name}`;
}

function inputKey(input: StepInput): string {
  return isSource(input) ? sourceKey(input.name) : artifactKey(input.name);
}

/** Lots share the artifacts of their work item, so a lot's steps are keyed apart.
 *  A step id cannot contain `/`. */
export function stampKey(stepId: string, lot?: PipelineLot): string {
  return lot ? `${lot.id}/${stepId}` : stepId;
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`declared input or output requires a ticket (artifact "${name}")`);
  return createArtifactRef(ctx.ticket, name);
}

async function sourceBytes(ctx: PipelineContext, source: Source, timeoutMs: number): Promise<Buffer> {
  const command = await resolveTemplateAsync(source.command, ctx);
  if (!command?.trim()) throw new Error(`source "${source.name}": command resolved to an empty string`);
  const result = await runSupervisedCommand("bash", ["-c", command], { cwd: ctx.cwd, timeoutMs });
  if (killedByTimeout(result.kill))
    throw new Error(`source "${source.name}": command timed out after ${timeoutMs / 1000}s`);
  if (result.status !== 0) {
    throw new Error(`source "${source.name}": ${exitCodeFailReason(result.status, result.stderr)}`);
  }
  return result.stdoutBytes;
}

/** A source's stdout, decoded as UTF-8; rejects when its command fails. */
export async function readSource(
  ctx: PipelineContext,
  source: Source,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<string> {
  return (await sourceBytes(ctx, source, timeoutMs)).toString("utf8");
}

/** Hash each input: an artifact's bytes (`null` when absent), a source's raw
 *  stdout (`null` when its command failed, listed in `unavailable`). The raw
 *  stdout, not the decoded text: two edits of a Latin-1 file decode to the same
 *  replacement characters. */
export async function readInputs(
  ctx: PipelineContext,
  inputs: readonly StepInput[],
): Promise<{ fingerprints: Record<string, Fingerprint>; unavailable: UnavailableSource[] }> {
  const fingerprints: Record<string, Fingerprint> = {};
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

function workItemDirOf(ctx: PipelineContext): string {
  if (!ctx.paths.workItemDir) throw new Error("the freshness lock requires a ticket");
  return ctx.paths.workItemDir;
}

function unreadable(path: string, why: string): Error {
  return new Error(`freshness lock ${path} is unreadable (${why}): fix or delete it`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLock(raw: string, path: string): WorkItemLock {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw unreadable(path, errorMessage(error));
  }
  if (!isRecord(value) || value.schemaVersion !== 1) throw unreadable(path, "unsupported schemaVersion");
  if (!isRecord(value.steps)) throw unreadable(path, "missing steps");
  for (const [key, stamp] of Object.entries(value.steps)) {
    if (!isRecord(stamp) || !isRecord(stamp.inputs) || !isRecord(stamp.outputs)) {
      throw unreadable(path, `invalid stamp "${key}"`);
    }
  }
  return value as unknown as WorkItemLock;
}

function readLockAt(path: string): WorkItemLock {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { schemaVersion: 1, steps: {} };
    throw unreadable(path, errorMessage(error));
  }
  return parseLock(raw, path);
}

/** The whole lock of a work item, for read models and `inspect`. Throws on an
 *  unreadable file: the caller decides whether that is fatal. */
export function readLock(workItemDir: string): WorkItemLock {
  return readLockAt(workItemLayout(workItemDir).lockPath);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((key) => set.has(key));
}

/** Whether a step's stamp still vouches for its outputs, against its inputs read
 *  now. With `artifactsOnly`, sources are neither read nor compared. */
export async function stepFreshness(
  ctx: PipelineContext,
  step: StepIo,
  key: string,
  opts: { artifactsOnly?: true } = {},
): Promise<Freshness> {
  const lock = readLock(workItemDirOf(ctx));
  const declared = (step.sources ?? []).filter((input) => !(opts.artifactsOnly && isSource(input)));
  const { fingerprints: inputs, unavailable } = await readInputs(ctx, declared);
  const answer = (value: Freshness["value"]): Freshness => ({ value, inputs, unavailable });
  const stamp = lock.steps[key];
  if (!stamp) return answer("none");

  const recordedInputs = Object.keys(stamp.inputs).filter(
    (name) => !(opts.artifactsOnly && name.startsWith(SOURCE_KEY_PREFIX)),
  );
  const outputs = step.outputs ?? [];
  if (!sameKeys(recordedInputs, Object.keys(inputs))) return answer("stale");
  if (
    !sameKeys(
      Object.keys(stamp.outputs),
      outputs.map((output) => artifactKey(output.name)),
    )
  ) {
    return answer("stale");
  }
  for (const input of declared.filter(isSource)) {
    const name = inputKey(input);
    if (inputs[name] === null || stamp.inputs[name] === null) return answer("stale");
  }
  // A source enters as an artifact does: its nulls were settled above.
  for (const input of declared) {
    const name = inputKey(input);
    if (inputs[name] !== stamp.inputs[name]) return answer("stale");
  }
  for (const output of outputs) {
    const raw = await ctx.artifacts.readText(ref(ctx, output.name));
    if (raw === undefined || sha256Text(raw) !== stamp.outputs[artifactKey(output.name)]) return answer("stale");
  }
  return answer("fresh");
}

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One write: lock, read, apply, rename, release. Synchronous end to end. */
function updateLock(ctx: PipelineContext, apply: (lock: WorkItemLock) => boolean): void {
  const path = workItemLayout(workItemDirOf(ctx)).lockPath;
  mkdirSync(dirname(path), { recursive: true });
  const lockFile = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!acquireLock(lockFile, { pid: process.pid }).ok) {
    if (Date.now() >= deadline) throw new Error(`freshness lock ${path}: held by another process for 10s`);
    waitMs(LOCK_RETRY_MS);
  }
  try {
    const lock = readLockAt(path);
    if (apply(lock)) writeFileAtomic(path, `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    releaseLock(lockFile);
  }
}

/** Forget a step's stamp, before the first spawn of its pass. */
export function clearStamp(ctx: PipelineContext, key: string): void {
  updateLock(ctx, (lock) => {
    if (!(key in lock.steps)) return false;
    delete lock.steps[key];
    return true;
  });
}

/** Record what a pass settled `done` vouches for, and move the recorded sources of
 *  the consumers that ignore it, in one write. A consumer's source moves only when
 *  it still records what the pass started from. */
export function commitPass(
  ctx: PipelineContext,
  key: string,
  stamp: StepStamp | undefined,
  advances: readonly IgnoredAdvance[],
): void {
  updateLock(ctx, (lock) => {
    let changed = false;
    if (stamp) {
      lock.steps[key] = stamp;
      changed = true;
    }
    for (const advance of advances) {
      const inputs = lock.steps[advance.key]?.inputs;
      if (!inputs || advance.before === null || advance.after === null) continue;
      if (inputs[advance.source] !== advance.before) continue;
      inputs[advance.source] = advance.after;
      changed = true;
    }
    return changed;
  });
}
