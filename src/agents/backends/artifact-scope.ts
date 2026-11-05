import { isAbsolute, relative } from "node:path";
import type { ArtifactScope } from "../../contracts/index.js";

/** Scope directories an agent must be granted beyond its cwd. In a worktree the work
 *  item lives in the main clone, outside the workspace a sandbox or a permission mode
 *  confines the agent to: without the grant it can neither read the ticket nor write
 *  its artifacts there. */
export function artifactScopeDirsOutside(cwd: string, scope: ArtifactScope | undefined): string[] {
  if (!scope) return [];
  const root = scope.workItemDir ?? scope.artifactsDir;
  const rel = relative(cwd, root);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return inside ? [] : [root];
}

/** Render the runner-owned artifact boundary for any agent backend. */
export function artifactScopeInstruction(scope: ArtifactScope): string {
  const lines = [
    "ARTIFACT SCOPE IMPOSED BY THE RUNNER — it takes precedence over any path resolution described by a skill.",
    `- Artifacts for this work item: ${scope.artifactsDir} (exact absolute path).`,
  ];
  if (scope.workItemDir && scope.workItemDir !== scope.artifactsDir)
    lines.push(`- Work item: ${scope.workItemDir}. Sub-US items write to ${scope.workItemDir}/US-NN/artifacts/.`);
  lines.push(
    "- NEVER rederive these paths from $SPEC_PATH, the ticket identifier, cwd, or a skill convention: those fallbacks are for manual use without an imposed path, and using them here would write artifacts where the caller will not look.",
    "- If an imposed path is unusable, fail and say so. Do not write elsewhere.",
  );
  return lines.join("\n");
}
