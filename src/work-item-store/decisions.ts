// runner/work-item-store/decisions.ts
//
// Human decisions. The runner is the only writer: `--approve <subject>` and
// `--reject <subject>` validate the artifact, hash it, and write the decision
// atomically. One file per subject holds the current answer, so an approval
// replaces a rejection and the reverse.
//
// Subjects are free-form: the pipeline declares each approval subject and its
// artifact (`.approval(subject, artifact)`). This module knows no subject names;
// artifact shape is validated by its own parser, not copied rules.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "../lib/errors.js";
import type { Artifact } from "../model/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import { sha256Text } from "./hash.js";
import { type DecisionSubject, isValidSubjectToken, workItemLayout } from "./layout.js";

export type { DecisionSubject };
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
  /** Why the human rejected the artifact. Present on every `rejected` decision:
   *  the rework step's prompt reads it through `pendingRejection`. */
  reason?: string;
  /** Rework round this rejection opened, from 1. It grows only when a new
   *  version of the artifact is rejected, and bounds the reject/rework loop
   *  across runs: the decision file outlives any run snapshot. */
  round?: number;
}

/** Longest rejection reason accepted. It reaches a prompt and every reader of
 *  the decision file, so the CLI and the dashboard refuse anything longer. */
export const MAX_REJECTION_REASON = 2000;

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

function workItemDirOf(ctx: PipelineContext, subject: DecisionSubject): string {
  if (!ctx.paths.workItemDir) throw new Error(`decision "${subject}" requested without a ticket`);
  return ctx.paths.workItemDir;
}

function decisionPath(ctx: PipelineContext, subject: DecisionSubject): string {
  return workItemLayout(workItemDirOf(ctx, subject)).decisionPath(subject);
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`artifact "${name}" requested without a ticket`);
  return createArtifactRef(ctx.ticket, name);
}

async function validateArtifact(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
  verb: "approve" | "reject" = "approve",
): Promise<{ path: string; body: string }> {
  const path = ctx.paths.artifact(artifact.name);
  const body = await ctx.artifacts.readText(ref(ctx, artifact.name));
  if (body === undefined) throw new Error(`artifact ${path} not found — cannot ${verb} ${subject}`);
  if (body.length === 0) throw new Error(`artifact ${path} is empty — cannot ${verb} ${subject}`);
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

/** Outcome of `recordApproval`. `written` is false when a decision already covered
 *  this exact artifact: it was kept as is, its author and date included. */
export interface RecordedApproval {
  decision: ApprovalDecision;
  written: boolean;
}

export async function recordApproval(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<RecordedApproval> {
  const validated = await validateArtifact(ctx, subject, artifact);
  // The same approval reaches the runner from several hands — the dashboard, an
  // agent, a terminal — often for the same gate. Rewriting it would replace the
  // person who decided with whoever repeated it, and turn an `applied` decision
  // back into a pending one.
  const existing = readDecision(ctx, subject);
  if (existing?.artifact === `artifacts/${artifact.name}` && approvalFreshness(existing, validated.body) === "fresh") {
    return { decision: existing, written: false };
  }
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
  return { decision, written: true };
}

/**
 * Record that a human rejected the artifact behind `subject`, with the reason the
 * rework step will read. Repeating the same rejection of the same bytes writes
 * nothing; a new reason for those bytes replaces the old one in the same round;
 * rejecting reworked bytes opens the next round, refused past `maxRounds`.
 */
export async function recordRejection(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
  reason: string,
  maxRounds: number,
): Promise<RecordedApproval> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error(`Rejection of "${subject}" needs a reason (--reason <text>).`);
  if (trimmed.length > MAX_REJECTION_REASON) {
    throw new Error(`Rejection reason for "${subject}" must be at most ${MAX_REJECTION_REASON} characters.`);
  }
  const validated = await validateArtifact(ctx, subject, artifact, "reject");
  const sha = sha256Text(validated.body);
  const existing = readDecision(ctx, subject);
  const previous =
    existing?.decision === "rejected" && existing.artifact === `artifacts/${artifact.name}` ? existing : undefined;
  const sameBytes = previous?.artifactSha256 === sha;
  if (sameBytes && previous.reason === trimmed) return { decision: previous, written: false };
  const round = previous ? (previous.round ?? 1) + (sameBytes ? 0 : 1) : 1;
  if (round > maxRounds) {
    throw new Error(
      `Rejection of "${subject}" refused: ${round - 1} rework round(s) already rejected (maxRounds ${maxRounds}). ` +
        `Approve the artifact (--approve ${subject}) or answer on the ticket instead.`,
    );
  }
  const decision: ApprovalDecision = {
    schemaVersion: 1,
    decision: "rejected",
    subject,
    artifact: `artifacts/${artifact.name}`,
    artifactSha256: sha,
    decidedAt: new Date().toISOString(),
    decidedBy: decisionActor(),
    reason: trimmed,
    round,
  };
  atomicWrite(decisionPath(ctx, subject), decision);
  return { decision, written: true };
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
    // A rejection without its reason would replay the rework step with nothing to
    // act on, so it is no decision at all.
    if (
      decision.decision === "rejected" &&
      (typeof decision.reason !== "string" ||
        decision.reason.length === 0 ||
        typeof decision.round !== "number" ||
        !Number.isInteger(decision.round) ||
        decision.round < 1)
    )
      return undefined;
    return decision as ApprovalDecision;
  } catch {
    // An absent or malformed decision is treated as no approval by design.
    return undefined;
  }
}

