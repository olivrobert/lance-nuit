// Approval-only and rejection-only write a decision without starting a run,
// worktree, or lock. Plain --approve and --reject are handled by
// entry/startup.ts so the decision is recorded in the run journal that will
// actually be started. Rejection-only is also how a composed child's gate is
// rejected: the child pipeline names the subject, the parent run is resumed.
//
// The `subject → artifact` mapping exists only in the pipeline declaration
// (`.approval()`), so these paths must load the pipeline to identify the file to
// hash. A broken pipeline consequently blocks the decision and must report the cause.

import { isPipelineName, resolveBuiltinPipeline } from "../env/builtin-pipeline.js";
import type { Pipeline } from "../model/definition.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { log } from "../runtime/logging.js";
import type { PipelineContext } from "../model/context.js";
import { recordApproval } from "../state/decisions.js";
import {
  describeRecordedApproval,
  describeRecordedRejection,
  rejectSubject,
  resolveApprovableArtifact,
} from "./approval-subject.js";
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

/** Context and definition of the pipeline that declares the subject, or the
 *  logged reason it could not be loaded. */
async function loadDecidingPipeline(
  ticket: string,
  pipelinePath: string,
  verb: "approval" | "rejection",
): Promise<{ context: PipelineContext; pipelineDef: Pipeline } | undefined> {
  const context = buildPipelineContext({ cwd: process.cwd(), ticket, ...commandRegistries() });
  try {
    return {
      context,
      pipelineDef: await loadPipelineDefinition(resolvePipelinePath(pipelinePath, context.cwd), context),
    };
  } catch (error) {
    // The decision failed because the pipeline declaring the subject is broken,
    // not because the artifact itself is invalid.
    log(`Unable to load pipeline "${pipelinePath}" — ${verb} denied: ${errorMessage(error)}`);
    return undefined;
  }
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
    const loaded = await loadDecidingPipeline(args.ticket, args.pipelinePath, "approval");
    if (!loaded) return 1;
    const { context, pipelineDef } = loaded;
    try {
      const artifact = await resolveApprovableArtifact(pipelineDef, args.approve, context);
      log(describeRecordedApproval(await recordApproval(context, args.approve, artifact), context.paths.decisionsDir));
      return 0;
    } catch (error) {
      log(errorMessage(error));
      return 1;
    }
  },
};

export const rejectionCommand: RunnerCommand = {
  id: "reject-only",
  flag: "--reject-only",
  key: "rejectOnly",
  desc: "Write a rejection with its reason and exit without running a pipeline.",
  async run(args): Promise<number> {
    if (!isValidTicket(args.ticket)) {
      log("--reject-only requires a valid ticket.");
      return 1;
    }
    if (!args.reject) {
      log("--reject-only requires --reject <subject>.");
      return 1;
    }
    if (!args.reason?.trim()) {
      log("--reject-only requires --reason <text>: the rework step reads it.");
      return 1;
    }
    if (!args.pipelinePath) {
      log("--reject-only requires --pipeline <name>: the rejected subject is declared by the pipeline.");
      return 1;
    }
    const loaded = await loadDecidingPipeline(args.ticket, args.pipelinePath, "rejection");
    if (!loaded) return 1;
    const { context, pipelineDef } = loaded;
    try {
      const recorded = await rejectSubject(pipelineDef, args.reject, args.reason, context);
      log(describeRecordedRejection(recorded, context.paths.decisionsDir));
      return 0;
    } catch (error) {
      log(errorMessage(error));
      return 1;
    }
  },
};
