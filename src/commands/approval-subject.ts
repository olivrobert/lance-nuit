// Resolve an approval subject against the pipeline declaration.
//
// Shared by both `--approve` paths: `commands/approval.ts` loads the pipeline only
// for approval, while `runner.ts` has already loaded it. There is no hard-coded
// subject list; an unknown subject is simply undeclared by the target pipeline.
// A subject guarded by a per-verdict human review is also refused when the
// current verdict does not offer it, with the same check on both paths.

import type { Artifact } from "../dsl/artifact.js";
import type { PipelineContext } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import { isValidSubjectToken, type RecordedApproval } from "../state/decisions.js";

/**
 * Return the artifact bound to `subject`, or throw with the subjects actually
 * declared by the pipeline so a mistaken pipeline can be corrected.
 */
export function resolveApprovalArtifact(pipelineDef: Pipeline, subject: string): Artifact<unknown> {
  // Validate again because this value comes from the CLI and becomes a filename
  // under `decisions/`. A missing Map key is not enough: filename validation must
  // not depend on the lookup shape.
  if (!isValidSubjectToken(subject)) {
    throw new Error(`Invalid approval subject "${subject}" (only [\\w-] characters are allowed).`);
  }
  const artifact = pipelineDef.approvals?.get(subject);
  if (!artifact) {
    const declared = [...(pipelineDef.approvals?.keys() ?? [])];
    throw new Error(
      `Approval subject "${subject}" is not declared by pipeline "${pipelineDef.name}"` +
        (declared.length > 0 ? ` (declared: ${declared.join(", ")}).` : " (no subjects declared)."),
    );
  }
  return artifact;
}

/**
 * `resolveApprovalArtifact`, then refuse a subject the current artifact does not
 * offer. Throws before any decision is recorded.
 */
export async function resolveApprovableArtifact(
  pipelineDef: Pipeline,
  subject: string,
  ctx: PipelineContext,
): Promise<Artifact<unknown>> {
  const artifact = resolveApprovalArtifact(pipelineDef, subject);
  const refusal = await pipelineDef.approvalGuards?.get(subject)?.(ctx);
  if (refusal) throw new Error(refusal);
  return artifact;
}

/** What both `--approve` paths print once the decision is settled. A kept decision
 *  names who approved and when, so whoever repeated the approval sees it was
 *  already granted rather than a second write. */
export function describeRecordedApproval({ decision, written }: RecordedApproval, decisionsDir?: string): string {
  if (!written) {
    return `Decision ${decision.subject} already ${decision.decision} by ${decision.decidedBy} on ${decision.decidedAt} for this artifact — kept.`;
  }
  return `Decision ${decision.subject}=approved written to ${decisionsDir}/${decision.subject}.json (SHA-256 ${decision.artifactSha256}).`;
}
