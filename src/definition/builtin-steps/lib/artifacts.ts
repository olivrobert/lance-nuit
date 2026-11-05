// runner/builtin-steps/lib/artifacts.ts
//
// Facade over the typed work-item artifacts. Implementations are split by
// concern; this module is the single import site for all of them.

export type { Artifact, ArtifactParser } from "../../dsl/artifact.js";
export { artifact, textArtifact } from "../../dsl/artifact.js";
export { artifactExists, read, readArtifactText, removeArtifact } from "./artifact-access.js";
export {
  assumptionsArtifact,
  inputsArtifact,
  lotsArtifact,
  planArtifact,
  planAuditArtifact,
  redtestArtifact,
  reuseArtifact,
  specArtifact,
  triageArtifact,
} from "./artifact-descriptors.js";
export {
  parseAssumptionsArtifact,
  parseInputsArtifact,
  parseRedtestArtifact,
  parseReuseArtifact,
  parseTriageArtifact,
} from "./artifact-parsers.js";
export { blocksLots, parseLotsArtifact, parsePlanAuditArtifact } from "./artifact-plan-parsers.js";
export {
  type AssumptionsArtifact,
  type BlockingAssumption,
  type InputsArtifact,
  type LotArtifact,
  type LotsArtifact,
  PLAN_AUDIT_SEVERITIES,
  type PlanAuditArtifact,
  type PlanAuditLotFinding,
  type PlanAuditSeverity,
  type RedtestArtifact,
  type RequiredInput,
  type ResolvedAssumption,
  type ReuseArtifact,
  type TriageArtifact,
} from "./artifact-types.js";
