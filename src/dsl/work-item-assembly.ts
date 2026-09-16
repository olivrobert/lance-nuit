import type { PipelineWorkItemSource } from "../model/definition.js";
import type { Artifact } from "./artifact.js";

type AssemblyTarget = object;

/** Approval subject carried by a step and surfaced on the pipeline during assembly. */
export interface StepApprovalDeclaration {
  subject: string;
  artifact: Artifact<unknown>;
}

const declaredSources = new WeakMap<AssemblyTarget, PipelineWorkItemSource>();
const boundSources = new WeakMap<AssemblyTarget, PipelineWorkItemSource>();
const declaredApprovals = new WeakMap<AssemblyTarget, StepApprovalDeclaration>();
const boundPipelineNames = new WeakMap<AssemblyTarget, string>();

/** Transient metadata used only during DSL assembly. */
export function declareWorkItemSource(target: AssemblyTarget, source: PipelineWorkItemSource): void {
  declaredSources.set(target, source);
}

export function workItemSourceDeclaration(target: AssemblyTarget): PipelineWorkItemSource | undefined {
  return declaredSources.get(target);
}

export function bindPipelineWorkItemSource(target: AssemblyTarget, source: PipelineWorkItemSource | undefined): void {
  if (source) boundSources.set(target, source);
  else boundSources.delete(target);
}

export function inferredPipelineWorkItemSource(target: AssemblyTarget): PipelineWorkItemSource | undefined {
  return boundSources.get(target);
}

/** Bind the public pipeline name to a step while the DSL is assembled. */
export function bindPipelineName(target: AssemblyTarget, name: string): void {
  boundPipelineNames.set(target, name);
}

/** Read the pipeline name bound during DSL assembly. */
export function inferredPipelineName(target: AssemblyTarget): string | undefined {
  return boundPipelineNames.get(target);
}

/**
 * A human-review gate declares the subject it unlocks ITSELF: the
 * `subject → artifact` mapping needed by the CLI for `--approve` is derived from
 * the gate that reads it instead of being copied manually into the pipeline.
 */
export function declareApproval(target: AssemblyTarget, declaration: StepApprovalDeclaration): void {
  declaredApprovals.set(target, declaration);
}

export function approvalDeclaration(target: AssemblyTarget): StepApprovalDeclaration | undefined {
  return declaredApprovals.get(target);
}
