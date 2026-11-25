//
// Runtime binding of the `Dsl` injected into project pipeline factories.

import { humanReview } from "../builtin-steps/lib/human-review.js";
import { createPromptFile } from "../builtin-steps/lib/project-prompt.js";
import { requireCapabilitiesStep } from "../builtin-steps/lib/skill-preflight.js";
import { workItemDeliveryStep, workItemEscalateStep } from "../builtin-steps/lib/work-item-steps.js";
import { reject } from "../dsl/preconditions.js";
import {
  artifact,
  createProjectActionStep,
  createProjectBashStep,
  createProjectLlmStep,
  type Dsl,
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  forEachPipeline,
  mechanicalFix,
  parallelize,
  pipeline as pipelineBuilder,
  requireArtifact,
  runPipeline,
  skip,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  source,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
  textArtifact,
  withBackend,
} from "../dsl.js";
import { RUN_REPORT_FILE } from "../run-report.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import { decisionMatchesArtifact, pendingRejection } from "../../work-items/index.js";

/**
 * Build the `Dsl` injected into a project factory.
 *
 * Load-dependent helpers are bound here, so two imported pipelines cannot share
 * contract context or prompt resolution roots.
 */
export function createProjectDsl(context: PipelineContext, pipelineDir: string): Dsl {
  const backendRegistry = requireAgentBackendRegistry(context);
  return {
    pipeline: pipelineBuilder,
    runPipeline,
    forEachPipeline,
    parallelize,
    llmStep: createProjectLlmStep(pipelineDir, backendRegistry),
    withBackend: (id, options) => withBackend(id, options, backendRegistry),
    bashStep: createProjectBashStep(backendRegistry),
    actionStep: createProjectActionStep(backendRegistry),
    workItemEscalateStep,
    humanReview,
    workItemDeliveryStep,
    requireCapabilitiesStep,
    promptFile: createPromptFile(pipelineDir),
    artifact,
    textArtifact,
    source,
    skip,
    fail,
    stop,
    skipIf,
    skipUnless,
    failIf,
    failUnless,
    failUnlessCommand,
    stopIf,
    stopUnless,
    stopUnlessCommand,
    requireArtifact,
    skipUnlessCommand,
    mechanicalFix,
    reject,
    decisionMatchesArtifact,
    pendingRejection,
    RUN_REPORT_FILE,
  };
}