/** The current decision on `subject` in a work item, or undefined when there is
 *  none, it is malformed, or it was written for another subject: a decision file
 *  copied or renamed under `decisions/` decides nothing. */
export function readDecisionIn(workItemDir: string, subject: DecisionSubject): ApprovalDecision | undefined {
  const decision = readDecisionAt(workItemLayout(workItemDir).decisionPath(subject));
  return decision?.subject === subject ? decision : undefined;
}

export function readDecision(ctx: PipelineContext, subject: DecisionSubject): ApprovalDecision | undefined {
  return readDecisionIn(workItemDirOf(ctx, subject), subject);
}

/** Whether an approval still holds over the artifact as it stands now.
 *
 *  `absent`: nobody approved. `fresh`: the approval covers this exact content.
 *  `stale`: the artifact changed since, or can no longer be read, so the gate
 *  reopens. */
export type ApprovalFreshness = "absent" | "fresh" | "stale";

export function approvalFreshness(decision: ApprovalDecision | undefined, body: string | undefined): ApprovalFreshness {
  if (!decision || (decision.decision !== "approved" && decision.decision !== "applied")) return "absent";
  return body !== undefined && sha256Text(body) === decision.artifactSha256 ? "fresh" : "stale";
}

/** Whether a rejection still waits for its rework. An absent artifact counts as
 *  pending: the step attempt erases its declared outputs before spawning, so a
 *  rework interrupted or failed midway leaves nothing, and treating that as done
 *  would let the gate skip the rework on resume. */
export function rejectionPending(decision: ApprovalDecision | undefined, body: string | undefined): boolean {
  if (decision?.decision !== "rejected") return false;
  return body === undefined || sha256Text(body) === decision.artifactSha256;
}

/** Where the decision on a gate's subject stands against its artifact now.
 *
 *  `absent`: no decision holds. `fresh`: an approval covers these exact bytes.
 *  `stale`: the artifact changed since the approval, or cannot be read. `rejected`:
 *  the rework has not answered the rejection yet. `reworked`: it has, and the gate
 *  waits for a new human decision. */
export type GateDecisionState = "absent" | "fresh" | "stale" | "rejected" | "reworked";

