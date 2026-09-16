// Resolve an approval subject against the pipeline declaration.
//
// Shared by both `--approve` paths: `commands/approval.ts` loads the pipeline only
// for approval, while `runner.ts` has already loaded it. There is no hard-coded
// subject list; an unknown subject is simply undeclared by the target pipeline.

import type { Artifact } from "../dsl/artifact.js";
import type { Pipeline } from "../model/definition.js";
import { isValidSubjectToken } from "../state/decisions.js";

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
