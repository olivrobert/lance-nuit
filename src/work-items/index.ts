// What other contexts may import from this one: re-exports only, every name with a caller outside.
// `module-<context>-entry-only` in `.dependency-cruiser.cjs` holds the rule.
export type { Artifact, ArtifactParser } from "./artifact.js";
export type { Source, StepInput } from "./source.js";
export { isSource, sourceDeclarationError } from "./source.js";
export {
  FileWorkItemArtifactStore,
  MAX_REJECTION_REASON,
  artifactKey,
  clearStamp,
  commitPass,
  decisionActor,
  decisionMatchesArtifact,
  gateDecisionStatus,
  isReservedArtifactName,
  isValidSubjectToken,
  pendingRejection,
  readDecision,
  readDecisionIn,
  readInputs,
  readLock,
  readSource,
  recordApproval,
  recordRejection,
  rejectionStatus,
  sourceKey,
  stampKey,
  stepFreshness,
  workItemLayout,
} from "./store/index.js";
export type {
  ApprovalDecision,
  Fingerprint,
  Freshness,
  IgnoredAdvance,
  RecordedApproval,
  StepStamp,
  UnavailableSource,
} from "./store/index.js";
