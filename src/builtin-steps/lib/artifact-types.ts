import type { PipelineLot } from "../../model/context.js";

/** Triage verdict (bugfix + feature) written by the triage step. */
export interface TriageArtifact {
  verdict?: "proceed" | "escalate";
  complexity?: "trivial" | "standard";
  size?: "xs" | "small" | "standard";
  anchors?: string[];
  risk?: "low" | "normal";
  reason?: string;
  slug?: string;
  missing?: string[];
  surface?: string;
  homogeneous?: boolean;
  sensitive?: boolean;
  ambiguity?: string;
}

/** Red-test result (bugfix, standard path). */
export interface RedtestArtifact {
  ok?: boolean;
  blocked?: boolean;
  reason?: string;
  testFile?: string;
}

/** Reuse-audit verdict (feature, reuse.json). */
export interface ReuseArtifact {
  duplication?: boolean;
  violations?: unknown[];
}

/** Execution lot from the single plan. */
export interface LotArtifact extends PipelineLot {}

/** Lot manifest from a single plan. */
export interface LotsArtifact {
  lots: LotArtifact[];
  reason?: string;
}

/** Plan-audit severities, in descending severity order. Only the first two make
 *  a decision. */
export const PLAN_AUDIT_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type PlanAuditSeverity = (typeof PLAN_AUDIT_SEVERITIES)[number];

export interface PlanAuditLotFinding {
  severity: PlanAuditSeverity;
  lot?: string;
  category?: string;
  summary: string;
}

/** Plan-audit verdict (feature, plan-audit.json). */
export interface PlanAuditArtifact {
  audited: boolean;
  planFixes?: number;
  lotFindings: PlanAuditLotFinding[];
}

/** A decision the ticket does not settle and the spec had to assume. */
export interface BlockingAssumption {
  subject?: string;
  assumed?: string;
  ac?: string;
}

/** Blocking assumptions found by `pipeline-spec --autonomous`. */
export interface AssumptionsArtifact {
  blocking: BlockingAssumption[];
  resolved?: ResolvedAssumption[];
}

/** A ticket ambiguity answered by existing code. */
export interface ResolvedAssumption {
  subject?: string;
  answer?: string;
  evidence?: string;
}

/** A document referenced by the ticket that triage could not read. */
export interface RequiredInput {
  path: string;
  why: string;
}

/** Human inputs for a work item (`inputs.json`). */
export interface InputsArtifact {
  required: RequiredInput[];
  seen: string[];
}