export type GateDecisionStatus =
  | { state: "absent" }
  | { state: "fresh" | "stale" | "reworked"; decision: ApprovalDecision }
  /** `artifact` tells a rework that wrote nothing from one that left the bytes as rejected. */
  | { state: "rejected"; decision: ApprovalDecision; artifact: "absent" | "unchanged" };

/** Reads an artifact of the work item by its name under `artifacts/`; undefined when it does not exist. */
export type ArtifactReader = (name: string) => Promise<string | undefined>;

/**
 * The one reading of a gate's decision. The runner's gate and admission (through
 * `rejectionStatus` and `decisionMatchesArtifact`), `--inspect` and the dashboard
 * all answer through it, so none can show a decision another would judge
 * differently. It takes a work-item directory and a reader rather than a context:
 * the dashboard has neither a run nor a context, only the files.
 */
export async function gateDecisionStatus(
  workItemDir: string,
  subject: DecisionSubject,
  readArtifact: ArtifactReader,
): Promise<GateDecisionStatus> {
  const decision = readDecisionIn(workItemDir, subject);
  if (!decision) return { state: "absent" };
  const body = await decisionArtifactBody(decision, readArtifact);
  if (decision.decision === "rejected") {
    if (!rejectionPending(decision, body)) return { state: "reworked", decision };
    return { state: "rejected", decision, artifact: body === undefined ? "absent" : "unchanged" };
  }
  return { state: approvalFreshness(decision, body) === "fresh" ? "fresh" : "stale", decision };
}

/** Artifact a decision names, or undefined when it is missing or unreadable. */
async function decisionArtifactBody(
  decision: ApprovalDecision,
  readArtifact: ArtifactReader,
): Promise<string | undefined> {
  try {
    return await readArtifact(decision.artifact.slice("artifacts/".length));
  } catch {
    // An artifact that cannot be read can no longer prove an approval fresh, and
    // counts as absent for a rejection: both are the conservative answer.
    return undefined;
  }
}

function artifactReaderOf(ctx: PipelineContext): ArtifactReader {
  return (name) => ctx.artifacts.readText(ref(ctx, name));
}

/** Where a rejection of `subject` stands against the artifact as it is now:
 *  `absent` and `unchanged` still wait for the rework, `reworked` waits for a
 *  new human decision. Undefined when the current decision is no rejection. */
export async function rejectionStatus(
  ctx: PipelineContext,
  subject: DecisionSubject,
): Promise<{ decision: ApprovalDecision; artifact: "absent" | "unchanged" | "reworked" } | undefined> {
  if (!ctx.paths.workItemDir) return undefined;
  const status = await gateDecisionStatus(ctx.paths.workItemDir, subject, artifactReaderOf(ctx));
  if (status.state === "rejected") return { decision: status.decision, artifact: status.artifact };
  if (status.state === "reworked") return { decision: status.decision, artifact: "reworked" };
  return undefined;
}

/** Pending rejection of `subject`, for the prompt of the step that reworks it.
 *  Undefined once the artifact was rewritten, or when nobody rejected it. */
export async function pendingRejection(
  ctx: PipelineContext,
  subject: DecisionSubject,
): Promise<{ reason: string; round: number; decidedBy: string; decidedAt: string } | undefined> {
  const status = await rejectionStatus(ctx, subject);
  if (!status || status.artifact === "reworked") return undefined;
  const { reason, round, decidedBy, decidedAt } = status.decision;
  // readDecisionAt refuses a rejection without reason or round.
  return { reason: reason!, round: round!, decidedBy, decidedAt };
}

/** A decision is valid only when it names the expected artifact, which still exists
 * and has the approved hash; modifying the artifact invalidates approval. */
export async function decisionMatchesArtifact(
  ctx: PipelineContext,
  subject: DecisionSubject,
  artifact: Artifact<unknown>,
): Promise<boolean> {
  const status = await gateDecisionStatus(workItemDirOf(ctx, subject), subject, artifactReaderOf(ctx));
  return status.state === "fresh" && status.decision.artifact === `artifacts/${artifact.name}`;
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
