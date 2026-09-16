// runner/state/decisions.ts
//
// Human decisions. The runner is the only writer: `--approve <subject>`
// validates the artifact, hashes it, and writes the decision atomically.
//
// Subjects are free-form: the pipeline declares each approval subject and its
// artifact (`.approval(subject, artifact)`). This module knows no subject names;
// artifact shape is validated by its own parser, not copied rules.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../lib/errors.js";
import type { Artifact } from "../model/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import { sha256Text } from "./hash.js";

/** Approval subject. It is free-form but becomes a filename under `decisions/`,
 * so charset validation is a security guard, not a style convention. */
export type DecisionSubject = string;
export type DecisionValue = "approved" | "rejected" | "applied";

export interface ApprovalDecision {
  schemaVersion: 1;
  decision: DecisionValue;
  subject: DecisionSubject;
  artifact: string;
  artifactSha256: string;
  decidedAt: string;
  /** Who decided. `"human"` when nothing else is known; a named actor when the
   *  caller announced one through `LANCENUIT_ACTOR` (the dashboard does, so an
   *  approval carries the person who clicked). Never empty. */
  decidedBy: string;
}

const SUBJECT_CHARSET = /^[\w-]+$/;

/** An actor name reaches a decision file and every reader of it, so it is bounded
 *  and kept to letters, digits, spaces, dots, and dashes. */
const ACTOR_CHARSET = /^[\w .-]{1,64}$/;

/** Author to record for a decision. `LANCENUIT_ACTOR` names the person on whose
 *  behalf the runner was invoked; anything outside the charset is ignored rather
 *  than written, so a malformed value degrades to the anonymous `"human"`. */
export function decisionActor(env: Record<string, string | undefined> = process.env): string {
  const actor = env.LANCENUIT_ACTOR?.trim();
  return actor && ACTOR_CHARSET.test(actor) ? actor : "human";
}

/** Decision `artifact` field: a safe artifact name, including nested names. */
function isDecisionArtifactRef(value: string): boolean {
  if (!value.startsWith("artifacts/")) return false;
  const name = value.slice("artifacts/".length);
  const segments = name.split(/[\\/]/);
  return (
    segments.length > 0 && segments.every((segment) => /^[\w.-]+$/.test(segment) && segment !== "." && segment !== "..")
  );
}

/** An approval subject must never escape `decisions/`. */
export function isValidSubjectToken(value: string): value is DecisionSubject {
  return SUBJECT_CHARSET.test(value);
}

export function decisionPath(ctx: PipelineContext, subject: DecisionSubject): string {
  if (!ctx.paths.decisionsDir) throw new Error(`decision "${subject}" requested without a ticket`);
  if (!isValidSubjectToken(subject)) throw new Error(`invalid decision subject "${subject}" (charset [\\w-])`);
  return join(ctx.paths.decisionsDir, `${subject}.json`);
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`artifact "${name}" requested without a ticket`);
  return createArtifactRef(ctx.ticket, name);
}

async function validateArtifact(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<{ path: string; body: string }> {
  const path = ctx.paths.artifact(artifact.name);
  const body = await ctx.artifacts.readText(ref(ctx, artifact.name));
  if (body === undefined) throw new Error(`artifact ${path} not found — cannot approve ${subject}`);
  if (body.length === 0) throw new Error(`artifact ${path} is empty — cannot approve ${subject}`);
  try {
    // Delegate to the descriptor parser: approving an artifact it rejects would
    // approve a file that the next step cannot process.
    artifact.validate(body);
  } catch (error) {
    throw new Error(`artifact ${path} is invalid: ${errorMessage(error)}`, { cause: error });
  }
  return { path, body };
}

function atomicWrite(path: string, value: ApprovalDecision): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export async function recordApproval(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<ApprovalDecision> {
  const validated = await validateArtifact(ctx, subject, artifact);
  const decision: ApprovalDecision = {
    schemaVersion: 1,
    decision: "approved",
    subject,
    artifact: `artifacts/${artifact.name}`,
    artifactSha256: sha256Text(validated.body),
    decidedAt: new Date().toISOString(),
    decidedBy: decisionActor(),
  };
  atomicWrite(decisionPath(ctx, subject), decision);
  return decision;
}

/**
 * Read a decision file by path and validate its shape only. Gates such as
 * `reuseState` do not have the artifact descriptor, so they cannot verify that
 * `artifact` matches `subject`; `decisionMatchesArtifact` and
 * `markDecisionApplied` perform that identity check when given the artifact.
 */
export function readDecisionAt(path: string): ApprovalDecision | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value !== "object") return undefined;
    const decision = value as Partial<ApprovalDecision>;
    if (decision.schemaVersion !== 1) return undefined;
    if (typeof decision.subject !== "string" || !isValidSubjectToken(decision.subject)) return undefined;
    if (decision.decision !== "approved" && decision.decision !== "rejected" && decision.decision !== "applied")
      return undefined;
    if (typeof decision.artifact !== "string" || !isDecisionArtifactRef(decision.artifact)) return undefined;
    if (typeof decision.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(decision.artifactSha256))
      return undefined;
    if (typeof decision.decidedAt !== "string" || !Number.isFinite(Date.parse(decision.decidedAt))) return undefined;
    // Any non-empty author is accepted: a decision signed by a named person is a
    // human decision too, and rejecting it here would leave the gate closed on an
    // approval that was actually granted.
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) return undefined;
    return decision as ApprovalDecision;
  } catch {
    // An absent or malformed decision is treated as no approval by design.
    return undefined;
  }
}

export function readDecision(ctx: PipelineContext, subject: DecisionSubject): ApprovalDecision | undefined {
  const decision = readDecisionAt(decisionPath(ctx, subject));
  return decision?.subject === subject ? decision : undefined;
}

/** A decision is valid only when it names the expected artifact, which still exists
 * and has the approved hash; modifying the artifact invalidates approval. */
export async function decisionMatchesArtifact(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<boolean> {
  const decision = readDecision(ctx, subject);
  if (!decision || (decision.decision !== "approved" && decision.decision !== "applied")) return false;
  if (decision.artifact !== `artifacts/${artifact.name}`) return false;
  try {
    const body = await ctx.artifacts.readText(ref(ctx, artifact.name));
    return body !== undefined && sha256Text(body) === decision.artifactSha256;
  } catch {
    // Artifact lookup failures conservatively invalidate reuse without masking the caller's decision flow.
    return false;
  }
}

export async function markDecisionApplied(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<ApprovalDecision> {
  const existing = readDecision(ctx, subject);
  if (!existing || !(await decisionMatchesArtifact(ctx, subject, artifact))) {
    throw new Error(`decision ${subject} missing or artifact modified`);
  }
  const applied: ApprovalDecision = { ...existing, decision: "applied", decidedAt: new Date().toISOString() };
  atomicWrite(decisionPath(ctx, subject), applied);
  return applied;
}
