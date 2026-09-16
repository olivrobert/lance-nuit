// Approval-only writes a decision without starting a run, worktree, or lock.
// Plain --approve is handled by runner.ts so the decision is recorded in the run
// journal that will actually be started.
//
// The `subject → artifact` mapping exists only in the pipeline declaration
// (`.approval()`), so this path must load the pipeline to identify the file to
// hash. A broken pipeline consequently blocks approval and must report the cause.

import { isPipelineName, resolveBuiltinPipeline } from "../env/builtin-pipeline.js";
import type { Pipeline } from "../model/definition.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { log } from "../runtime/logging.js";
import { recordApproval } from "../state/decisions.js";
import { resolveApprovalArtifact } from "./approval-subject.js";
import type { RunnerCommand } from "./runner-command.js";
import { pipelineNotFoundError } from "./pipeline-reference.js";
import { commandRegistries } from "./registries.js";
import { errorMessage, isValidTicket } from "./shared.js";

/** Resolve a kit-chain name; pass an explicit path through unchanged. */
function resolvePipelinePath(reference: string, cwd: string): string {
  if (!isPipelineName(reference)) return reference;
  const found = resolveBuiltinPipeline(reference, cwd);
  if (found) return found;
  throw pipelineNotFoundError(reference, cwd);
}

export const approvalCommand: RunnerCommand = {
  id: "approve-only",
  flag: "--approve-only",
  key: "approveOnly",
  desc: "Write a decision and exit without running a pipeline.",
  async run(args): Promise<number> {
    if (!isValidTicket(args.ticket)) {
      log("--approve-only requires a valid ticket.");
      return 1;
    }
    if (!args.approve) {
      log("--approve-only requires --approve <subject>.");
      return 1;
    }
    if (!args.pipelinePath) {
      log("--approve-only requires --pipeline <name>: the approval subject is declared by the pipeline.");
      return 1;
    }
    const context = buildPipelineContext({ cwd: process.cwd(), ticket: args.ticket, ...commandRegistries() });
    let pipelineDef: Pipeline;
    try {
      pipelineDef = await loadPipelineDefinition(resolvePipelinePath(args.pipelinePath, context.cwd), context);
    } catch (error) {
      // Approval failed because the pipeline declaring the subject is broken, not
      // because the artifact itself is invalid.
      log(`Unable to load pipeline "${args.pipelinePath}" — approval denied: ${errorMessage(error)}`);
      return 1;
    }
    try {
      const artifact = resolveApprovalArtifact(pipelineDef, args.approve);
      const decision = await recordApproval(context, args.approve, artifact);
      log(
        `Decision ${decision.subject}=approved written to ${context.paths.decisionsDir}/${decision.subject}.json (SHA-256 ${decision.artifactSha256}).`,
      );
      return 0;
    } catch (error) {
      log(errorMessage(error));
      return 1;
    }
  },
};
